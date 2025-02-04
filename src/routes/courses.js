const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const dynamodb = require('../config/dynamodb');
const { pool, testConnection } = require('../config/database');
const { SCHEMAS, TABLES } = require('../config/database');

const TABLE_NAME = 'nationslab-courses';

// Test database connection
router.get('/test-db', async (req, res) => {
    console.log('Attempting to test database connection...');
    try {
        const isConnected = await testConnection();
        if (isConnected) {
            res.json({
                message: 'Database connection successful',
                connected: true
            });
        } else {
            res.status(500).json({
                message: 'Database connection failed',
                connected: false
            });
        }
    } catch (error) {
        console.error('Database connection test failed:');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            message: 'Database connection failed',
            error: error.message,
            errorName: error.name,
            connected: false
        });
    }
});

// Public routes - Get all published courses
router.get('/public', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*,
                mc.name as main_category_name,
                sc.name as sub_category_name,
                u.name as instructor_name
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc 
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc 
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            ORDER BY c.created_at DESC
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: {
                courses: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching public courses:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to fetch courses',
            error: error.message 
        });
    }
});

// Get all courses (Public)
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*,
                mc.name as main_category_name,
                sc.name as sub_category_name,
                u.name as instructor_name
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc 
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc 
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            ORDER BY c.created_at DESC
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: {
                courses: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching courses:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to fetch courses',
            error: error.message 
        });
    }
});

// Get specific course
router.get('/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const query = `
            SELECT 
                c.*,
                mc.name as main_category_name,
                mc.id as main_category_id,
                sc.name as sub_category_name,
                sc.id as sub_category_id,
                u.name as instructor_name,
                u.cognito_user_id as instructor_id
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc 
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc 
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            WHERE c.id = $1
        `;
        
        const result = await pool.query(query, [courseId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        res.json({
            success: true,
            data: {
                course: result.rows[0]
            }
        });
    } catch (error) {
        console.error('Error fetching course:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch course',
            error: error.message
        });
    }
});

// Student enrollment
router.post('/:courseId/enroll', verifyToken, requireRole(['STUDENT']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user.sub;
        
        await pool.query(
            'INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)',
            [userId, courseId]
        );
        
        res.json({ message: 'Enrolled successfully', courseId, userId });
    } catch (error) {
        console.error('Error enrolling in course:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get student's course progress
router.get('/my/progress', verifyToken, requireRole(['STUDENT']), async (req, res) => {
    try {
        const userId = req.user.sub;
        const [progress] = await pool.query(
            `SELECT c.*, sc.progress_percentage, sc.last_accessed 
             FROM courses c 
             JOIN student_courses sc ON c.id = sc.course_id 
             WHERE sc.student_id = ?`,
            [userId]
        );
        
        res.json({ progress });
    } catch (error) {
        console.error('Error fetching progress:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Course management (Instructor/Admin)
router.post('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');  // Start transaction

        const { 
            title, 
            description, 
            instructor_id,
            main_category_id,
            sub_category_id,
            thumbnail_url,
            price,
            level
        } = req.body;

        // Validate required fields
        if (!title || !description || !instructor_id || !main_category_id || !sub_category_id) {
            throw new Error('Missing required fields: title, description, instructor_id, main_category_id, and sub_category_id are required');
        }

        console.log('Received course creation request:', {
            title,
            description,
            instructor_id,
            main_category_id,
            sub_category_id,
            thumbnail_url,
            price,
            level
        });

        // Check if main category exists, if not create it
        let mainCategoryResult = await client.query(`
            SELECT id FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES}
            WHERE id = $1
        `, [main_category_id]);

        if (mainCategoryResult.rows.length === 0) {
            console.log(`Creating new main category: ${main_category_id}`);
            mainCategoryResult = await client.query(`
                INSERT INTO ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES}
                (id, name)
                VALUES ($1, $1)
                RETURNING id
            `, [main_category_id]);
        }

        // Check if sub category exists, if not create it
        let subCategoryResult = await client.query(`
            SELECT id FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES}
            WHERE id = $1 AND main_category_id = $2
        `, [sub_category_id, main_category_id]);

        if (subCategoryResult.rows.length === 0) {
            console.log(`Creating new sub category: ${sub_category_id} under ${main_category_id}`);
            subCategoryResult = await client.query(`
                INSERT INTO ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES}
                (id, name, main_category_id)
                VALUES ($1, $1, $2)
                RETURNING id
            `, [sub_category_id, main_category_id]);
        }

        // Create the course
        const query = `
            INSERT INTO ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            (
                title, 
                description, 
                instructor_id,
                main_category_id,
                sub_category_id,
                thumbnail_url,
                price,
                level
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;

        const values = [
            title,
            description,
            instructor_id,
            main_category_id,
            sub_category_id,
            thumbnail_url,
            price,
            level
        ];

        const result = await client.query(query, values);
        
        await client.query('COMMIT');  // Commit transaction

        res.status(201).json({ 
            success: true,
            message: 'Course created successfully',
            data: {
                course: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');  // Rollback on error
        console.error('Error creating course:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to create course',
            error: error.message 
        });
    } finally {
        client.release();
    }
});

