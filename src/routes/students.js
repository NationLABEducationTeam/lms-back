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

module.exports = router; 