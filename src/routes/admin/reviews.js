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

        // S3에서 설문 내용(description, questions) 가져오기
        const templatesWithDetails = await Promise.all(result.rows.map(async (template) => {
            if (template.s3_key) {
                try {
                    const s3Bucket = 'nationslablmscoursebucket';
                    const s3Params = {
                        Bucket: s3Bucket,
                        Key: template.s3_key,
                    };
                    const s3Object = await s3Client.send(new GetObjectCommand(s3Params));
                    const s3Content = await s3Object.Body.transformToString('utf-8');
                    const { description, questions } = JSON.parse(s3Content);

                    return {
                        ...template,
                        description: description || template.title,
                        questions: questions || []
                    };
                } catch (s3Error) {
                    console.error(`Error fetching template from S3 (key: ${template.s3_key}):`, s3Error);
                    // S3에서 에러 발생 시 기본값으로 반환
                    return {
                        ...template,
                        description: template.title,
                        questions: []
                    };
                }
            }
            return {
                ...template,
                description: template.title,
                questions: []
            };
        }));

        res.json({
            success: true,
            data: templatesWithDetails
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

        const s3Key = `reviews/${courseId}/${templateId}.json`;
        const s3Bucket = 'nationslablmscoursebucket';

        // S3에 질문 데이터 업로드
        const s3Params = {
            Bucket: s3Bucket,
            Key: s3Key,
            Body: JSON.stringify({ description, questions: processedQuestions }),
            ContentType: 'application/json'
        };
        await s3Client.send(new PutObjectCommand(s3Params));

        const result = await client.query(`
            INSERT INTO review_templates (id, title, course_id, target_respondents, s3_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, title, course_id as "courseId", target_respondents as "targetRespondents", s3_key, created_at as "createdAt", updated_at as "updatedAt"
        `, [templateId, title, courseId, targetRespondents || null, s3Key, now, now]);

        // 응답에 description과 questions 추가
        const responseData = {
            ...result.rows[0],
            description: description || result.rows[0].title,
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
router.get('/templates/:id', async (req, res) => {
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

        const template = result.rows[0];
        let description = template.title;
        let questions = [];

        if (template.s3_key) {
            try {
                const s3Bucket = 'nationslablmscoursebucket';
                const s3Params = {
                    Bucket: s3Bucket,
                    Key: template.s3_key,
                };
                const s3Object = await s3Client.send(new GetObjectCommand(s3Params));
                const s3Content = await s3Object.Body.transformToString('utf-8');
                const s3Data = JSON.parse(s3Content);
                description = s3Data.description || template.title;
                questions = s3Data.questions || [];
            } catch (s3Error) {
                console.error(`Error fetching template details from S3 (key: ${template.s3_key}):`, s3Error);
            }
        }
        
        const templateWithDetails = {
            ...template,
            description,
            questions
        };

        res.json({
            success: true,
            data: templateWithDetails
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
        const existingTemplateResult = await client.query('SELECT id, s3_key FROM review_templates WHERE id = $1', [id]);
        if (existingTemplateResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "설문 템플릿을 찾을 수 없습니다."
            });
        }
        const existingTemplate = existingTemplateResult.rows[0];

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

        // S3에 업데이트된 질문 데이터 업로드
        const s3Key = existingTemplate.s3_key || `reviews/${courseId}/${id}.json`;
        const s3Bucket = 'nationslablmscoursebucket';
        const s3Params = {
            Bucket: s3Bucket,
            Key: s3Key,
            Body: JSON.stringify({ description, questions: processedQuestions }),
            ContentType: 'application/json'
        };
        await s3Client.send(new PutObjectCommand(s3Params));

        const result = await client.query(`
            UPDATE review_templates 
            SET title = $1, course_id = $2, target_respondents = $3, updated_at = $4, s3_key = $5
            WHERE id = $6
            RETURNING id, title, course_id as "courseId", target_respondents as "targetRespondents", s3_key, created_at as "createdAt", updated_at as "updatedAt"
        `, [title, courseId, targetRespondents || null, now, s3Key, id]);

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
// POST /api/admin/reviews/responses - 설문 응답 제출 (수정된 코드)
// verifyToken 미들웨어 제거
router.post('/responses', async (req, res) => {
    const client = await masterPool.connect();
    try {
        // userId 대신 userName을 body에서 받음
        const { reviewTemplateId, answers, userName } = req.body;

        // 입력 검증
        if (!reviewTemplateId || !answers || !Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({
                success: false,
                message: "템플릿 ID와 답변은 필수입니다."
            });
        }
        
        // 이름 입력 검증 (선택적)
        if (!userName || userName.trim() === '') {
             return res.status(400).json({
                success: false,
                message: "이름을 입력해주세요."
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

        // userId 기반 중복 응답 확인 로직 제거

        // 기본 답변 검증
        for (const answer of answers) {
            if (!answer.questionId || answer.answer === undefined || answer.answer === null) {
                return res.status(400).json({
                    success: false,
                    message: "모든 질문에 답변해주세요."
                });
            }
        }

        const responseId = uuidv4();
        const now = new Date().toISOString();

        await client.query('BEGIN');

        // 응답 생성: user_id 대신 user_name을 저장하고, user_id는 NULL로 설정
        const responseResult = await client.query(`
            INSERT INTO review_responses (id, review_template_id, user_name, submitted_at)
            VALUES ($1, $2, $3, $4)
            RETURNING id, review_template_id as "reviewTemplateId", user_name as "userName", submitted_at as "submittedAt"
        `, [responseId, reviewTemplateId, userName, now]);

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
                rr.user_name as "userName",
                json_agg(
                    json_build_object(
                        'questionId', ra.question_id,
                        'answer', ra.answer
                    ) ORDER BY ra.question_id
                ) as answers
            FROM review_responses rr
            LEFT JOIN review_answers ra ON rr.id = ra.response_id
            WHERE rr.review_template_id = $1
            GROUP BY rr.id, rr.review_template_id, rr.submitted_at, rr.user_name
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