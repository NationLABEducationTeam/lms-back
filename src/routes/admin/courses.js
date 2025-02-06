const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../../config/database');
const { listCourseWeekMaterials, createEmptyFolder, generateUploadUrls } = require('../../utils/s3');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client } = require('../../config/s3');

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
        const coursePrefix = `${result.rows[0].title}/`;
        console.log('Fetching materials for course:', coursePrefix);
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

// Admin: Delete course
router.delete('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();
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

// Admin: Create week folder
router.post('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const { weekNumber } = req.body;

        if (!weekNumber) {
            return res.status(400).json({
                success: false,
                message: 'weekNumber is required'
            });
        }

        // Get course title from database
        const query = `
            SELECT title 
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `;
        
        const result = await getPool('read').query(query, [courseId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const courseTitle = result.rows[0].title;
        const folderPath = `${courseTitle}/${weekNumber}주차/`;
        
        console.log('Creating folder:', folderPath);
        await createEmptyFolder(folderPath);

        res.json({
            success: true,
            message: 'Week folder created successfully',
            data: {
                courseId,
                weekNumber,
                folderPath
            }
        });
    } catch (error) {
        console.error('Error creating week folder:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create week folder',
            error: error.message
        });
    }
});

// Admin: Generate presigned URLs for file upload
router.post('/:courseId/:weekNumber/upload', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const weekNumber = parseInt(req.params.weekNumber);
        const { files } = req.body;

        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'files array is required in request body'
            });
        }

        // Validate file information
        const isValidFiles = files.every(file => 
            file.name && 
            typeof file.name === 'string' && 
            file.type && 
            typeof file.type === 'string' &&
            file.size && 
            typeof file.size === 'number'
        );

        if (!isValidFiles) {
            return res.status(400).json({
                success: false,
                message: 'Each file must have name (string), type (string), and size (number)'
            });
        }

        // Get course title from database
        const query = `
            SELECT title 
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `;
        
        const result = await getPool('read').query(query, [courseId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const courseTitle = result.rows[0].title;
        console.log('Generating presigned URLs for course:', courseTitle, 'week:', weekNumber);
        
        // 각 파일에 대한 presigned URL 생성
        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const key = `${courseTitle}/${weekNumber}주차/${file.name}`;
                const command = new PutObjectCommand({
                    Bucket: 'nationslablmscoursebucket',
                    Key: key,
                    ContentType: file.type
                });
                
                const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                return {
                    fileName: file.name,
                    url,
                    key
                };
            })
        );

        res.json({
            success: true,
            message: 'Upload URLs generated successfully',
            data: {
                urls: presignedUrls
            }
        });
    } catch (error) {
        console.error('Error generating upload URLs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate upload URLs',
            error: error.message
        });
    }
});

module.exports = router; 