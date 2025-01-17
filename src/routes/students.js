const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const pool = require('../config/database');

// Get all students
router.get('/', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const [students] = await pool.query('SELECT * FROM students');
        res.json(students);
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get specific student
router.get('/:studentId', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        const [student] = await pool.query('SELECT * FROM students WHERE id = ?', [studentId]);
        
        if (student.length === 0) {
            return res.status(404).json({ message: 'Student not found' });
        }
        
        res.json(student[0]);
    } catch (error) {
        console.error('Error fetching student:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get student's courses
router.get('/:studentId/courses', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        const [courses] = await pool.query(
            `SELECT c.* FROM courses c 
             JOIN student_courses sc ON c.id = sc.course_id 
             WHERE sc.student_id = ?`,
            [studentId]
        );
        
        res.json(courses);
    } catch (error) {
        console.error('Error fetching student courses:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router; 