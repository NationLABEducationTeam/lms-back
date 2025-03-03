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
    createVodFolder,
    sanitizePathComponent,
    updateFileDownloadPermission
} = require('../../utils/s3');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client } = require('../../config/s3');
const { ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const { createZoomMeeting } = require('./zoom');

// Admin: Get specific course with materials
router.get('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();
    
    try {
        const { courseId } = req.params;
        const query = `
            SELECT 
                c.*,
                u.name as instructor_name,
                u.cognito_user_id as instructor_id,
                c.classmode,
                c.zoom_link
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            WHERE c.id = $1
            GROUP BY 
                c.id, 
                u.name,
                u.cognito_user_id,
                c.classmode,
                c.zoom_link
        `;
        
        const result = await client.query(query, [courseId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const course = result.rows[0];

        // S3에서 강좌 자료 조회
        const coursePrefix = `${course.id}/`;
        console.log('Fetching materials for course:', coursePrefix);
        const weeklyMaterials = await listCourseWeekMaterials(coursePrefix, 'ADMIN');
        
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
                        type: file.type,
                        isHlsFile: file.isHlsFile,
                        baseFileName: file.baseFileName
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
    } finally {
        client.release();
    }
});

// Admin: Get all courses
router.get('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const pool = getPool('read');
        const query = `
            SELECT 
                c.*,
                u.name as instructor_name
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
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
router.put('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
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

        // Get course id from database
        const query = `
            SELECT id 
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

        const folderPath = `${courseId}/${weekNumber}주차/`;
        
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

        // Get course id and classmode from database
        const query = `
            SELECT id, classmode
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

        console.log('Generating presigned URLs for course:', {
            courseId,
            weekNumber,
            files
        });
        
        // 모든 파일을 일반 업로드로 처리
        const presignedUrls = await generateUploadUrls(courseId, weekNumber, files);

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

// Admin: Create course
router.post('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();

    try {
        await client.query('BEGIN');
        console.log('🔵 Transaction started');

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
            attendance_weight = 20,
            assignment_weight = 50,
            exam_weight = 30,
            weeks_count = 16, // 주차 수 파라미터 추가 (기본값 16주)
            assignment_count = 1, // 과제 개수 파라미터 추가 (기본값 1개)
            exam_count = 1, // 시험 개수 파라미터 추가 (기본값 1개)
            auto_create_zoom = true // 자동 Zoom 미팅 생성 여부
        } = req.body;

        // Zoom 미팅 URL 생성 (auto_create_zoom이 true이고 zoom_link가 제공되지 않은 경우)
        let finalZoomLink = zoom_link;
        
        if (classmode.toUpperCase() === 'ONLINE' && auto_create_zoom && !zoom_link) {
            console.log('🔵 자동 Zoom 미팅 생성 시작 (ONLINE 강의)');
            try {
                const meetingResult = await createZoomMeeting(title);
                if (meetingResult.success) {
                    finalZoomLink = meetingResult.join_url;
                    console.log('✅ Zoom 미팅 생성 성공:', finalZoomLink);
                } else {
                    console.error('❌ Zoom 미팅 생성 실패:', meetingResult.error);
                }
            } catch (zoomError) {
                console.error('❌ Zoom 미팅 생성 중 오류:', zoomError);
                // 오류가 발생해도 강의 생성은 계속 진행
            }
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
                level,
                classmode,
                zoom_link,
                coursebucket,
                attendance_weight,
                assignment_weight,
                exam_weight,
                weeks_count,
                assignment_count,
                exam_count
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING *
        `;

        const tempCoursebucket = 'nationslablmscoursebucket';

        const values = [
            title,
            description,
            instructor_id,
            main_category_id,
            sub_category_id,
            thumbnail_url,
            price,
            level,
            classmode.toUpperCase(),
            finalZoomLink,
            tempCoursebucket,
            attendance_weight,
            assignment_weight,
            exam_weight,
            weeks_count,
            assignment_count,
            exam_count
        ];

        console.log('📝 Executing course creation query:', {
            query,
            values
        });

        const result = await client.query(query, values);
        const courseId = result.rows[0].id;
        
        console.log('✅ Course created successfully:', {
            courseId,
            title
        });
        
        const folderPath = classmode.toUpperCase() === 'VOD' ? `vod/${courseId}/` : `${courseId}/`;
        
        const updateQuery = `
            UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            SET coursebucket = $1
            WHERE id = $2
        `;
        await client.query(updateQuery, [`nationslablmscoursebucket/${folderPath}`, courseId]);

        // 평가 항목 생성 (출석, 과제, 시험)
        console.log('📝 Creating grade items for course:', courseId);
        console.log(`Creating ${weeks_count} attendance items, ${assignment_count} assignment items, and ${exam_count} exam items`);
        
        // 1. 출석 평가 항목 생성 (주차별로 생성)
        for (let i = 1; i <= weeks_count; i++) {
            await client.query(
                `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
                (course_id, item_type, item_name, max_score, item_order)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING item_id`,
                [courseId, 'ATTENDANCE', `${i}주차 출석`, 100, i]
            );
        }
        
        // 2. 과제 평가 항목 생성
        for (let i = 1; i <= assignment_count; i++) {
            await client.query(
                `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
                (course_id, item_type, item_name, max_score, item_order)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING item_id`,
                [courseId, 'ASSIGNMENT', `과제 ${i}`, 100, weeks_count + i]
            );
        }
        
        // 3. 시험 평가 항목 생성
        const examNames = ['중간고사', '기말고사', '퀴즈 1', '퀴즈 2', '퀴즈 3'];
        for (let i = 1; i <= exam_count; i++) {
            const examName = i <= examNames.length ? examNames[i-1] : `시험 ${i}`;
            await client.query(
                `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
                (course_id, item_type, item_name, max_score, item_order)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING item_id`,
                [courseId, 'EXAM', examName, 100, weeks_count + assignment_count + i]
            );
        }

        await client.query('COMMIT');
        console.log('✅ Transaction committed successfully');

        res.json({
            success: true,
            message: 'Course created successfully',
            data: {
                course: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error in course creation:', {
            error: error.message,
            stack: error.stack,
            query: error.query,
            parameters: error.parameters,
            type: error.code,
            detail: error.detail,
            hint: error.hint,
            position: error.position
        });
        res.status(500).json({
            success: false,
            message: 'Failed to create course',
            error: error.message,
            detail: error.detail,
            hint: error.hint
        });
    } finally {
        client.release();
        console.log('🔵 Database client released');
    }
});

// Update file download permission (Admin only)
router.put('/:courseId/materials/:weekNumber/:fileName/permission', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { courseId, weekNumber, fileName } = req.params;
        const { isDownloadable } = req.body;

        console.log('Updating file permission:', {
            courseId,
            weekNumber,
            fileName,
            isDownloadable
        });

        if (typeof isDownloadable !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'isDownloadable must be a boolean value'
            });
        }

        // 강좌 정보 조회
        const courseQuery = `
            SELECT id, classmode
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `;
        const courseResult = await getPool('read').query(courseQuery, [courseId]);

        if (courseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const { classmode } = courseResult.rows[0];
        console.log('Found course:', { courseId, classmode });

        // 파일 경로 생성
        const sanitizedFileName = sanitizePathComponent(fileName);
        let key;
        let bucketName = 'nationslablmscoursebucket';  // 모든 파일이 같은 버킷 사용

        // VOD 파일인 경우도 주차별로 구조화
        key = `${courseId}/${weekNumber}주차/${sanitizedFileName}`;

        // .m3u8 파일인 경우, 관련된 .ts 파일들도 함께 권한 변경
        if (fileName.endsWith('.m3u8')) {
            try {
                // 같은 디렉토리의 모든 .ts 파일 리스트 조회
                const command = new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: `${courseId}/${weekNumber}주차/`,
                    Delimiter: '/'
                });
                
                const response = await s3Client.send(command);
                const tsFiles = (response.Contents || [])
                    .filter(item => item.Key.endsWith('.ts'))
                    .map(item => item.Key);

                // 모든 .ts 파일의 권한도 함께 업데이트
                for (const tsKey of tsFiles) {
                    await updateFileDownloadPermission(tsKey, isDownloadable, bucketName);
                }

                console.log('Updated permissions for TS files:', tsFiles);
            } catch (error) {
                console.error('Error updating TS files permissions:', error);
            }
        } else if (fileName.endsWith('.ts')) {
            // .ts 파일은 개별적으로 권한을 변경할 수 없음
            return res.status(400).json({
                success: false,
                message: 'TS files permissions can only be modified through their parent M3U8 file'
            });
        }

        console.log('Generated file path:', {
            courseId,
            originalFileName: fileName,
            sanitizedFileName,
            weekNumber,
            key,
            bucketName
        });

        // 파일 존재 여부 확인
        try {
            const command = new HeadObjectCommand({
                Bucket: bucketName,
                Key: key
            });
            await s3Client.send(command);
        } catch (error) {
            console.error('File not found:', {
                bucket: bucketName,
                key: key,
                error: error.message
            });
            return res.status(404).json({
                success: false,
                message: 'File not found in S3',
                details: {
                    bucket: bucketName,
                    key: key
                }
            });
        }

        // S3 파일 다운로드 권한 업데이트
        await updateFileDownloadPermission(key, isDownloadable, bucketName);

        res.json({
            success: true,
            message: `File download permission updated successfully`,
            data: {
                courseId,
                weekNumber,
                fileName,
                isDownloadable,
                bucket: bucketName,
                key
            }
        });
    } catch (error) {
        console.error('Error updating file download permission:', error, {
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Failed to update file download permission',
            error: error.message
        });
    }
});

module.exports = router; 