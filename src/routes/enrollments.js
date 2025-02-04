const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { getPool, SCHEMAS, TABLES } = require('../config/database');

// Create enrollment
router.post('/', verifyToken, async (req, res) => {
    const pool = getPool('write');
    const client = await pool.connect();
    
    try {
        const { courseId, userId, enrolledAt } = req.body;

        await client.query('BEGIN');

        // Check if the enrollment already exists
        const checkQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE course_id = $1 AND student_id = $2
        `;
        const checkResult = await client.query(checkQuery, [courseId, userId]);

        if (checkResult.rows.length > 0) {
            throw new Error('User is already enrolled in this course');
        }

        // Create enrollment
        const enrollmentQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            (course_id, student_id, enrolled_at, status)
            VALUES ($1, $2, $3, 'ACTIVE')
            RETURNING *
        `;
        const enrollmentResult = await client.query(enrollmentQuery, [courseId, userId, enrolledAt || new Date()]);

        // Create initial progress tracking
        const progressQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING}
            (enrollment_id, progress_status, last_accessed_at)
            VALUES ($1, 'NOT_STARTED', $2)
            RETURNING *
        `;
        const progressResult = await client.query(progressQuery, [enrollmentResult.rows[0].id, enrolledAt || new Date()]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Enrollment created successfully',
            data: {
                enrollment: {
                    ...enrollmentResult.rows[0],
                    progress: progressResult.rows[0]
                }
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating enrollment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create enrollment',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Get enrollments for a course
router.get('/course/:courseId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const pool = getPool('read');

        const query = `
            SELECT 
                e.*,
                u.name as student_name,
                u.email as student_email,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON e.student_id = u.cognito_user_id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.course_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [courseId]);

        res.json({
            success: true,
            data: {
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching course enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollments',
            error: error.message
        });
    }
});

// Get enrollments for a student
router.get('/student/:studentId', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        
        // 자신의 정보이거나 관리자만 조회 가능
        if (req.user.sub !== studentId && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const pool = getPool('read');
        const query = `
            SELECT 
                e.*,
                c.title as course_title,
                c.description as course_description,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [studentId]);

        res.json({
            success: true,
            data: {
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching student enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollments',
            error: error.message
        });
    }
});

// Update enrollment status
router.put('/:enrollmentId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const pool = getPool('write');
    const client = await pool.connect();
    
    try {
        const { enrollmentId } = req.params;
        const { status } = req.body;

        await client.query('BEGIN');

        // Update enrollment status
        const query = `
            UPDATE ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            SET 
                status = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *
        `;
        
        const result = await client.query(query, [status, enrollmentId]);

        if (result.rows.length === 0) {
            throw new Error('Enrollment not found');
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Enrollment status updated successfully',
            data: {
                enrollment: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating enrollment status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update enrollment status',
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 