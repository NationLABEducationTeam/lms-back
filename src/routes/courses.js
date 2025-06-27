const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../config/database');
const { 
    listCourseWeekMaterials, 
    createEmptyFolder
} = require('../utils/s3');
const { HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/s3');
const { transliterate } = require('transliteration');
const { getStudentGrades } = require('../utils/grade-calculator');

const TABLE_NAME = 'nationslab-courses';

/**
 * @swagger
 * tags:
 *   - name: Courses (Public)
 *     description: APIs for public access to course information
 *   - name: Courses (Student)
 *     description: APIs for students to interact with courses
 *   - name: Courses (Admin)
 *     description: APIs for course administration
 */

// Test database connection (using master)
router.get('/test-db', async (req, res) => {
    console.log('Attempting to test database connection...');
    try {
        const client = await masterPool.connect();
        if (client) {
            res.json({
                message: 'Database connection successful',
                connected: true
            });
            client.release();
        }
    } catch (error) {
        console.error('Database connection test failed:', error);
        res.status(500).json({
            message: 'Database connection failed',
            error: error.message,
            connected: false
        });
    }
});

// Public routes - Get all published courses
/**
 * @swagger
 * /api/v1/courses/public:
 *   get:
 *     summary: Get all published courses
 *     tags: [Courses (Public)]
 *     description: Retrieves a list of all courses that are marked as public. No authentication required.
 *     responses:
 *       '200':
 *         description: A list of public courses.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     courses:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Course'
 *                     total:
 *                       type: integer
 */
router.get('/public', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*,
                u.given_name as instructor_name,
                c.classmode
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            ORDER BY c.created_at DESC
        `;

        const result = await getPool('read').query(query);
        
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

/**
 * @swagger
 * /api/v1/courses/public/{courseId}:
 *   get:
 *     summary: Get a specific public course by ID
 *     tags: [Courses (Public)]
 *     description: Retrieves detailed information for a single public course. No authentication required.
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         description: ID of the course to retrieve.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Detailed course information.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     course:
 *                       $ref: '#/components/schemas/Course'
 *       '404':
 *         description: Course not found.
 */
router.get('/public/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const query = `
            SELECT 
                c.*,
                u.given_name as instructor_name,
                u.cognito_user_id as instructor_id,
                c.classmode
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
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

router.get('/', async (req, res) => {
    try {
        const pool = getPool('read');
        const query = `
            SELECT 
                c.*,
                u.given_name as instructor_name
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

// Get specific course
/**
 * @swagger
 * /api/v1/courses/{courseId}:
 *   get:
 *     summary: Get a specific course by ID (Admin)
 *     tags: [Courses (Admin)]
 *     description: Retrieves detailed information for a single course. Requires ADMIN role.
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
 *         description: Detailed course information.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     course:
 *                       $ref: '#/components/schemas/Course'
 *       '401':
 *         description: Unauthorized.
 *       '403':
 *         description: Forbidden.
 *       '404':
 *         description: Course not found.
 */
router.get('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const query = `
            SELECT 
                c.*,
                u.given_name as instructor_name,
                u.cognito_user_id as instructor_id,
                c.classmode,
                c.zoom_link
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
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
        
        await getPool('write').query(
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
        const [progress] = await getPool('read').query(
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

// Create course - Using Master DB
// router.post('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
//     const client = await masterPool.connect();
//     try {
//         await client.query('BEGIN');

//         console.log('Request body:', req.body);

//         const { 
//             title, 
//             description, 
//             instructor_id,
//             main_category_id,
//             sub_category_id,
//             thumbnail_url,
//             price,
//             level,
//             classmode,
//             zoom_link
//         } = req.body;

//         // Validate required fields
//         if (!title || !description || !instructor_id || !main_category_id || !sub_category_id || !classmode) {
//             console.log('Missing fields:', {
//                 title: !!title,
//                 description: !!description,
//                 instructor_id: !!instructor_id,
//                 main_category_id: !!main_category_id,
//                 sub_category_id: !!sub_category_id,
//                 classmode: !!classmode
//             });
//             throw new Error('Missing required fields');
//         }

//         // Validate classmode
//         if (!['ONLINE', 'VOD'].includes(classmode.toUpperCase())) {
//             throw new Error('Invalid classmode. Must be either ONLINE or VOD');
//         }

//         // Create the course
//         const query = `
//             INSERT INTO ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
//             (
//                 title,
//                 description, 
//                 instructor_id,
//                 main_category_id,
//                 sub_category_id,
//                 thumbnail_url,
//                 price,
//                 level,
//                 classmode,
//                 zoom_link,
//                 coursebucket
//             )
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
//             RETURNING *
//         `;

//         // 임시로 빈 값 설정 (나중에 업데이트)
//         const tempCoursebucket = 'nationslablmscoursebucket';

//         const values = [
//             title,
//             description,
//             instructor_id,
//             main_category_id,
//             sub_category_id,
//             thumbnail_url,
//             price,
//             level,
//             classmode.toUpperCase(),
//             zoom_link,
//             tempCoursebucket
//         ];

//         const result = await client.query(query, values);
//         const courseId = result.rows[0].id;
        
//         // 이제 courseId를 알았으니 실제 폴더 경로 생성
//         const folderPath = classmode.toUpperCase() === 'VOD' ? `vod/${courseId}/` : `${courseId}/`;
        
//         // coursebucket 업데이트
//         const updateQuery = `
//             UPDATE ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
//             SET coursebucket = $1
//             WHERE id = $2
//         `;
//         await client.query(updateQuery, [`nationslablmscoursebucket/${folderPath}`, courseId]);
        
//         // S3에 폴더 생성
//         await createEmptyFolder(folderPath);
        
//         await client.query('COMMIT');

//         res.status(201).json({ 
//             success: true,
//             message: 'Course created successfully',
//             data: {
//                 course: result.rows[0]
//             }
//         });
//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error('Error creating course:', error);
//         res.status(500).json({ 
//             success: false,
//             message: 'Failed to create course',
//             error: error.message 
//         });
//     } finally {
//         client.release();
//     }
// });


// 강의 수정 기능
// router.put('/:courseId', verifyToken, requireRole(['INSTRUCTOR', 'ADMIN']), async (req, res) => {
//     try {
//         const { courseId } = req.params;
//         const { title, description, is_public } = req.body;
        
//         await getPool('write').query(
//             'UPDATE courses SET title = ?, description = ?, is_public = ? WHERE id = ?',
//             [title, description, is_public, courseId]
//         );
        
//         res.json({ message: 'Course updated', courseId });
//     } catch (error) {
//         console.error('Error updating course:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// Get enrolled courses for a student
/**
 * @swagger
 * /api/v1/courses/enrolled/{studentId}:
 *   get:
 *     summary: Get courses enrolled by a student
 *     tags: [Courses (Student)]
 *     description: Retrieves a list of courses a specific student is enrolled in, including weekly materials.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: A list of enrolled courses with materials.
 *       '403':
 *         description: Permission denied.
 */
router.get('/enrolled/:studentId', verifyToken, async (req, res) => {
    console.log("--- DEBUG START: /enrolled/:studentId ---");
    console.log("Current AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID);
    console.log("Current AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY ? "Exists" : "Not Found");
    console.log("Current AWS_REGION:", process.env.AWS_REGION);
    try {
        const s3Credentials = await s3Client.config.credentials();
        console.log("S3 Client Credentials Source:", s3Credentials.credentialScope);
        console.log("S3 Client Access Key ID:", s3Credentials.accessKeyId);
    } catch (e) {
        console.log("Could not get S3 client credentials:", e.message);
    }
    console.log("--- DEBUG END ---");

    try {
        const { studentId } = req.params;
        
        if (req.user.sub !== studentId && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const pool = getPool('read');
        const query = `
            SELECT 
                c.*,
                u.given_name as instructor_name,
                e.enrolled_at,
                e.status as enrollment_status,
                pt.progress_status,
                pt.last_accessed_at,
                c.classmode,
                e.id as enrollment_id
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON c.instructor_id = u.cognito_user_id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [studentId]);

        // S3에서 각 강좌의 주차 자료 조회
        const coursesWithMaterials = await Promise.all(result.rows.map(async (course) => {
            // courseId를 prefix로 사용
            const coursePrefix = `${course.id}/`;
            console.log('Fetching materials for course:', coursePrefix);  // 디버깅용
            
            // 수강 상태가 DROPPED인 경우 자료 접근 막기
            if (course.enrollment_status === 'DROPPED') {
                console.log('Course access blocked for DROPPED enrollment:', course.id);
                return {
                    ...course,
                    accessBlocked: true,
                    blockReason: '수강이 정지된 강의입니다. 관리자에게 문의하세요.',
                    weeks: []
                };
            }
            
            const weeklyMaterials = await listCourseWeekMaterials(coursePrefix, 'STUDENT');
            
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
                            streamingUrl: file.streamingUrl,  // 스트리밍 URL 추가
                            downloadable: file.downloadable,
                            lastModified: file.lastModified,
                            size: file.size,
                            type: file.type,
                            isHlsFile: file.isHlsFile
                        });
                        return acc;
                    }, {})
                }));

            return {
                ...course,
                accessBlocked: false,
                weeks: weeks
            };
        }));

        res.json({
            success: true,
            data: {
                courses: coursesWithMaterials,
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
/**
 * @swagger
 * /api/v1/courses/{courseId}/students:
 *   get:
 *     summary: Get enrolled students for a course (Admin)
 *     tags: [Courses (Admin)]
 *     description: Retrieves a list of all students enrolled in a specific course. Requires ADMIN role.
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
 *         description: A list of enrolled students.
 *       '403':
 *         description: Permission denied.
 */
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
                u.given_name,
                u.email,
                e.status as enrollment_status,
                e.enrolled_at as enrollment_date,
                e.updated_at as last_updated,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date,
                c.title as course_title,
                c.description as course_description,
                c.main_category_id,
                c.sub_category_id
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON e.student_id = u.cognito_user_id
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.course_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await getPool('read').query(query, [courseId]);

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

// Get all student enrollments (Admin only) - Using Read Replica
router.get('/admin/enrollments/all', verifyToken, async (req, res) => {
    try {
        // TODO: 관리자의 경우 극소수이기 때문에 나중에는 하드 코딩 또는 환경변수로 저장 후 비교
        const adminId = 'f4282d3c-7061-700d-e22e-e236e6288087';
        if (req.user.sub !== adminId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only authorized admin can access this resource.'
            });
        }

        const pool = getPool('read');
        const query = `
            SELECT 
                u.cognito_user_id,
                u.given_name as student_name,
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
                        'main_category_id', c.main_category_id,
                        'sub_category_id', c.sub_category_id
                    ) ORDER BY e.enrolled_at DESC
                ) as enrolled_courses
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
                ON u.cognito_user_id = e.student_id
            LEFT JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE u.role = 'STUDENT'
            GROUP BY 
                u.cognito_user_id,
                u.given_name,
                u.email
            ORDER BY u.given_name
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

// 파일 타입 매핑 함수 수정
function getFileType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    const typeMap = {
        pdf: 'document',
        doc: 'document',
        docx: 'document',
        ppt: 'presentation',
        pptx: 'presentation',
        xls: 'spreadsheet',
        xlsx: 'spreadsheet',
        txt: 'text',
        json: 'json',
        jpg: 'image',
        jpeg: 'image',
        png: 'image',
        gif: 'image',
        mp4: 'video',
        m3u8: 'video',  // m3u8 파일을 video 타입으로 처리
        ts: 'video',    // ts 파일도 video 타입으로 처리
        mp3: 'audio',
        zip: 'archive',
        rar: 'archive'
    };
    return typeMap[extension] || 'unknown';
}

/**
 * @swagger
 * /api/v1/courses/{courseId}/my-grades:
 *   get:
 *     summary: Get my grades for a specific course
 *     tags: [Courses (Student)]
 *     description: Retrieves the current student's grades for a specific course, including attendance, assignments, and exams.
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
 *         description: Detailed grade information for the course.
 *       '404':
 *         description: Course information not found.
 */
router.get('/:courseId/my-grades', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기 
        const studentId = req.user.sub;
        const { courseId } = req.params;
        
        console.log(`[DEBUG] 성적 조회: studentId=${studentId}, courseId=${courseId}`);
        
        // 학생 등록 여부 확인 (디버깅)
        const enrollmentCheck = await client.query(`
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.enrollments 
            WHERE student_id = $1 AND course_id = $2
        `, [studentId, courseId]);
        
        console.log(`[DEBUG] 학생 등록 정보:`, JSON.stringify(enrollmentCheck.rows));
        
        // 과제 항목 확인 (디버깅)
        const assignmentCheck = await client.query(`
            SELECT * FROM ${SCHEMAS.GRADE}.grade_items 
            WHERE course_id = $1 AND item_type = 'ASSIGNMENT'
        `, [courseId]);
        
        console.log(`[DEBUG] 과제 항목:`, JSON.stringify(assignmentCheck.rows));
        
        // 최적화된 성적 조회 함수 사용
        const gradeInfo = await getStudentGrades(client, courseId, studentId);
        
        console.log(`[DEBUG] 성적 조회 결과:`, JSON.stringify(gradeInfo));
        
        if (!gradeInfo) {
            return res.status(404).json({
                success: false,
                message: "과목 정보를 찾을 수 없습니다."
            });
        }
        
        res.json({
            success: true,
            data: gradeInfo
        });
    } catch (error) {
        console.error('Error fetching grades:', error);
        res.status(500).json({
            success: false,
            message: "성적 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 