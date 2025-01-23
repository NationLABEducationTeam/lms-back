const express = require('express');
const router = express.Router();
const { pool, SCHEMAS, TABLES } = require('../config/database');
const { verifyToken, requireRole } = require('../middlewares/auth');

// 수강신청
router.post('/', verifyToken, requireRole(['STUDENT']), async (req, res) => {
    const client = await pool.connect();
    try {
        const { courseId, userId, enrolledAt } = req.body;
        console.log('Enrollment request received:', { courseId, userId, enrolledAt });
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        console.log('Transaction started');

        // 1. 강의가 존재하는지 확인
        const courseQuery = `
            SELECT * FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `;
        console.log('Checking course existence with query:', courseQuery);
        const courseResult = await client.query(courseQuery, [courseId]);
        console.log('Course query result:', courseResult.rows);
        
        if (courseResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.log('Course not found, rolling back transaction');
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        // 2. 이미 수강신청한 강의인지 확인
        const existingEnrollmentQuery = `
            SELECT * FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2
        `;
        console.log('Checking existing enrollment with query:', existingEnrollmentQuery);
        const existingEnrollment = await client.query(existingEnrollmentQuery, [userId, courseId]);
        console.log('Existing enrollment query result:', existingEnrollment.rows);
        
        if (existingEnrollment.rows.length > 0) {
            await client.query('ROLLBACK');
            console.log('Already enrolled, rolling back transaction');
            return res.status(400).json({
                success: false,
                message: 'Already enrolled in this course'
            });
        }

        // 3. 수강신청 정보 저장
        const enrollmentQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            (student_id, course_id, enrolled_at, status)
            VALUES ($1, $2, $3, 'ACTIVE')
            RETURNING *
        `;
        console.log('Inserting enrollment with query:', enrollmentQuery);
        console.log('Enrollment parameters:', [userId, courseId, enrolledAt || new Date()]);
        const enrollmentResult = await client.query(enrollmentQuery, [
            userId,
            courseId,
            enrolledAt || new Date()
        ]);
        console.log('Enrollment insert result:', enrollmentResult.rows[0]);

        // 4. 학습 진도 정보 초기화
        const progressQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING}
            (enrollment_id, progress_status, last_accessed_at)
            VALUES ($1, 'NOT_STARTED', $2)
        `;
        console.log('Inserting progress tracking with query:', progressQuery);
        await client.query(progressQuery, [
            enrollmentResult.rows[0].id,
            new Date()
        ]);
        console.log('Progress tracking inserted successfully');

        // 트랜잭션 커밋
        await client.query('COMMIT');
        console.log('Transaction committed successfully');

        res.status(201).json({
            success: true,
            message: 'Successfully enrolled in the course',
            data: {
                enrollment: enrollmentResult.rows[0]
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during enrollment:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to enroll in the course',
            error: error.message,
            details: error.stack
        });
    } finally {
        client.release();
    }
});

// 수강신청 상태 확인
router.get('/status/:courseId', verifyToken, async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user.sub;

        const query = `
            SELECT 
                e.*,
                pt.progress_percentage,
                pt.last_accessed
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.student_id = $1 AND e.course_id = $2
        `;

        const result = await pool.query(query, [userId, courseId]);

        res.json({
            success: true,
            data: {
                isEnrolled: result.rows.length > 0,
                enrollment: result.rows[0] || null
            }
        });
    } catch (error) {
        console.error('Error checking enrollment status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check enrollment status',
            error: error.message
        });
    }
});

// 학생이 수강 신청한 과목 목록 조회
router.get('/my-courses', verifyToken, requireRole(['STUDENT']), async (req, res) => {
    try {
        const userId = req.user.sub;

        const query = `
            SELECT 
                c.*,
                e.enrolled_at,
                e.status as enrollment_status,
                pt.progress_status,
                pt.last_accessed_at,
                u.name as instructor_name
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
                ON c.instructor_id = u.id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [userId]);

        res.json({
            success: true,
            data: {
                courses: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching enrolled courses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled courses',
            error: error.message
        });
    }
});

module.exports = router; 