const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../../config/database');
const { 
    listCourseWeekMaterials, 
    createEmptyFolder, 
    generateUploadUrls,
    generateVodUploadUrls,
    listVodFiles,
    createVodFolder
} = require('../../utils/s3');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client } = require('../../config/s3');

// Admin: Get specific course with materials
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
                u.cognito_user_id as instructor_id,
                c.classmode,
                c.zoom_link
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

        const course = result.rows[0];

        // S3에서 강좌 자료 조회
        const coursePrefix = `${course.title}/`;
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
                        downloadUrl: file.downloadUrl,
                        downloadable: file.downloadable,
                        lastModified: file.lastModified,
                        size: file.size,
                        type: file.type
                    });
                    return acc;
                }, {})
            }));

        res.json({
            success: true,
            data: {
                course: {
                    ...course,
                    weeks
                }
            }
        });
    } catch (error) {
        console.error('Error fetching course details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch course details',
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

// Admin: Update course
router.put('/:courseId/edit', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;
        console.log('Attempting to update course:', courseId);

        await client.query('BEGIN');

        const { 
            title, 
            description, 
            instructor_id,
            main_category_id,
            sub_category_id,
            thumbnail_url,
            price,
            level,
            classmode,
            zoom_link,
            status
        } = req.body;

        // First check if the course exists
        const checkResult = await client.query(`
            SELECT classmode FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `, [courseId]);

        if (checkResult.rows.length === 0) {
            throw new Error('Course not found');
        }

        // Validate classmode if it's being updated
        if (classmode && !['ONLINE', 'VOD'].includes(classmode.toUpperCase())) {
            throw new Error('Invalid classmode. Must be either ONLINE or VOD');
        }

        // If updating to ONLINE mode or already ONLINE, ensure zoom_link is provided
        const isOrWillBeOnline = classmode ? classmode.toUpperCase() === 'ONLINE' : checkResult.rows[0].classmode === 'ONLINE';
        if (isOrWillBeOnline && !zoom_link) {
            throw new Error('zoom_link is required for ONLINE courses');
        }

        // Build update query dynamically based on provided fields
        const updates = [];
        const values = [courseId];
        let paramCount = 2; // Starting from 2 as $1 is courseId

        if (title) {
            updates.push(`title = $${paramCount}`);
            values.push(title);
            paramCount++;
        }
        if (description) {
            updates.push(`description = $${paramCount}`);
            values.push(description);
            paramCount++;
        }
        if (instructor_id) {
            updates.push(`instructor_id = $${paramCount}`);
            values.push(instructor_id);
            paramCount++;
        }
        if (main_category_id) {
            updates.push(`main_category_id = $${paramCount}`);
            values.push(main_category_id);
            paramCount++;
        }
        if (sub_category_id) {
            updates.push(`sub_category_id = $${paramCount}`);
            values.push(sub_category_id);
            paramCount++;
        }
        if (thumbnail_url) {
            updates.push(`thumbnail_url = $${paramCount}`);
            values.push(thumbnail_url);
            paramCount++;
        }
        if (price) {
            updates.push(`price = $${paramCount}`);
            values.push(price);
            paramCount++;
        }
        if (level) {
            updates.push(`level = $${paramCount}`);
            values.push(level);
            paramCount++;
        }
        if (classmode) {
            updates.push(`classmode = $${paramCount}`);
            values.push(classmode.toUpperCase());
            paramCount++;
        }
        if (zoom_link !== undefined) { // Allow clearing zoom_link for VOD courses
            updates.push(`zoom_link = $${paramCount}`);
            values.push(zoom_link);
            paramCount++;
        }
        if (status) {
            updates.push(`status = $${paramCount}`);
            values.push(status);
            paramCount++;
        }

        // Add updated_at timestamp
        updates.push(`updated_at = CURRENT_TIMESTAMP`);

        if (updates.length === 0) {
            throw new Error('No fields to update');
        }

        const updateQuery = `
            UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            SET ${updates.join(', ')}
            WHERE id = $1
            RETURNING *
        `;

        console.log('Executing update query:', updateQuery);
        console.log('With values:', values);

        const result = await client.query(updateQuery, values);
        
        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Course updated successfully',
            data: {
                course: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating course:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update course',
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

        // Get course title and classmode from database
        const query = `
            SELECT title, classmode
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

        const { title, classmode } = result.rows[0];
        console.log('Generating presigned URLs for course:', title, 'week:', weekNumber);
        
        // VOD 영상 파일과 일반 파일 분리
        const vodFiles = files.filter(file => file.type.startsWith('video/'));
        const regularFiles = files.filter(file => !file.type.startsWith('video/'));
        
        let presignedUrls = [];

        // VOD 영상 파일 처리 (VOD 강좌인 경우에만)
        if (classmode === 'VOD' && vodFiles.length > 0) {
            // 한글 제목을 영문으로 변환하여 VOD 폴더명 생성
            const { englishTitle } = await createVodFolder(title);
            const vodUrls = await generateVodUploadUrls(englishTitle, vodFiles);
            presignedUrls.push(...vodUrls);
        }

        // 일반 파일 처리
        if (regularFiles.length > 0) {
            const regularUrls = await generateUploadUrls(title, weekNumber, regularFiles);
            presignedUrls.push(...regularUrls);
        }

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

// Admin: Toggle course status (PUBLISHED <-> DRAFT)
router.put('/:courseId/toggle-status', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;
        console.log('Attempting to toggle course status:', courseId);

        await client.query('BEGIN');

        // First check if the course exists and get current status
        const checkResult = await client.query(`
            SELECT status FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `, [courseId]);

        if (checkResult.rows.length === 0) {
            throw new Error('Course not found');
        }

        // Toggle status
        const currentStatus = checkResult.rows[0].status;
        const newStatus = currentStatus === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';

        const updateQuery = `
            UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            SET 
                status = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;

        const result = await client.query(updateQuery, [courseId, newStatus]);
        
        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Course status toggled from ${currentStatus} to ${newStatus}`,
            data: {
                course: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error toggling course status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle course status',
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 