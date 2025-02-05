const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../../config/database');
const { listCourseWeekMaterials } = require('../../utils/s3');

// Admin: Get specific course with week materials
router.get('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
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
        
        const result = await getPool('read').query(query, [courseId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        // S3에서 모든 주차 자료 조회
        const coursePrefix = `${courseId}/`;
        const weeklyMaterials = await listCourseWeekMaterials(coursePrefix);
        
        // 주차별 데이터를 정렬하여 배열로 변환
        const weeks = Object.entries(weeklyMaterials)
            .sort(([weekA], [weekB]) => {
                const numA = parseInt(weekA.replace('week', ''));
                const numB = parseInt(weekB.replace('week', ''));
                return numA - numB;
            })
            .map(([weekName, files]) => ({
                weekName,
                weekNumber: parseInt(weekName.replace('week', '')),
                materials: files.reduce((acc, file) => {
                    if (!acc[file.type]) {
                        acc[file.type] = [];
                    }
                    acc[file.type].push({
                        fileName: file.fileName,
                        downloadUrl: `https://nationslablmscoursebucket.s3.ap-northeast-2.amazonaws.com/${file.key}`,
                        lastModified: file.lastModified,
                        size: file.size
                    });
                    return acc;
                }, {})
            }));

        res.json({
            success: true,
            data: {
                course: result.rows[0],
                weeks: weeks
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

// Admin: Get all courses
router.get('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const pool = getPool('read');
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

module.exports = router; 