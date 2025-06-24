const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../../config/database');

/**
 * @api {get} /api/v1/admin/students 모든 학생 목록 조회
 * @apiDescription 관리자가 모든 학생 목록을 조회합니다.
 * @apiName GetAllStudents
 * @apiGroup AdminStudents
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.students 학생 목록
 * @apiSuccess {Number} data.total 총 학생 수
 */
router.get('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const pool = getPool('read');
        const query = `
            SELECT 
                u.cognito_user_id,
                u.given_name,
                u.email,
                u.created_at,
                u.updated_at,
                COUNT(e.id) as total_enrollments,
                COUNT(CASE WHEN e.status = 'ACTIVE' THEN 1 END) as active_enrollments
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e 
                ON u.cognito_user_id = e.student_id
            WHERE u.role = 'STUDENT'
            GROUP BY u.cognito_user_id, u.given_name, u.email, u.created_at, u.updated_at
            ORDER BY u.given_name
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: {
                students: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('학생 목록 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * @api {get} /api/v1/admin/students/:studentId 특정 학생 상세 정보 조회
 * @apiDescription 관리자가 특정 학생의 상세 정보를 조회합니다.
 * @apiName GetStudentDetail
 * @apiGroup AdminStudents
 * @apiParam {String} studentId 학생 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data.student 학생 기본 정보
 * @apiSuccess {Object[]} data.enrollments 수강 목록
 * @apiSuccess {Object} data.statistics 통계 정보
 */
router.get('/:studentId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
        const pool = getPool('read');
        
        // 학생 기본 정보 조회
        const studentQuery = `
            SELECT 
                cognito_user_id,
                given_name,
                email,
                role,
                created_at,
                updated_at
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1 AND role = 'STUDENT'
        `;
        
        const studentResult = await pool.query(studentQuery, [studentId]);
        
        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '해당 학생을 찾을 수 없습니다.'
            });
        }
        
        // 학생의 수강 정보 조회
        const enrollmentsQuery = `
            SELECT 
                e.id as enrollment_id,
                e.course_id,
                e.status as enrollment_status,
                e.enrolled_at,
                e.final_grade,
                c.title as course_title,
                c.description as course_description,
                c.status as course_status,
                c.main_category_id,
                c.sub_category_id,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date,
                u_instructor.given_name as instructor_name
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u_instructor
                ON c.instructor_id = u_instructor.cognito_user_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;
        
        const enrollmentsResult = await pool.query(enrollmentsQuery, [studentId]);
        
        // 통계 정보 계산
        const statistics = {
            totalEnrollments: enrollmentsResult.rowCount,
            activeEnrollments: enrollmentsResult.rows.filter(e => e.enrollment_status === 'ACTIVE').length,
            completedCourses: enrollmentsResult.rows.filter(e => e.progress_status === 'COMPLETED').length,
            averageGrade: 0
        };
        
        // 평균 성적 계산 (final_grade가 있는 경우만)
        const gradesWithValues = enrollmentsResult.rows
            .filter(e => e.final_grade !== null && e.final_grade !== undefined)
            .map(e => parseFloat(e.final_grade));
            
        if (gradesWithValues.length > 0) {
            statistics.averageGrade = parseFloat(
                (gradesWithValues.reduce((sum, grade) => sum + grade, 0) / gradesWithValues.length).toFixed(2)
            );
        }
        
        res.json({
            success: true,
            data: {
                student: studentResult.rows[0],
                enrollments: enrollmentsResult.rows,
                statistics
            }
        });
    } catch (error) {
        console.error('학생 상세 정보 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 상세 정보 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * @api {get} /api/v1/admin/students/:studentId/courses 특정 학생의 수강 과목 목록
 * @apiDescription 관리자가 특정 학생의 수강 과목 목록을 조회합니다.
 * @apiName GetStudentCourses
 * @apiGroup AdminStudents
 * @apiParam {String} studentId 학생 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.courses 수강 과목 목록
 * @apiSuccess {Number} data.total 총 수강 과목 수
 */
router.get('/:studentId/courses', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
        const pool = getPool('read');
        
        const query = `
            SELECT 
                c.*,
                e.status as enrollment_status,
                e.enrolled_at,
                e.final_grade,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date,
                u.given_name as instructor_name
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
            JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e 
                ON c.id = e.course_id 
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
                ON c.instructor_id = u.cognito_user_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;
        
        const result = await pool.query(query, [studentId]);
        
        res.json({
            success: true,
            data: {
                courses: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('학생 수강 과목 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 수강 과목 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * @api {get} /api/v1/admin/students/:studentId/grades 특정 학생의 성적 정보
 * @apiDescription 관리자가 특정 학생의 모든 과목 성적 정보를 조회합니다.
 * @apiName GetStudentGrades
 * @apiGroup AdminStudents
 * @apiParam {String} studentId 학생 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.grades 성적 정보
 */
router.get('/:studentId/grades', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
        const pool = getPool('read');
        
        const query = `
            SELECT 
                c.id as course_id,
                c.title as course_title,
                e.final_grade,
                json_agg(
                    json_build_object(
                        'item_id', gi.item_id,
                        'item_name', gi.item_name,
                        'item_type', gi.item_type,
                        'score', COALESCE(sg.score, 0),
                        'is_completed', COALESCE(sg.is_completed, false),
                        'submission_date', sg.submission_date,
                        'feedback', sg.feedback
                    ) ORDER BY gi.item_order
                ) as grade_items
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            LEFT JOIN grade_schema.grade_items gi ON c.id = gi.course_id
            LEFT JOIN grade_schema.student_grades sg ON gi.item_id = sg.item_id AND sg.enrollment_id = e.id
            WHERE e.student_id = $1
            GROUP BY c.id, c.title, e.final_grade
            ORDER BY c.title
        `;
        
        const result = await pool.query(query, [studentId]);
        
        res.json({
            success: true,
            data: {
                grades: result.rows
            }
        });
    } catch (error) {
        console.error('학생 성적 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 성적 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 