const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { s3Client } = require('../../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/**
 * @swagger
 * tags:
 *   - name: Admin: Assignments
 *     description: Assignment and submission management APIs for administrators
 */

/**
 * @swagger
 * /api/v1/admin/assignments/course/{courseId}:
 *   get:
 *     summary: Get all assignments for a course
 *     tags: [Admin: Assignments]
 *     description: Retrieves a list of all assignments for a specific course, including submission statistics.
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
 *         description: A list of assignments with statistics.
 */
router.get('/course/:courseId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;
        
        // 과목 존재 여부 확인
        const courseCheck = await client.query(`
            SELECT id FROM ${SCHEMAS.COURSE}.courses WHERE id = $1
        `, [courseId]);
        
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과목을 찾을 수 없습니다."
            });
        }
        
        // 과목의 모든 과제 목록 및 제출 통계 조회
        const result = await client.query(`
            SELECT 
                gi.item_id,
                gi.item_type,
                gi.item_name,
                gi.due_date,
                gi.item_order,
                c.title AS course_title,
                COUNT(DISTINCT e.id) AS total_students,
                COUNT(DISTINCT sg.grade_id) AS total_submissions,
                SUM(CASE WHEN sg.is_completed THEN 1 ELSE 0 END) AS completed_submissions,
                ROUND(AVG(sg.score), 2) AS average_score,
                MIN(sg.score) AS min_score,
                MAX(sg.score) AS max_score
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.enrollments e 
                ON e.course_id = gi.course_id AND e.status = 'ACTIVE'
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = e.id
            WHERE gi.course_id = $1
            GROUP BY gi.item_id, gi.item_name, gi.due_date, gi.item_type, gi.item_order, c.title
            ORDER BY gi.due_date DESC, gi.item_order ASC
        `, [courseId]);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching course assignments:', error);
        res.status(500).json({
            success: false,
            message: "과제 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/admin/assignments/{assignmentId}/submissions:
 *   get:
 *     summary: Get all student submissions for an assignment
 *     tags: [Admin: Assignments]
 *     description: Retrieves submission status for all enrolled students for a specific assignment.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: A list of student submissions.
 */
router.get('/:assignmentId/submissions', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { assignmentId } = req.params;
        
        // 과제 존재 여부 확인
        const assignmentCheck = await client.query(`
            SELECT gi.*, c.title AS course_title 
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            WHERE gi.item_id = $1
        `, [assignmentId]);
        
        if (assignmentCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과제를 찾을 수 없습니다."
            });
        }
        
        const assignment = assignmentCheck.rows[0];
        
        // 모든 학생의 제출 현황 조회
        const result = await client.query(`
            WITH enrolled_students AS (
                SELECT 
                    e.id AS enrollment_id,
                    e.student_id,
                    u.name AS student_name,
                    u.email AS student_email
                FROM ${SCHEMAS.ENROLLMENT}.enrollments e
                JOIN ${SCHEMAS.AUTH}.users u ON e.student_id = u.cognito_user_id
                WHERE e.course_id = $1 AND e.status = 'ACTIVE'
            )
            SELECT 
                es.student_id,
                es.student_name,
                es.student_email,
                es.enrollment_id,
                sg.grade_id,
                sg.score,
                CASE 
                    WHEN sg.score > 0 OR sg.feedback IS NOT NULL THEN true
                    ELSE false
                END AS is_completed,
                sg.submission_date,
                CASE 
                    WHEN sg.submission_date IS NOT NULL THEN true
                    ELSE false
                END AS has_submitted,
                CASE 
                    WHEN sg.submission_date > $2 THEN true
                    ELSE false
                END AS is_late,
                CASE 
                    WHEN sg.feedback IS NOT NULL AND LENGTH(sg.feedback) > 0 THEN true
                    ELSE false
                END AS has_feedback,
                CASE
                    WHEN sg.submission_data::text LIKE '%"files"%' THEN (
                        SELECT jsonb_array_length(submission_data->'files')
                    )
                    ELSE 0
                END AS file_count
            FROM enrolled_students es
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON es.enrollment_id = sg.enrollment_id AND sg.item_id::text = $3::text
            ORDER BY sg.submission_date DESC NULLS LAST, es.student_name ASC
        `, [assignment.course_id, assignment.due_date, assignmentId]);
        
        res.json({
            success: true,
            data: {
                assignment: assignment,
                submissions: result.rows
            }
        });
    } catch (error) {
        console.error('Error fetching assignment submissions:', error);
        res.status(500).json({
            success: false,
            message: "과제 제출 현황 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/admin/assignments/submission/{submissionId}:
 *   get:
 *     summary: Get submission details
 *     tags: [Admin: Assignments]
 *     description: Retrieves detailed information for a single submission, including submitted files.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         description: The ID of the submission (student_grades.grade_id).
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: Detailed submission information.
 *       '404':
 *         description: Submission not found.
 */
router.get('/submission/:submissionId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { submissionId } = req.params;
        
        // 제출물 상세 정보 조회
        const result = await client.query(`
            SELECT 
                sg.*,
                gi.item_name AS assignment_name,
                gi.item_type,
                gi.due_date,
                c.id AS course_id,
                c.title AS course_title,
                u.cognito_user_id AS student_id,
                u.name AS student_name,
                u.email AS student_email,
                CASE 
                    WHEN sg.submission_date > gi.due_date THEN true
                    ELSE false
                END AS is_late,
                CASE 
                    WHEN sg.submission_date IS NOT NULL THEN true
                    ELSE false
                END AS has_submitted,
                CASE 
                    WHEN sg.score > 0 OR sg.feedback IS NOT NULL THEN true
                    ELSE false
                END AS is_graded
            FROM ${SCHEMAS.GRADE}.student_grades sg
            JOIN ${SCHEMAS.ENROLLMENT}.enrollments e ON sg.enrollment_id = e.id
            JOIN ${SCHEMAS.AUTH}.users u ON e.student_id = u.cognito_user_id
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id::text = gi.item_id::text
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            WHERE sg.grade_id = $1
        `, [submissionId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "제출물을 찾을 수 없습니다."
            });
        }
        
        const submission = result.rows[0];
        
        // 제출물에 포함된 파일 정보 추출
        let files = [];
        if (submission.submission_data && submission.submission_data.files) {
            files = submission.submission_data.files;
        }
        
        res.json({
            success: true,
            data: {
                ...submission,
                files: files
            }
        });
    } catch (error) {
        console.error('Error fetching submission detail:', error);
        res.status(500).json({
            success: false,
            message: "제출물 상세 정보 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/admin/assignments/file/{fileKey(*)}/download-url:
 *   get:
 *     summary: Get a download URL for a submitted file
 *     tags: [Admin: Assignments]
 *     description: Generates a presigned URL to download a file submitted by a student.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileKey
 *         required: true
 *         description: The S3 key of the file.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: A presigned download URL.
 *       '404':
 *         description: File not found.
 */
router.get('/file/:fileKey(*)/download-url', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        let { fileKey } = req.params;
        
        // fileKey가 URL 인코딩되어 있을 수 있으므로 디코딩
        fileKey = decodeURIComponent(fileKey);
        
        // S3 버킷 정보
        const bucketName = process.env.S3_BUCKET_NAME || 'nationslablmscoursebucket';
        
        // 파일 존재 여부 확인
        try {
            await s3Client.send(new GetObjectCommand({
                Bucket: bucketName,
                Key: fileKey
            }));
        } catch (error) {
            return res.status(404).json({
                success: false,
                message: "파일을 찾을 수 없습니다.",
                error: error.message
            });
        }
        
        // 다운로드 URL 생성
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: fileKey
        });
        
        const downloadUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: 3600 // 1시간 유효
        });
        
        res.json({
            success: true,
            data: {
                downloadUrl,
                fileKey
            }
        });
    } catch (error) {
        console.error('Error generating download URL:', error);
        res.status(500).json({
            success: false,
            message: "다운로드 URL 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/v1/admin/assignments/submission/{submissionId}/grade:
 *   put:
 *     summary: Grade a submission
 *     tags: [Admin: Assignments]
 *     description: Sets the score and provides feedback for a student's submission.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               score:
 *                 type: number
 *               feedback:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Submission graded successfully.
 *       '400':
 *         description: Invalid score.
 *       '404':
 *         description: Submission not found.
 */
router.put('/submission/:submissionId/grade', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { submissionId } = req.params;
        const { score, feedback } = req.body;
        
        // 점수 유효성 검사
        if (score < 0 || score > 100) {
            return res.status(400).json({
                success: false,
                message: "점수는 0에서 100 사이여야 합니다."
            });
        }
        
        // 제출물 존재 여부 확인
        const submissionCheck = await client.query(`
            SELECT sg.*, gi.item_name
            FROM ${SCHEMAS.GRADE}.student_grades sg
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id::text = gi.item_id::text
            WHERE sg.grade_id = $1
        `, [submissionId]);
        
        if (submissionCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "제출물을 찾을 수 없습니다."
            });
        }
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 점수 및 피드백 업데이트 (채점 시 is_completed를 true로 설정)
        const result = await client.query(`
            UPDATE ${SCHEMAS.GRADE}.student_grades
            SET score = $1, 
                feedback = $2, 
                is_completed = TRUE,
                updated_at = NOW()
            WHERE grade_id = $3
            RETURNING *
        `, [score, feedback, submissionId]);
        
        try {
            // 학생 및 과목 정보 조회
            const enrollmentInfo = await client.query(`
                SELECT e.student_id, gi.course_id
                FROM ${SCHEMAS.ENROLLMENT}.enrollments e
                JOIN ${SCHEMAS.GRADE}.student_grades sg ON e.id = sg.enrollment_id
                JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id::text = gi.item_id::text
                WHERE sg.grade_id = $1
            `, [submissionId]);
            
            if (enrollmentInfo.rows.length > 0) {
                const { student_id, course_id } = enrollmentInfo.rows[0];
                
                // 간단한 최종 성적 업데이트 로직
                await client.query(`
                    WITH assignment_score AS (
                        SELECT AVG(sg.score) as avg_score
                        FROM ${SCHEMAS.GRADE}.grade_items gi
                        JOIN ${SCHEMAS.GRADE}.student_grades sg ON gi.item_id::text = sg.item_id::text
                        JOIN ${SCHEMAS.ENROLLMENT}.enrollments e ON sg.enrollment_id = e.id
                        WHERE gi.course_id = $1 AND e.student_id = $2 AND gi.item_type = 'ASSIGNMENT'
                    ),
                    exam_score AS (
                        SELECT AVG(sg.score) as avg_score
                        FROM ${SCHEMAS.GRADE}.grade_items gi
                        JOIN ${SCHEMAS.GRADE}.student_grades sg ON gi.item_id::text = sg.item_id::text
                        JOIN ${SCHEMAS.ENROLLMENT}.enrollments e ON sg.enrollment_id = e.id
                        WHERE gi.course_id = $1 AND e.student_id = $2 AND gi.item_type = 'EXAM'
                    ),
                    attendance_rate AS (
                        SELECT 
                            CASE WHEN SUM(total_duration_seconds) > 0 
                                THEN (SUM(duration_seconds)::float / SUM(total_duration_seconds)) * 100 
                                ELSE 0 
                            END as rate
                        FROM ${SCHEMAS.GRADE}.attendance_records
                        WHERE course_id = $1 AND student_id = $2
                    )
                    UPDATE ${SCHEMAS.ENROLLMENT}.enrollments e
                    SET final_grade = (
                        (COALESCE((SELECT rate FROM attendance_rate), 0) * c.attendance_weight / 100) +
                        (COALESCE((SELECT avg_score FROM assignment_score), 0) * c.assignment_weight / 100) +
                        (COALESCE((SELECT avg_score FROM exam_score), 0) * c.exam_weight / 100)
                    )
                    FROM ${SCHEMAS.COURSE}.courses c
                    WHERE e.course_id = $1 AND e.student_id = $2 AND c.id = $1
                `, [course_id, student_id]);
            }
        } catch (gradeUpdateError) {
            console.warn('Warning: Could not update final grade:', gradeUpdateError.message);
            // 최종 성적 업데이트 실패는 전체 트랜잭션을 중단하지 않음
        }
        
        // 트랜잭션 커밋
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: "채점이 완료되었습니다.",
            data: result.rows[0]
        });
    } catch (error) {
        // 트랜잭션 롤백
        await client.query('ROLLBACK');
        console.error('Error grading submission:', error);
        res.status(500).json({
            success: false,
            message: "채점 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 