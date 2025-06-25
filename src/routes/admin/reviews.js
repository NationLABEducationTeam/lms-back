const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { s3Client } = require('../../config/s3');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

/**
 * @swagger
 * /api/v1/admin/reviews/templates:
 *   get:
 *     summary: 설문 템플릿 목록 조회
 *     description: 모든 설문 템플릿 목록을 조회합니다.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReviewTemplate'
 */
router.get('/templates', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                id,
                title,
                course_id as "courseId",
                target_respondents as "targetRespondents",
                s3_key,
                created_at as "createdAt",
                updated_at as "updatedAt"
            FROM review_templates
            ORDER BY created_at DESC
        `);

        // 각 템플릿에 빈 questions 배열과 description 추가 (S3 연동 전 임시)
        const templatesWithQuestions = result.rows.map(template => ({
            ...template,
            description: template.title, // 임시로 title 사용
            questions: [] // S3 연동 전까지 빈 배열
        }));

        res.json({
            success: true,
            data: templatesWithQuestions
        });
    } catch (error) {
        console.error('Error fetching review templates:', error);
        res.status(500).json({
            success: false,
            message: "설문 템플릿 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/admin/reviews/templates:
 *   post:
 *     summary: 설문 템플릿 생성
 *     description: 새로운 설문 템플릿을 생성합니다.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - courseId
 *               - questions
 *             properties:
 *               title:
 *                 type: string
 *                 description: 템플릿 제목
 *               courseId:
 *                 type: string
 *                 description: 과목 ID
 *               targetRespondents:
 *                 type: integer
 *                 description: 목표 응답자 수
 *               questions:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/ReviewQuestion'
 *     responses:
 *       201:
 *         description: 생성 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/ReviewTemplate'
 */
router.post('/templates', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { title, description, courseId, targetRespondents, questions } = req.body;

        // 입력 검증
        if (!title || !courseId || !questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({
                success: false,
                message: "제목, 과목 ID, 질문은 필수입니다."
            });
        }

        if (targetRespondents && (typeof targetRespondents !== 'number' || targetRespondents <= 0)) {
            return res.status(400).json({
                success: false,
                message: "목표 응답자 수는 양의 정수여야 합니다."
            });
        }

        // 질문에 ID 부여 및 검증
        const processedQuestions = questions.map((question, index) => {
            if (!question.text || !question.type) {
                throw new Error(`질문 ${index + 1}: 질문 내용과 타입은 필수입니다.`);
            }

            if (!['TEXT', 'TEXTAREA', 'MULTIPLE_CHOICE'].includes(question.type)) {
                throw new Error(`질문 ${index + 1}: 유효하지 않은 질문 타입입니다.`);
            }

            if (question.type === 'MULTIPLE_CHOICE' && (!question.options || !Array.isArray(question.options) || question.options.length === 0)) {
                throw new Error(`질문 ${index + 1}: 객관식 질문은 옵션이 필요합니다.`);
            }

            return {
                id: question.id || uuidv4(),
                text: question.text,
                type: question.type,
                ...(question.options && { options: question.options })
            };
        });

        const templateId = uuidv4();
        const now = new Date().toISOString();

        const result = await client.query(`
            INSERT INTO review_templates (id, title, course_id, target_respondents, s3_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, title, course_id as "courseId", target_respondents as "targetRespondents", s3_key, created_at as "createdAt", updated_at as "updatedAt"
        `, [templateId, title, courseId, targetRespondents || null, null, now, now]);

        // 응답에 description과 questions 추가
        const responseData = {
            ...result.rows[0],
            description: description || result.rows[0].title, // description이 없으면 title 사용
            questions: processedQuestions
        };

        res.status(201).json({
            success: true,
            data: responseData
        });
    } catch (error) {
        console.error('Error creating review template:', error);
        res.status(500).json({
            success: false,
            message: error.message.includes('질문') ? error.message : "설문 템플릿 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {get} /api/admin/reviews/templates/:id 설문 템플릿 상세 조회
 * @apiDescription 특정 설문 템플릿의 상세 정보를 조회합니다.
 * @apiName GetReviewTemplate
 * @apiGroup AdminReviews
 * @apiParam {String} id 템플릿 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data 템플릿 상세 정보
 */
router.get('/templates/:id', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { id } = req.params;

        const result = await client.query(`
            SELECT 
                id,
                title,
                course_id as "courseId",
                target_respondents as "targetRespondents",
                s3_key,
                created_at as "createdAt",
                updated_at as "updatedAt"
            FROM review_templates
            WHERE id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }

        // description과 questions 추가 (S3 연동 전 임시)
        const templateWithQuestions = {
            ...result.rows[0],
            description: result.rows[0].title, // 임시로 title 사용
            questions: [] // S3 연동 전까지 빈 배열
        };

        res.json({
            success: true,
            data: templateWithQuestions
        });
    } catch (error) {
        console.error('Error fetching review template:', error);
        res.status(500).json({
            success: false,
            message: "설문 템플릿 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {put} /api/admin/reviews/templates/:id 설문 템플릿 수정
 * @apiDescription 설문 템플릿을 수정합니다.
 * @apiName UpdateReviewTemplate
 * @apiGroup AdminReviews
 * @apiParam {String} id 템플릿 ID
 * @apiParam {String} title 템플릿 제목
 * @apiParam {String} [description] 템플릿 설명
 * @apiParam {Object[]} questions 질문 배열
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data 수정된 템플릿
 */
router.put('/templates/:id', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { id } = req.params;
        const { title, description, courseId, targetRespondents, questions } = req.body;

        // 템플릿 존재 확인
        const existingTemplate = await client.query('SELECT id FROM review_templates WHERE id = $1', [id]);
        if (existingTemplate.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }

        // 입력 검증
        if (!title || !courseId || !questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({
                success: false,
                message: "제목, 과목 ID, 질문은 필수입니다."
            });
        }

        if (targetRespondents && (typeof targetRespondents !== 'number' || targetRespondents <= 0)) {
            return res.status(400).json({
                success: false,
                message: "목표 응답자 수는 양의 정수여야 합니다."
            });
        }

        // 질문에 ID 부여 및 검증
        const processedQuestions = questions.map((question, index) => {
            if (!question.text || !question.type) {
                throw new Error(`질문 ${index + 1}: 질문 내용과 타입은 필수입니다.`);
            }

            if (!['TEXT', 'TEXTAREA', 'MULTIPLE_CHOICE'].includes(question.type)) {
                throw new Error(`질문 ${index + 1}: 유효하지 않은 질문 타입입니다.`);
            }

            if (question.type === 'MULTIPLE_CHOICE' && (!question.options || !Array.isArray(question.options) || question.options.length === 0)) {
                throw new Error(`질문 ${index + 1}: 객관식 질문은 옵션이 필요합니다.`);
            }

            return {
                id: question.id || uuidv4(),
                text: question.text,
                type: question.type,
                ...(question.options && { options: question.options })
            };
        });

        const now = new Date().toISOString();

        const result = await client.query(`
            UPDATE review_templates 
            SET title = $1, course_id = $2, target_respondents = $3, updated_at = $4
            WHERE id = $5
            RETURNING id, title, course_id as "courseId", target_respondents as "targetRespondents", s3_key, created_at as "createdAt", updated_at as "updatedAt"
        `, [title, courseId, targetRespondents || null, now, id]);

        // 응답에 description과 questions 추가
        const responseData = {
            ...result.rows[0],
            description: description || result.rows[0].title,
            questions: processedQuestions
        };

        res.json({
            success: true,
            data: responseData
        });
    } catch (error) {
        console.error('Error updating review template:', error);
        res.status(500).json({
            success: false,
            message: error.message.includes('질문') ? error.message : "설문 템플릿 수정 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {delete} /api/admin/reviews/templates/:id 설문 템플릿 삭제
 * @apiDescription 설문 템플릿을 삭제합니다.
 * @apiName DeleteReviewTemplate
 * @apiGroup AdminReviews
 * @apiParam {String} id 템플릿 ID
 * @apiSuccess {Boolean} success 성공 여부
 */
router.delete('/templates/:id', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { id } = req.params;

        // 템플릿 존재 확인
        const existingTemplate = await client.query('SELECT id FROM review_templates WHERE id = $1', [id]);
        if (existingTemplate.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }

        // 관련 응답 확인
        const responseCount = await client.query('SELECT COUNT(*) FROM review_responses WHERE review_template_id = $1', [id]);
        if (parseInt(responseCount.rows[0].count) > 0) {
            return res.status(400).json({
                success: false,
                message: "이미 응답이 제출된 템플릿은 삭제할 수 없습니다."
            });
        }

        await client.query('DELETE FROM review_templates WHERE id = $1', [id]);

        res.status(204).send();
    } catch (error) {
        console.error('Error deleting review template:', error);
        res.status(500).json({
            success: false,
            message: "설문 템플릿 삭제 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {post} /api/admin/reviews/responses 설문 응답 제출
 * @apiDescription 설문에 대한 응답을 제출합니다.
 * @apiName SubmitReviewResponse
 * @apiGroup AdminReviews
 * @apiParam {String} reviewTemplateId 템플릿 ID
 * @apiParam {Object[]} answers 답변 배열
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data 제출된 응답
 */
router.post('/responses', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { reviewTemplateId, answers } = req.body;
        const userId = req.user.sub; // JWT에서 사용자 ID 추출

        // 입력 검증
        if (!reviewTemplateId || !answers || !Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({
                success: false,
                message: "템플릿 ID와 답변은 필수입니다."
            });
        }

        // 템플릿 존재 확인
        const template = await client.query('SELECT id FROM review_templates WHERE id = $1', [reviewTemplateId]);
        if (template.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }

        // 중복 응답 확인
        const existingResponse = await client.query(
            'SELECT id FROM review_responses WHERE review_template_id = $1 AND user_id = $2',
            [reviewTemplateId, userId]
        );
        if (existingResponse.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: "이미 응답을 제출하셨습니다."
            });
        }

        // 기본 답변 검증 (질문 ID 검증은 추후 S3에서 로드할 때 구현)
        for (const answer of answers) {
            if (!answer.questionId) {
                return res.status(400).json({
                    success: false,
                    message: "질문 ID가 필요합니다."
                });
            }
            if (answer.answer === undefined || answer.answer === null) {
                return res.status(400).json({
                    success: false,
                    message: "모든 질문에 답변해주세요."
                });
            }
        }

        const responseId = uuidv4();
        const now = new Date().toISOString();

        await client.query('BEGIN');

        // 응답 생성
        const responseResult = await client.query(`
            INSERT INTO review_responses (id, review_template_id, user_id, submitted_at)
            VALUES ($1, $2, $3, $4)
            RETURNING id, review_template_id as "reviewTemplateId", submitted_at as "submittedAt"
        `, [responseId, reviewTemplateId, userId, now]);

        // 답변 생성
        for (const answer of answers) {
            await client.query(`
                INSERT INTO review_answers (id, response_id, question_id, answer)
                VALUES ($1, $2, $3, $4)
            `, [uuidv4(), responseId, answer.questionId, answer.answer]);
        }

        await client.query('COMMIT');

        // 응답 데이터 조합
        const responseData = {
            ...responseResult.rows[0],
            answers: answers
        };

        res.status(201).json({
            success: true,
            data: responseData
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting review response:', error);
        res.status(500).json({
            success: false,
            message: "설문 응답 제출 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {get} /api/admin/reviews/responses/:reviewTemplateId 설문 응답 목록 조회
 * @apiDescription 특정 템플릿에 대한 모든 응답을 조회합니다.
 * @apiName GetReviewResponses
 * @apiGroup AdminReviews
 * @apiParam {String} reviewTemplateId 템플릿 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data 응답 목록
 */
router.get('/responses/:reviewTemplateId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { reviewTemplateId } = req.params;

        // 템플릿 존재 확인
        const template = await client.query('SELECT id FROM review_templates WHERE id = $1', [reviewTemplateId]);
        if (template.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }

        // 응답 목록 조회
        const result = await client.query(`
            SELECT 
                rr.id,
                rr.review_template_id as "reviewTemplateId",
                rr.submitted_at as "submittedAt",
                rr.user_id,
                json_agg(
                    json_build_object(
                        'questionId', ra.question_id,
                        'answer', ra.answer
                    ) ORDER BY ra.question_id
                ) as answers
            FROM review_responses rr
            LEFT JOIN review_answers ra ON rr.id = ra.response_id
            WHERE rr.review_template_id = $1
            GROUP BY rr.id, rr.review_template_id, rr.submitted_at, rr.user_id
            ORDER BY rr.submitted_at DESC
        `, [reviewTemplateId]);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching review responses:', error);
        res.status(500).json({
            success: false,
            message: "설문 응답 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 