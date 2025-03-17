const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { masterPool, SCHEMAS } = require('../config/database');
const { s3Client } = require('../config/s3');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/**
 * @api {get} /api/v1/assignments/my 내 모든 과제/퀴즈 목록 조회
 * @apiDescription 로그인한 학생이 수강 중인 모든 과목의 과제/퀴즈 목록을 조회합니다.
 * @apiName GetMyAssignments
 * @apiGroup Assignments
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data 과제/퀴즈 목록
 */
router.get('/my', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기
        const studentId = req.user.sub;
        
        console.log(`[DEBUG] 과제 목록 조회: studentId=${studentId}`);
        
        // 학생이 수강 중인 모든 과목의 과제/퀴즈 목록 조회
        const result = await client.query(`
            WITH my_enrollments AS (
                SELECT e.id AS enrollment_id, e.course_id
                FROM ${SCHEMAS.ENROLLMENT}.enrollments e
                WHERE e.student_id = $1 AND e.status = 'ACTIVE'
            )
            SELECT 
                gi.item_id,
                gi.item_type,
                gi.item_name AS title,
                gi.due_date,
                c.id AS course_id,
                c.title AS course_title,
                c.thumbnail_url,
                COALESCE(sg.score, 0) AS score,
                COALESCE(sg.is_completed, false) AS is_completed,
                CASE 
                    WHEN gi.due_date < NOW() THEN '마감됨'
                    WHEN COALESCE(sg.is_completed, false) THEN '제출완료' 
                    ELSE '진행중' 
                END AS status
            FROM my_enrollments me
            JOIN ${SCHEMAS.COURSE}.courses c ON me.course_id = c.id
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON me.course_id = gi.course_id
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = me.enrollment_id
            ORDER BY gi.due_date ASC, c.title ASC
        `, [studentId]);
        
        console.log(`[DEBUG] 과제 검색 결과: ${result.rows.length}개 항목 찾음`);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching my assignments:', error);
        res.status(500).json({
            success: false,
            message: "과제/퀴즈 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {get} /api/v1/assignments/course/:courseId 특정 과목의 과제/퀴즈 목록 조회
 * @apiDescription 특정 과목의 과제/퀴즈 목록을 조회합니다.
 * @apiName GetCourseAssignments
 * @apiGroup Assignments
 * @apiParam {String} courseId 과목 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data 과제/퀴즈 목록
 */
router.get('/course/:courseId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기
        const studentId = req.user.sub;
        const { courseId } = req.params;
        
        // 학생이 해당 과목을 수강 중인지 확인
        const enrollmentCheck = await client.query(`
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.enrollments
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `, [studentId, courseId]);
        
        if (enrollmentCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "수강 중인 과목이 아닙니다."
            });
        }
        
        const enrollmentId = enrollmentCheck.rows[0].id;
        
        // 과목의 과제/퀴즈 목록 조회
        const result = await client.query(`
            SELECT 
                gi.item_id,
                gi.item_type,
                gi.item_name AS title,
                gi.due_date,
                c.title AS course_title,
                COALESCE(sg.score, 0) AS score,
                COALESCE(sg.is_completed, false) AS is_completed,
                CASE 
                    WHEN gi.due_date < NOW() THEN '마감됨'
                    WHEN COALESCE(sg.is_completed, false) THEN '제출완료' 
                    ELSE '진행중' 
                END AS status
            FROM ${SCHEMAS.COURSE}.courses c
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON c.id = gi.course_id
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = $1
            WHERE gi.course_id = $2
            ORDER BY gi.due_date ASC
        `, [enrollmentId, courseId]);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching course assignments:', error);
        res.status(500).json({
            success: false,
            message: "과제/퀴즈 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {get} /api/v1/assignments/:assignmentId 특정 과제/퀴즈 상세 정보 조회
 * @apiDescription 특정 과제/퀴즈의 상세 정보를 조회합니다.
 * @apiName GetAssignmentDetail
 * @apiGroup Assignments
 * @apiParam {Number} assignmentId 과제/퀴즈 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data 과제/퀴즈 상세 정보
 */
router.get('/:assignmentId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기
        const studentId = req.user.sub;
        const { assignmentId } = req.params;
        
        // 학생이 해당 과제/퀴즈가 속한 과목을 수강 중인지 확인
        const enrollmentCheck = await client.query(`
            SELECT e.id AS enrollment_id 
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON e.course_id = gi.course_id
            WHERE e.student_id = $1 AND gi.item_id = $2 AND e.status = 'ACTIVE'
        `, [studentId, assignmentId]);
        
        if (enrollmentCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "해당 과제/퀴즈에 접근할 권한이 없습니다."
            });
        }
        
        const enrollmentId = enrollmentCheck.rows[0].enrollment_id;
        
        // 과제/퀴즈 상세 정보 조회
        const result = await client.query(`
            SELECT 
                gi.item_id,
                gi.item_type,
                gi.item_name AS title,
                gi.due_date,
                c.id AS course_id,
                c.title AS course_title,
                COALESCE(sg.score, 0) AS score,
                COALESCE(sg.is_completed, false) AS is_completed,
                COALESCE(sg.submission_data, '{}') AS submission_data,
                COALESCE(sg.feedback, '') AS feedback,
                sg.submission_date,
                CASE 
                    WHEN gi.due_date < NOW() THEN '마감됨'
                    WHEN COALESCE(sg.is_completed, false) THEN '제출완료' 
                    ELSE '진행중' 
                END AS status
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = $1
            WHERE gi.item_id = $2
        `, [enrollmentId, assignmentId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과제/퀴즈를 찾을 수 없습니다."
            });
        }
        
        // 과제/퀴즈 관련 파일 목록 조회 (추후 구현)
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching assignment detail:', error);
        res.status(500).json({
            success: false,
            message: "과제/퀴즈 상세 정보 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {post} /api/v1/assignments/:assignmentId/submit 과제/퀴즈 제출
 * @apiDescription 과제 또는 퀴즈를 제출합니다.
 * @apiName SubmitAssignment
 * @apiGroup Assignments
 * @apiParam {Number} assignmentId 과제/퀴즈 ID
 * @apiParam {Object} submission_data 제출 데이터 (과제: 설명, 파일 목록, 퀴즈: 응답 내용)
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data 제출 결과
 */
router.post('/:assignmentId/submit', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기
        const studentId = req.user.sub;
        const { assignmentId } = req.params;
        const { submission_data } = req.body;
        
        if (!submission_data) {
            return res.status(400).json({
                success: false, 
                message: "제출 데이터가 없습니다."
            });
        }
        
        // 학생이 해당 과제/퀴즈가 속한 과목을 수강 중인지 확인
        const enrollmentCheck = await client.query(`
            SELECT e.id AS enrollment_id, gi.item_type, gi.due_date
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON e.course_id = gi.course_id
            WHERE e.student_id = $1 AND gi.item_id = $2 AND e.status = 'ACTIVE'
        `, [studentId, assignmentId]);
        
        if (enrollmentCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "해당 과제/퀴즈에 접근할 권한이 없습니다."
            });
        }
        
        const enrollmentId = enrollmentCheck.rows[0].enrollment_id;
        const itemType = enrollmentCheck.rows[0].item_type;
        const dueDate = new Date(enrollmentCheck.rows[0].due_date);
        
        // 마감일 확인
        const now = new Date();
        if (now > dueDate) {
            return res.status(400).json({
                success: false,
                message: "제출 기한이 지났습니다."
            });
        }
        
        // 이미 제출했는지 확인
        const existingSubmission = await client.query(`
            SELECT grade_id, is_completed, score 
            FROM ${SCHEMAS.GRADE}.student_grades
            WHERE enrollment_id = $1 AND item_id::text = $2::text
        `, [enrollmentId, assignmentId]);
        
        let gradeId;
        let initialScore = 0;
        
        await client.query('BEGIN');
        
        if (existingSubmission.rows.length > 0) {
            // 기존 제출 내용 업데이트
            gradeId = existingSubmission.rows[0].grade_id;
            
            // 이미 채점된 경우 점수 유지
            initialScore = existingSubmission.rows[0].score || 0;
            
            await client.query(`
                UPDATE ${SCHEMAS.GRADE}.student_grades
                SET submission_data = $1,
                    is_completed = true,
                    submission_date = NOW(),
                    updated_at = NOW()
                WHERE grade_id = $2
            `, [submission_data, gradeId]);
        } else {
            // 새로운 제출 생성
            const insertResult = await client.query(`
                INSERT INTO ${SCHEMAS.GRADE}.student_grades
                (enrollment_id, item_id, score, is_completed, submission_date, submission_data)
                VALUES ($1, $2, $3, true, NOW(), $4)
                RETURNING grade_id
            `, [enrollmentId, assignmentId, initialScore, submission_data]);
            
            gradeId = insertResult.rows[0].grade_id;
        }
        
        // 퀴즈인 경우 자동 채점 (추후 구현)
        let finalScore = initialScore;
        if (itemType === 'QUIZ') {
            // TODO: 퀴즈 자동 채점 로직
            // finalScore = calculateQuizScore(submission_data);
            
            // await client.query(`
            //     UPDATE ${SCHEMAS.GRADE}.student_grades
            //     SET score = $1
            //     WHERE grade_id = $2
            // `, [finalScore, gradeId]);
        }
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: "과제/퀴즈가 성공적으로 제출되었습니다.",
            data: {
                grade_id: gradeId,
                is_completed: true,
                score: finalScore
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting assignment:', error);
        res.status(500).json({
            success: false,
            message: "과제/퀴즈 제출 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {post} /api/v1/assignments/:assignmentId/upload-urls 과제 파일 업로드 URL 요청
 * @apiDescription 과제 파일 업로드를 위한 S3 Presigned URL을 생성합니다.
 * @apiName GetUploadUrls
 * @apiGroup Assignments
 * @apiParam {Number} assignmentId 과제 ID
 * @apiParam {Object[]} files 업로드할 파일 정보 (파일 이름, 타입)
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data 업로드 URL 목록
 */
router.post('/:assignmentId/upload-urls', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        // JWT의 sub 필드에서 사용자 ID 가져오기
        const studentId = req.user.sub;
        const { assignmentId } = req.params;
        const { files } = req.body;
        
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: "업로드할 파일 정보가 없습니다."
            });
        }
        
        // 학생이 해당 과제가 속한 과목을 수강 중인지 확인
        const courseCheck = await client.query(`
            SELECT c.id AS course_id
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON e.course_id = gi.course_id
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            WHERE e.student_id = $1 AND gi.item_id = $2 AND e.status = 'ACTIVE'
        `, [studentId, assignmentId]);
        
        if (courseCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "해당 과제에 접근할 권한이 없습니다."
            });
        }
        
        const courseId = courseCheck.rows[0].course_id;
        const bucketName = process.env.S3_BUCKET_NAME || 'nationslablmscoursebucket';
        
        // 각 파일에 대한 Presigned URL 생성
        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const fileName = `${courseId}/assignments/${assignmentId}/${studentId}/${file.name}`;
                const command = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: fileName,
                    ContentType: file.type
                });
                
                const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                
                return {
                    fileName: file.name,
                    uploadUrl,
                    fileKey: fileName
                };
            })
        );
        
        res.json({
            success: true,
            data: presignedUrls
        });
    } catch (error) {
        console.error('Error generating upload URLs:', error);
        res.status(500).json({
            success: false,
            message: "업로드 URL 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 