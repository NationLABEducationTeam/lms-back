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
const crypto = require('crypto');

/**
 * @swagger
 * tags:
 *   - name: Admin: Courses
 *     description: Course management APIs for administrators
 */

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}:
 *   get:
 *     summary: Get a specific course with materials
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         description: The ID of the course to retrieve.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Detailed course information including weekly materials.
 *       '404':
 *         description: Course not found.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses:
 *   get:
 *     summary: Get all courses
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: A list of all courses.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 courses:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Course'
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}:
 *   delete:
 *     summary: Delete a course
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Course and related records deleted successfully.
 *       '404':
 *         description: Course not found.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}:
 *   put:
 *     summary: Update a course
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       description: Course data to update.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Course'
 *     responses:
 *       '200':
 *         description: Course updated successfully.
 *       '404':
 *         description: Course not found.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}:
 *   post:
 *     summary: Create a week folder for a course
 *     tags: [Admin: Courses]
 *     description: Creates a new week folder (e.g., '1주차/') in S3 for the specified course.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               weekNumber:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       '200':
 *         description: Week folder created successfully.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}/{weekNumber}/upload:
 *   post:
 *     summary: Generate presigned URLs for file upload
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *       - in: path
 *         name: weekNumber
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     type:
 *                       type: string
 *     responses:
 *       '200':
 *         description: Upload URLs generated successfully.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}/toggle-status:
 *   put:
 *     summary: Toggle course status
 *     tags: [Admin: Courses]
 *     description: Toggles the status of a course between PUBLISHED and DRAFT.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Course status toggled successfully.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses:
 *   post:
 *     summary: Create a new course
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Course'
 *     responses:
 *       '201':
 *         description: Course created successfully.
 */
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
            weeks_count = 16, 
            assignment_count = 1, 
            exam_count = 1, 
            
            // Zoom 미팅 설정
            zoom_meeting = null,
        } = req.body;

        console.log('🔵 요청으로 받은 데이터:');
        console.log(JSON.stringify(req.body, null, 2));

        // Zoom 미팅 URL 생성 (ONLINE 강의인 경우)
        let finalZoomLink = zoom_link;
        let zoomMeetingData = null;
        
        if (classmode && classmode.toUpperCase() === 'ONLINE' && !zoom_link && zoom_meeting) {
            console.log('🔵 Zoom 미팅 생성 시작 (ONLINE 강의)');
            console.log('🔵 Zoom 미팅 설정:', JSON.stringify(zoom_meeting, null, 2));
            
            try {
                // 시작 시간 파싱
                let startDateTime = null;
                
                if (zoom_meeting.start_date && zoom_meeting.start_time) {
                    const dateStr = zoom_meeting.start_date; // YYYY-MM-DD
                    const timeStr = zoom_meeting.start_time; // HH:MM
                    
                    // 프론트엔드에서 받은 시간값을 그대로 사용 (변환 없음)
                    // startDateTime은 Date 객체로 필요한 경우에만 변환
                    startDateTime = new Date(`${dateStr}T${timeStr}:00`);
                    
                    console.log('▶ 시작 시간 정보:');
                    console.log(`  날짜: ${dateStr}`);
                    console.log(`  시간: ${timeStr}`);
                    console.log(`  시간 문자열: ${dateStr}T${timeStr}:00`);
                    console.log(`  Date 객체: ${startDateTime.toString()}`);
                } else {
                    console.log('▶ 시작 시간 정보가 없습니다.');
                }
                
                // 세션 기간 계산 (종료 시간이 있으면 계산, 없으면 기본값 사용)
                let sessionDuration = 120; // 기본 2시간
                if (zoom_meeting.start_time && zoom_meeting.end_time) {
                    // 24시간제로 파싱
                    const [startHour, startMinute] = zoom_meeting.start_time.split(':').map(Number);
                    const [endHour, endMinute] = zoom_meeting.end_time.split(':').map(Number);
                    
                    // 시작 시간과 종료 시간을 분으로 변환
                    const startMinutes = startHour * 60 + startMinute;
                    let endMinutes = endHour * 60 + endMinute;
                    
                    // 종료 시간이 시작 시간보다 작으면 다음 날로 간주
                    // 예: 시작 13:10, 종료 03:10 -> 다음날 새벽 3시 10분으로 계산
                    if (endMinutes < startMinutes) {
                        endMinutes += 24 * 60;
                        console.log(`  종료 시간이 시작 시간보다 이전이므로 다음 날로 간주`);
                    }
                    
                    sessionDuration = endMinutes - startMinutes;
                    console.log(`  세션 길이 계산: ${startHour}:${startMinute} ~ ${endHour}:${endMinute} = ${sessionDuration}분`);
                } else if (zoom_meeting.duration) {
                    sessionDuration = parseInt(zoom_meeting.duration);
                }
                console.log(`▶ 최종 세션 기간: ${sessionDuration}분`);
                
                // 반복 설정 생성
                let recurrence = null;
                
                // 상세 모드 - 프론트엔드에서 전달한 모든 설정 사용
                if (zoom_meeting.is_recurring) {
                    recurrence = {
                        type: zoom_meeting.recurring_type === 'weekly' ? 2 : 
                              zoom_meeting.recurring_type === 'daily' ? 1 : 
                              zoom_meeting.recurring_type === 'monthly' ? 3 : 2, // 기본값은 weekly
                        repeat_interval: zoom_meeting.recurring_interval || 1
                    };
                    
                    // 요일 설정 (주간인 경우)
                    if (zoom_meeting.recurring_type === 'weekly' && zoom_meeting.recurring_days) {
                        // 숫자 배열을 쉼표로 구분된 문자열로 변환
                        if (Array.isArray(zoom_meeting.recurring_days)) {
                            recurrence.weekly_days = zoom_meeting.recurring_days.join(',');
                            console.log(`  - 요일 배열: [${zoom_meeting.recurring_days}]`);
                            console.log(`  - 변환된 요일 문자열: ${recurrence.weekly_days}`);
                        } else if (typeof zoom_meeting.recurring_days === 'string') {
                            recurrence.weekly_days = zoom_meeting.recurring_days;
                            console.log(`  - 요일 문자열: ${recurrence.weekly_days}`);
                        }
                    }
                    
                    // 종료 설정
                    if (zoom_meeting.recurring_end_type === 'after' && zoom_meeting.recurring_end_count) {
                        recurrence.end_times = parseInt(zoom_meeting.recurring_end_count);
                    } else if (zoom_meeting.recurring_end_type === 'until' && zoom_meeting.recurring_end_date) {
                        const endDate = new Date(`${zoom_meeting.recurring_end_date}T23:59:59`);
                        recurrence.end_date_time = endDate.toISOString();
                    }
                }
                
                console.log(`▶ 반복 설정:`, JSON.stringify(recurrence, null, 2));
                
                // Zoom 미팅 옵션 생성 - 프론트엔드 데이터 사용
                const zoomOptions = {
                    topic: zoom_meeting.meeting_name || title,
                    password: zoom_meeting.passcode,
                    settings: {
                        host_video: zoom_meeting.host_video !== false,
                        participant_video: zoom_meeting.participant_video !== false,
                        join_before_host: zoom_meeting.join_before_host !== false,
                        mute_upon_entry: zoom_meeting.mute_participants !== false,
                        waiting_room: zoom_meeting.waiting_room !== false,
                        auto_recording: zoom_meeting.auto_recording ? 'cloud' : 'none',
                        meeting_authentication: zoom_meeting.require_authentication !== false
                    }
                };
                
                // Zoom 미팅 생성 - 생성 함수 호출
                console.log('▶ Zoom 미팅 생성 함수 호출:');
                const meetingResult = await createZoomMeeting(
                    zoomOptions.topic,
                    startDateTime,
                    sessionDuration,
                    recurrence,
                    {
                        ...zoomOptions,
                        start_date: zoom_meeting.start_date,
                        start_time: zoom_meeting.start_time
                    }
                );
                
                console.log('▶ Zoom 미팅 생성 결과:');
                console.log(JSON.stringify(meetingResult, null, 2));
                
                if (meetingResult.success) {
                    finalZoomLink = meetingResult.join_url;
                    zoomMeetingData = {
                        meeting_id: meetingResult.meeting_id,
                        join_url: meetingResult.join_url,
                        start_url: meetingResult.start_url,
                        password: meetingResult.password,
                        start_time: meetingResult.start_time,
                        duration: meetingResult.duration,
                        recurrence: meetingResult.recurrence
                    };
                    console.log('✅ Zoom 미팅 생성 성공:', finalZoomLink);
                } else {
                    console.error('❌ Zoom 미팅 생성 실패:', meetingResult.error);
                }
            } catch (zoomError) {
                console.error('❌ Zoom 미팅 생성 중 오류:', zoomError);
                // 오류가 발생해도 강의 생성은 계속 진행
            }
        } else {
            console.log('🔴 Zoom 미팅 생성 건너뜀:');
            console.log(`  classmode: ${classmode}`);
            console.log(`  zoom_link: ${zoom_link}`);
            console.log(`  zoom_meeting: ${zoom_meeting ? '존재함' : '없음'}`);
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
            classmode ? classmode.toUpperCase() : 'ONLINE',
            finalZoomLink,
            tempCoursebucket,
            attendance_weight,
            assignment_weight,
            exam_weight,
            weeks_count,
            assignment_count,
            exam_count
        ];

        console.log('📝 Executing course creation query with values:', JSON.stringify(values, null, 2));

        const result = await client.query(query, values);
        const courseId = result.rows[0].id;
        
        console.log('✅ Course created successfully:', {
            courseId,
            title
        });
        
        const folderPath = classmode && classmode.toUpperCase() === 'VOD' ? `vod/${courseId}/` : `${courseId}/`;
        
        const updateQuery = `
            UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            SET coursebucket = $1
            WHERE id = $2
        `;
        await client.query(updateQuery, [`nationslablmscoursebucket/${folderPath}`, courseId]);
        
        // Zoom 미팅 데이터가 있는 경우 zoom_meetings 테이블에 저장
        if (classmode && classmode.toUpperCase() === 'ONLINE' && zoomMeetingData) {
            try {
                console.log('✅ Zoom 미팅 URL이 courses 테이블의 zoom_link 컬럼에 저장되었습니다.');
                console.log('   join_url:', zoomMeetingData.join_url);
            } catch (zoomDbError) {
                console.error('❌ Zoom 정보 저장 중 오류 (강의는 생성됨):', zoomDbError.message);
            }
        }

        await client.query('COMMIT');
        console.log('✅ Transaction committed successfully');

        res.json({
            success: true,
            message: 'Course created successfully',
            data: {
                course: result.rows[0],
                zoom_meeting: zoomMeetingData
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

/**
 * @swagger
 * /api/v1/admin/courses/{courseId}/materials/{weekNumber}/{fileName}/permission:
 *   put:
 *     summary: Update file download permission
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *       - in: path
 *         name: weekNumber
 *         required: true
 *       - in: path
 *         name: fileName
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isDownloadable:
 *                 type: boolean
 *     responses:
 *       '200':
 *         description: File permission updated successfully.
 */
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

/**
 * @swagger
 * /api/v1/admin/courses/create-zoom-session:
 *   post:
 *     summary: Create a Zoom session for a course
 *     tags: [Admin: Courses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionName:
 *                 type: string
 *               courseId:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Zoom session created successfully.
 */
// Admin: 사용자 친화적인 Zoom 세션 생성 API
router.post('/create-zoom-session', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const {
            // 기본 정보 (필수 항목)
            sessionName,          // 세션 이름
            courseId,             // 연결할 강의 ID
            
            // 간단한 형식 지원 (sessionName과 courseId 외 다른 파라미터가 없을 경우)
            simple,               // 간단한 요청 모드 (true/false)
            
            // 간편 모드에서도 설정 가능한 날짜/시간
            startDate,            // 시작 날짜 (YYYY-MM-DD)
            startTime,            // 시작 시간 (HH:MM)
            endTime,              // 종료 시간 (HH:MM)
            duration,             // 직접 지정한 강의 길이(분) - endTime 대신 사용 가능
            timezone = 'Asia/Seoul', // 시간대
            
            // 상세 설정 (선택 항목)
            // 반복 설정
            isRecurring,          // 반복 여부 (true/false)
            recurringType,        // 반복 유형 (daily, weekly, monthly, yearly)
            recurringInterval = 1,// 반복 간격 (1주에 한 번, 2주에 한 번 등)
            recurringDays = [],   // 반복 요일 (weekly인 경우) [0,1,2,3,4,5,6] (일~토)
            recurringDay,         // 반복 일자 (monthly인 경우) (1~31 또는 'last')
            recurringEndType,     // 반복 종료 유형 (after, until, never)
            recurringEndCount,    // 반복 횟수 (after 선택 시)
            recurringEndDate,     // 반복 종료 날짜 (until 선택 시)
            
            // 보안 설정
            passcode,             // 비밀번호
            enableWaitingRoom = true,  // 대기실 활성화
            requireAuthentication = false, // 인증 필요 여부
            
            // 추가 설정
            hostVideo = true,     // 호스트 비디오 자동 시작
            participantVideo = true, // 참가자 비디오 자동 시작
            muteUponEntry = true, // 입장 시 음소거
            autoRecording = 'cloud', // 자동 녹화 설정
            alternativeHosts = '' // 대체 호스트 이메일
        } = req.body;

        // 필수 정보 검증
        if (!sessionName) {
            return res.status(400).json({
                success: false,
                message: "세션 이름은 필수 항목입니다."
            });
        }
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: "강의 ID는 필수 항목입니다."
            });
        }
        
        // 간단한 요청 모드 처리
        const useSimpleMode = simple === true || (
            !isRecurring && 
            Object.keys(req.body).filter(key => !['sessionName', 'courseId', 'simple', 'startDate', 'startTime', 'endTime', 'duration'].includes(key)).length === 0
        );
        
        // 시작 시간 생성
        let startDateTime;
        let sessionDuration = duration || 120; // 기본 2시간
        
        // 날짜와 시간 처리
        if (startDate && startTime) {
            // 사용자가 지정한 날짜와 시간 사용
            const [startHour, startMinute] = startTime.split(':').map(Number);
            const [year, month, day] = startDate.split('-').map(Number);
            startDateTime = new Date(year, month - 1, day, startHour, startMinute);
            
            // 종료 시간이 지정된 경우 강의 길이 계산
            if (endTime && !duration) {
                const [endHour, endMinute] = endTime.split(':').map(Number);
                const endDateTime = new Date(year, month - 1, day, endHour, endMinute);
                // 종료 시간이 시작 시간보다 이전인 경우 다음날로 설정
                if (endDateTime <= startDateTime) {
                    endDateTime.setDate(endDateTime.getDate() + 1);
                }
                sessionDuration = Math.round((endDateTime - startDateTime) / (1000 * 60)); // 분 단위로 계산
            }
        } else {
            // 날짜 또는 시간이 지정되지 않은 경우 기본값 사용 (다음 화요일 오후 7시)
            startDateTime = new Date();
            startDateTime.setHours(19, 0, 0, 0);
            
            // 다음 화요일로 설정
            const currentDay = startDateTime.getDay();
            const daysUntilTuesday = (2 + 7 - currentDay) % 7;
            startDateTime.setDate(startDateTime.getDate() + daysUntilTuesday);
        }
        
        // 반복 설정 구성
        let recurrence = null;
        const useRecurring = useSimpleMode || isRecurring;
        
        if (useRecurring) {
            // 간단한 모드일 경우 기본 반복 설정 (매주 화요일, 3개월간)
            if (useSimpleMode) {
                const endDate = new Date(startDateTime);
                endDate.setMonth(endDate.getMonth() + 3);
                
                recurrence = {
                    type: 2, // 주간 반복
                    repeat_interval: 1, // 매주
                    weekly_days: "2", // 화요일(2)만 설정
                    end_date_time: endDate.toISOString() // 3개월 후 종료
                };
            } else {
                // 상세 모드일 경우 사용자 지정 반복 설정
                recurrence = {};
                
                // 반복 유형에 따른 설정
                switch (recurringType) {
                    case 'daily':
                        recurrence.type = 1;
                        break;
                    case 'weekly':
                        recurrence.type = 2;
                        // 요일 변환 (0-6 -> 1-7)
                        if (recurringDays && recurringDays.length > 0) {
                            recurrence.weekly_days = recurringDays
                                .map(day => (day % 7) + 1)
                                .join(',');
                        } else {
                            // 요일이 지정되지 않은 경우 시작 날짜의 요일 사용
                            recurrence.weekly_days = (startDateTime.getDay() + 1).toString();
                        }
                        break;
                    case 'monthly':
                        recurrence.type = 3;
                        if (recurringDay === 'last') {
                            recurrence.monthly_week = -1;
                            recurrence.monthly_week_day = startDateTime.getDay() + 1;
                        } else if (isNaN(recurringDay)) {
                            const parts = recurringDay?.match(/(\d+)(?:st|nd|rd|th) ([A-Za-z]+)/);
                            if (parts) {
                                const weekNum = parseInt(parts[1]);
                                const dayName = parts[2].toLowerCase();
                                const dayMap = {sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7};
                                recurrence.monthly_week = weekNum;
                                recurrence.monthly_week_day = dayMap[dayName] || 1;
                            } else {
                                // 기본값: 매월 시작일과 같은 날
                                recurrence.monthly_day = startDateTime.getDate();
                            }
                        } else {
                            // 매월 특정 일자
                            recurrence.monthly_day = parseInt(recurringDay);
                        }
                        break;
                    case 'yearly':
                        // Zoom API에서는 yearly가 별도로 없어 monthly를 12개월 간격으로 설정
                        recurrence.type = 3;
                        recurrence.repeat_interval = 12;
                        recurrence.monthly_day = startDateTime.getDate();
                        break;
                    default:
                        // 기본값: 주간 반복
                        recurrence.type = 2;
                        recurrence.weekly_days = (startDateTime.getDay() + 1).toString();
                }
                
                // 반복 간격 설정
                recurrence.repeat_interval = recurringInterval;
                
                // 종료 조건 설정
                switch (recurringEndType) {
                    case 'after':
                        if (recurringEndCount) {
                            recurrence.end_times = parseInt(recurringEndCount);
                        } else {
                            // 기본값: 12회
                            recurrence.end_times = 12;
                        }
                        break;
                    case 'until':
                        if (recurringEndDate) {
                            const endDate = new Date(recurringEndDate);
                            endDate.setHours(23, 59, 59);
                            recurrence.end_date_time = endDate.toISOString();
                        } else {
                            // 기본값: 3개월 후
                            const endDate = new Date(startDateTime);
                            endDate.setMonth(endDate.getMonth() + 3);
                            recurrence.end_date_time = endDate.toISOString();
                        }
                        break;
                    case 'never':
                    default:
                        // 기본값: 3개월 후 종료
                        const endDate = new Date(startDateTime);
                        endDate.setMonth(endDate.getMonth() + 3);
                        recurrence.end_date_time = endDate.toISOString();
                }
            }
        }
        
        // Zoom 미팅 설정
        const meetingSettings = {
            topic: sessionName,
            type: useRecurring ? 8 : 2, // 8: 반복 미팅, 2: 예약 미팅
            start_time: startDateTime.toISOString(),
            duration: sessionDuration,
            timezone,
            settings: {
                host_video: hostVideo,
                participant_video: participantVideo,
                mute_upon_entry: muteUponEntry,
                auto_recording: autoRecording,
                waiting_room: enableWaitingRoom,
                meeting_authentication: requireAuthentication
            }
        };
        
        // 선택적 설정 추가
        if (recurrence) {
            meetingSettings.recurrence = recurrence;
        }
        
        if (passcode) {
            meetingSettings.password = passcode;
        } else if (useSimpleMode) {
            // 간단 모드에서는 자동으로 비밀번호 생성 (6자리 숫자)
            meetingSettings.password = Math.floor(100000 + Math.random() * 900000).toString();
        }
        
        if (alternativeHosts) {
            meetingSettings.settings.alternative_hosts = alternativeHosts;
        }
        
        // Zoom 미팅 생성
        console.log('\n[Zoom 미팅 생성 시작]');
        console.log('프론트엔드에서 전달받은 데이터:', JSON.stringify({
            sessionName,
            zoom_session
        }, null, 2));

        if (zoom_session) {
            try {
                // 시작 시간 파싱
                let startDateTime = null;
                
                if (zoom_session.start_date && zoom_session.start_time) {
                    const dateStr = zoom_session.start_date; // YYYY-MM-DD
                    const timeStr = zoom_session.start_time; // HH:MM
                    startDateTime = new Date(`${dateStr}T${timeStr}:00Z`);
                    
                    // 한국 시간대로 보정 (UTC+9)
                    const koreaOffset = 9 * 60; // 9시간을 분 단위로
                    const utcMinutes = startDateTime.getUTCHours() * 60 + startDateTime.getUTCMinutes();
                    startDateTime.setUTCMinutes(utcMinutes - koreaOffset);
                    
                    console.log('▶ 시작 시간 파싱 결과:');
                    console.log(`  원본 데이터: date=${dateStr}, time=${timeStr} (한국 시간)`);
                    console.log(`  ISO 문자열 (UTC): ${startDateTime.toISOString()}`);
                    console.log(`  로컬 시간: ${startDateTime.toString()}`);
                    console.log(`  한국 시간: ${new Date(startDateTime.getTime()).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'})}`);
                } else {
                    console.log('▶ 시작 시간 정보가 없습니다.');
                }
                
                // 세션 기간 (분)
                const sessionDuration = zoom_session.duration || 60;
                console.log(`▶ 세션 기간: ${sessionDuration}분`);
                
                // 반복 설정
                console.log(`▶ 반복 설정: ${JSON.stringify(zoom_session.recurrence || {})}`);
                
                // Zoom 미팅 생성 - 프론트엔드에서 전달받은 데이터 그대로 사용
                console.log('▶ Zoom 미팅 생성 함수 호출:');
                const meetingResult = await createZoomMeeting(
                    sessionName,
                    startDateTime,
                    sessionDuration,
                    zoom_session.recurrence,
                    zoom_session
                );
                
                console.log('▶ Zoom 미팅 생성 결과:');
                console.log(JSON.stringify(meetingResult, null, 2));
                
                if (meetingResult.success) {
                    // 생성된 Zoom 미팅 정보 DB에 저장
                    console.log('▶ Zoom 미팅 정보 DB 저장 시작');
                    
                    await client.query(`
                        INSERT INTO ${SCHEMAS.COURSE}.zoom_meetings
                        (id, course_id, topic, start_time, duration, zoom_meeting_id, zoom_join_url, zoom_password, recurrence, settings)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    `, [
                        crypto.randomUUID(),
                        courseId,
                        sessionName,
                        startDateTime || new Date(),
                        sessionDuration,
                        meetingResult.meeting_id,
                        meetingResult.join_url,
                        meetingResult.password,
                        JSON.stringify(zoom_session.recurrence || null),
                        JSON.stringify(zoom_session.settings || {})
                    ]);
                    
                    console.log('▶ Zoom 미팅 정보 DB 저장 완료');
                    
                    // 응답에 Zoom 정보 추가
                    courseData.zoom_meeting = {
                        meeting_id: meetingResult.meeting_id,
                        join_url: meetingResult.join_url,
                        password: meetingResult.password,
                        start_time: meetingResult.start_time,
                        duration: meetingResult.duration
                    };
                } else {
                    console.error('❌ Zoom 미팅 생성 실패:', meetingResult.error);
                }
            } catch (zoomError) {
                console.error('❌ Zoom 미팅 생성 중 오류 발생:', zoomError);
                // Zoom 미팅 생성 실패는 과정 생성에 영향을 주지 않음
            }
        } else {
            console.log('▶ Zoom 미팅 정보가 제공되지 않았습니다. Zoom 미팅을 생성하지 않습니다.');
        }
        console.log('[Zoom 미팅 생성 완료]\n');
        
        // 강의에 Zoom 링크 연결
        const client = await masterPool.connect();
        try {
            await client.query('BEGIN');

            // 강의 존재 여부 확인
            const courseResult = await client.query(`
                SELECT id FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
                WHERE id = $1
            `, [courseId]);
            
            if (courseResult.rows.length === 0) {
                throw new Error('강의를 찾을 수 없습니다.');
            }
            
            // Zoom 링크 업데이트
            await client.query(`
                UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
                SET zoom_link = $1
                WHERE id = $2
            `, [meetingResult.join_url, courseId]);
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('강의 Zoom 링크 업데이트 오류:', error);

            // 강의 업데이트 실패해도 Zoom 미팅 생성은 성공한 것으로 처리
            return res.json({
                success: true,
                warning: "Zoom 세션은 생성되었으나 강의 정보 업데이트에 실패했습니다: " + error.message,
                data: {
                    meeting: {
                        id: meetingResult.meeting_id,
                        join_url: meetingResult.join_url,
                        password: meetingResult.password,
                        start_time: meetingResult.start_time,
                        duration: meetingResult.duration,
                        recurrence: meetingResult.recurrence
                    }
                }
            });
        } finally {
            client.release();
        }
        
        // 응답
        res.json({
            success: true,
            message: "Zoom 세션이 성공적으로 생성되었습니다.",
                data: {
                meeting: {
                    id: meetingResult.meeting_id,
                    join_url: meetingResult.join_url,
                    password: meetingResult.password,
                    start_time: meetingResult.start_time,
                    duration: sessionDuration,
                    recurrence: meetingResult.recurrence
                },
                course_updated: true,
                simple_mode: useSimpleMode,
                scheduled_time: {
                    date: startDateTime.toISOString().split('T')[0],
                    time: `${startDateTime.getHours().toString().padStart(2, '0')}:${startDateTime.getMinutes().toString().padStart(2, '0')}`,
                    duration: sessionDuration
                }
                }
        });
    } catch (error) {
        console.error('Zoom 세션 생성 오류:', error);
        res.status(500).json({
            success: false,
            message: "Zoom 세션 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

module.exports = router;