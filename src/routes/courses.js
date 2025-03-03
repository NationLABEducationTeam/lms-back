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

const TABLE_NAME = 'nationslab-courses';

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
router.get('/public', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*,
                u.name as instructor_name,
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



router.get('/public/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const query = `
            SELECT 
                c.*,
                u.name as instructor_name,
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




// Get specific course
router.get('/:courseId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
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
router.get('/enrolled/:studentId', verifyToken, async (req, res) => {
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
                u.name as instructor_name,
                e.enrolled_at,
                e.status as enrollment_status,
                pt.progress_status,
                pt.last_accessed_at,
                c.classmode
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

// 학생 성적 조회
router.get('/:courseId/my-grades', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    
    try {
        const { courseId } = req.params;
        const studentId = req.user.sub;  // cognito user id from JWT token

        // 수강 여부 확인
        const enrollmentCheck = await client.query(`
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE course_id = $1 AND student_id = $2 AND status = 'ACTIVE'
        `, [courseId, studentId]);

        if (enrollmentCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: '수강 중인 과목이 아닙니다.'
            });
        }

        // 과목 정보와 성적 항목 조회
        const result = await client.query(`
            WITH grade_info AS (
                SELECT 
                    gi.type,
                    gi.title,
                    gi.max_score,
                    sg.score
                FROM ${SCHEMAS.GRADE}.grade_items gi
                LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                    ON gi.id = sg.grade_item_id 
                    AND sg.student_id = $1
                WHERE gi.course_id = $2
            )
            SELECT 
                c.title as course_title,
                c.attendance_weight,
                c.assignment_weight,
                c.exam_weight,
                (
                    SELECT json_agg(row_to_json(g))
                    FROM (
                        SELECT type, title, max_score, score
                        FROM grade_info
                        WHERE type = 'ASSIGNMENT'
                    ) g
                ) as assignments,
                (
                    SELECT json_agg(row_to_json(g))
                    FROM (
                        SELECT type, title, max_score, score
                        FROM grade_info
                        WHERE type = 'EXAM'
                    ) g
                ) as exams,
                (
                    SELECT COALESCE(AVG(CASE WHEN ar.total_duration_seconds > 0 
                        THEN (ar.duration_seconds::float / ar.total_duration_seconds) * 100 
                        ELSE 0 END), 0)
                    FROM ${SCHEMAS.GRADE}.attendance_records ar
                    WHERE ar.course_id = $2 AND ar.student_id = $1
                ) as attendance_rate
            FROM ${SCHEMAS.COURSE}.courses c
            WHERE c.id = $2
        `, [studentId, courseId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과목 정보를 찾을 수 없습니다."
            });
        }

        const courseInfo = result.rows[0];

        res.json({
            success: true,
            data: {
                course: {
                    title: courseInfo.course_title,
                    attendance_weight: courseInfo.attendance_weight,
                    assignment_weight: courseInfo.assignment_weight,
                    exam_weight: courseInfo.exam_weight
                },
                grades: {
                    attendance: {
                        rate: parseFloat(courseInfo.attendance_rate.toFixed(1)),
                        score: parseFloat(((courseInfo.attendance_rate * courseInfo.attendance_weight) / 100).toFixed(1))
                    },
                    assignments: courseInfo.assignments || [],
                    exams: courseInfo.exams || []
                }
            }
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