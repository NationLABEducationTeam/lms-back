const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { getPool, SCHEMAS, TABLES } = require('../config/database');

// Get all students
router.get('/', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const result = await getPool('read').query(`
            SELECT * FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} 
            WHERE role = 'STUDENT'
        `);
        
        res.json({
            success: true,
            data: {
                students: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to fetch students',
            error: error.message 
        });
    }
});

// Get specific student
router.get('/:studentId', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        const result = await getPool('read').query(`
            SELECT * FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} 
            WHERE cognito_user_id = $1 AND role = 'STUDENT'
        `, [studentId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }
        
        res.json({
            success: true,
            data: {
                student: result.rows[0]
            }
        });
    } catch (error) {
        console.error('Error fetching student:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student',
            error: error.message
        });
    }
});

// Get student's courses
router.get('/:studentId/courses', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        const result = await getPool('read').query(`
            SELECT c.* 
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.ENROLLMENTS} e 
                ON c.id = e.course_id 
            WHERE e.student_id = $1
        `, [studentId]);
        
        res.json({
            success: true,
            data: {
                courses: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching student courses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student courses',
            error: error.message
        });
    }
});

// 학생의 과제 및 퀴즈 목록 조회 (대시보드용)
router.get('/:studentId/assignments', verifyToken, async (req, res) => {
    const client = await getPool('read').connect();
    try {
        const { studentId } = req.params;
        
        // 권한 확인 (본인 또는 관리자만 조회 가능)
        if (req.user.sub !== studentId && !['ADMIN'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: "조회 권한이 없습니다."
            });
        }
        
        // 학생이 수강 중인 모든 과목의 수강 정보 조회
        const enrollmentsQuery = `
            SELECT id, course_id
            FROM ${SCHEMAS.ENROLLMENT}.enrollments
            WHERE student_id = $1 AND status = 'ACTIVE'
        `;
        const enrollmentsResult = await client.query(enrollmentsQuery, [studentId]);
        
        if (enrollmentsResult.rows.length === 0) {
            return res.json({
                success: true,
                message: "수강 중인 과목이 없습니다.",
                data: {
                    assignments: {
                        pending: [],
                        overdue: [],
                        completed: [],
                        total: 0
                    },
                    exams: {
                        pending: [],
                        overdue: [],
                        completed: [],
                        total: 0
                    }
                }
            });
        }
        
        // 모든 수강 과목의 과제 및 퀴즈 정보 조회
        const assignmentsQuery = `
            SELECT 
                c.id as course_id,
                c.title as course_title,
                gi.item_id,
                gi.item_type,
                gi.item_name,
                gi.due_date,
                sg.score,
                sg.is_completed,
                sg.submission_date
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            JOIN ${SCHEMAS.GRADE}.student_grades sg ON gi.item_id = sg.item_id
            WHERE sg.enrollment_id = ANY($1)
            AND gi.item_type IN ('ASSIGNMENT', 'EXAM')
            ORDER BY gi.due_date ASC NULLS LAST
        `;
        
        const enrollmentIds = enrollmentsResult.rows.map(row => row.id);
        const assignmentsResult = await client.query(assignmentsQuery, [enrollmentIds]);
        
        // 과제와 퀴즈를 분리하여 결과 구성
        const assignments = assignmentsResult.rows.filter(item => item.item_type === 'ASSIGNMENT').map(item => ({
            ...item,
            due_date: item.due_date ? new Date(item.due_date).toISOString() : null
        }));
        
        const exams = assignmentsResult.rows.filter(item => item.item_type === 'EXAM').map(item => ({
            ...item,
            due_date: item.due_date ? new Date(item.due_date).toISOString() : null
        }));
        
        // 마감일이 지난 항목과 아닌 항목 구분
        const now = new Date();
        const pendingAssignments = assignments.filter(item => !item.is_completed && (!item.due_date || new Date(item.due_date) > now));
        const overdueAssignments = assignments.filter(item => !item.is_completed && item.due_date && new Date(item.due_date) <= now);
        const completedAssignments = assignments.filter(item => item.is_completed);
        
        const pendingExams = exams.filter(item => !item.is_completed && (!item.due_date || new Date(item.due_date) > now));
        const overdueExams = exams.filter(item => !item.is_completed && item.due_date && new Date(item.due_date) <= now);
        const completedExams = exams.filter(item => item.is_completed);
        
        res.json({
            success: true,
            data: {
                assignments: {
                    pending: pendingAssignments,
                    overdue: overdueAssignments,
                    completed: completedAssignments,
                    total: assignments.length
                },
                exams: {
                    pending: pendingExams,
                    overdue: overdueExams,
                    completed: completedExams,
                    total: exams.length
                }
            }
        });
    } catch (error) {
        console.error('Error fetching student assignments:', error);
        res.status(500).json({
            success: false,
            message: "과제 및 퀴즈 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 