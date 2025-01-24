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
// TODO: fix this route
router.post('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { title, description, is_public } = req.body;
        const [result] = await pool.query(
            'INSERT INTO courses (title, description, is_public) VALUES (?, ?, ?)',
            [title, description, is_public]
        );
        
        res.status(201).json({ 
            message: 'Course created', 
            courseId: result.insertId 
        });
    } catch (error) {
        console.error('Error creating course:', error);
        res.status(500).json({ message: 'Internal server error' });
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
    try {
        const { courseId } = req.params;
        await pool.query('DELETE FROM courses WHERE id = ?', [courseId]);
        res.json({ message: 'Course deleted', courseId });
    } catch (error) {
        console.error('Error deleting course:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router; 