router.put('/:courseId', verifyToken, requireRole(['INSTRUCTOR', 'ADMIN']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const { title, description, is_public } = req.body;
        
        await pool.query(
            'UPDATE courses SET title = ?, description = ?, is_public = ? WHERE id = ?',
            [title, description, is_public, courseId]
        );
        
        res.json({ message: 'Course updated', courseId });
    } catch (error) {
        console.error('Error updating course:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await pool.connect();
    try {
        const { courseId } = req.params;
        console.log('Attempting to delete course:', courseId);

        await client.query('BEGIN');

        // First check if the course exists
        const checkResult = await client.query(`
            SELECT id FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `, [courseId]);

        if (checkResult.rows.length === 0) {
            throw new Error('Course not found');
        }

        // Delete related records in progress_tracking
        await client.query(`
            DELETE FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING}
            WHERE enrollment_id IN (
                SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
                WHERE course_id = $1
            )
        `, [courseId]);

        // Delete enrollments
        await client.query(`
            DELETE FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE course_id = $1
        `, [courseId]);

        // Finally delete the course
        await client.query(`
            DELETE FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `, [courseId]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Course and related records deleted successfully',
            data: {
                courseId
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting course:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete course',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Get enrolled courses for a student
router.get('/enrolled/:studentId', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        
        // 자신의 정보이거나 관리자만 조회 가능
        if (req.user.sub !== studentId && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const query = `
            SELECT 
                c.*,
                mc.name as main_category_name,
                sc.name as sub_category_name,
                u.name as instructor_name,
                e.enrolled_at,
                e.status as enrollment_status,
                pt.progress_status,
                pt.last_accessed_at
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc 
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc 
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
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
        console.error('Error fetching enrolled courses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled courses',
            error: error.message
        });
    }
});

// Get enrolled students for a specific course (Admin only)
router.get('/:courseId/students', verifyToken, async (req, res) => {
    try {
        const { courseId } = req.params;
        
        // Check if the user is the specified admin
        const adminId = 'f4282d3c-7061-700d-e22e-e236e6288087';
        if (req.user.sub !== adminId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only authorized admin can access this resource.'
            });
        }

        const query = `
            SELECT 
                u.cognito_user_id,
                u.name,
                u.email,
                e.status as enrollment_status,
                e.enrolled_at as enrollment_date,
                e.updated_at as last_updated,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date,
                c.title as course_title,
                c.description as course_description,
                mc.name as main_category_name,
                sc.name as sub_category_name
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON e.student_id = u.cognito_user_id
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc 
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc 
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.course_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [courseId]);

        res.json({
            success: true,
            data: {
                students: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching enrolled students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled students',
            error: error.message
        });
    }
});

// Get all students with their enrolled courses (Admin only)
router.get('/admin/enrollments/all', verifyToken, async (req, res) => {
    try {
        // Check if the user is the specified admin
        const adminId = 'f4282d3c-7061-700d-e22e-e236e6288087';
        if (req.user.sub !== adminId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only authorized admin can access this resource.'
            });
        }

        const query = `
            SELECT 
                u.cognito_user_id,
                u.name as student_name,
                u.email as student_email,
                json_agg(
                    json_build_object(
                        'course_id', c.id,
                        'course_title', c.title,
                        'enrollment_status', e.status,
                        'enrolled_at', e.enrolled_at,
                        'progress_status', pt.progress_status,
                        'last_accessed_at', pt.last_accessed_at,
                        'completion_date', pt.completion_date,
                        'main_category', mc.name,
                        'sub_category', sc.name
                    ) ORDER BY e.enrolled_at DESC
                ) as enrolled_courses
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
                ON u.cognito_user_id = e.student_id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.MAIN_CATEGORIES} mc
                ON c.main_category_id = mc.id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.SUB_CATEGORIES} sc
                ON c.sub_category_id = sc.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE u.role = 'STUDENT'
            GROUP BY 
                u.cognito_user_id,
                u.name,
                u.email
            ORDER BY u.name
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
        console.error('Error fetching student enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student enrollments',
            error: error.message
        });
    }
});

module.exports = router; 