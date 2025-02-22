const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { masterPool, SCHEMAS, TABLES } = require('../config/database');
const dynamodb = require('../config/dynamodb');
const {
    createTimemark,
    getTimemarks,
    updateTimemark,
    deleteTimemark
} = require('../utils/dynamodb');

/**
 * 타임마크 생성
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        console.log('📝 [타임마크 생성] 요청 시작:', {
            body: req.body,
            userId: req.user.sub
        });

        const { courseId, videoId, timestamp, content } = req.body;
        const userId = req.user.sub;

        // 필수 필드 검증
        if (!courseId || !videoId || !timestamp || !content) {
            console.warn('❌ [타임마크 생성] 필수 필드 누락:', {
                courseId,
                videoId,
                timestamp,
                content
            });
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 수강 중인 강의인지 확인
        console.log('🔍 [타임마크 생성] 수강 상태 확인 중:', {
            userId,
            courseId
        });

        const enrollmentQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `;
        const enrollmentResult = await masterPool.query(enrollmentQuery, [userId, courseId]);

        if (enrollmentResult.rows.length === 0) {
            console.warn('❌ [타임마크 생성] 수강 중이 아닌 강의:', {
                userId,
                courseId
            });
            return res.status(403).json({
                success: false,
                message: '수강 중인 강의가 아닙니다.'
            });
        }

        console.log('✅ [타임마크 생성] 수강 상태 확인 완료');

        // 타임마크 생성
        console.log('💾 [타임마크 생성] DynamoDB 저장 시작');
        const timemark = await createTimemark({
            userId,
            courseId,
            videoId,
            timestamp,
            content
        });
        console.log('✅ [타임마크 생성] DynamoDB 저장 완료:', timemark);

        res.status(201).json({
            success: true,
            data: timemark
        });
    } catch (error) {
        console.error('❌ [타임마크 생성] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?.sub,
            body: req.body
        });
        res.status(500).json({
            success: false,
            message: '타임마크 생성 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 목록 조회
 */
router.get('/:courseId/:videoId', verifyToken, async (req, res) => {
    try {
        const { courseId, videoId } = req.params;
        const userId = req.user.sub;

        console.log('📝 [타임마크 조회] 요청 시작:', {
            courseId,
            videoId,
            userId
        });

        // 수강 중인 강의인지 확인
        console.log('🔍 [타임마크 조회] 수강 상태 확인 중');
        const enrollmentQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `;
        const enrollmentResult = await masterPool.query(enrollmentQuery, [userId, courseId]);

        if (enrollmentResult.rows.length === 0) {
            console.warn('❌ [타임마크 조회] 수강 중이 아닌 강의:', {
                userId,
                courseId
            });
            return res.status(403).json({
                success: false,
                message: '수강 중인 강의가 아닙니다.'
            });
        }

        console.log('✅ [타임마크 조회] 수강 상태 확인 완료');

        // 타임마크 목록 조회
        console.log('🔍 [타임마크 조회] DynamoDB 조회 시작');
        const timemarks = await getTimemarks(courseId, videoId);
        console.log('✅ [타임마크 조회] DynamoDB 조회 완료:', {
            count: timemarks.length
        });

        res.json({
            success: true,
            data: timemarks
        });
    } catch (error) {
        console.error('❌ [타임마크 조회] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 수정
 */
router.put('/:timemarkId', verifyToken, async (req, res) => {
    try {
        const { timemarkId } = req.params;
        const { content, timestamp } = req.body;
        const userId = req.user.sub;

        console.log('📝 [타임마크 수정] 요청 시작:', {
            timemarkId,
            userId,
            body: req.body
        });

        if (!content || !timestamp) {
            console.warn('❌ [타임마크 수정] 필수 필드 누락:', {
                content,
                timestamp
            });
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 타임마크 소유자 확인
        console.log('🔍 [타임마크 수정] 타임마크 조회 중');
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp: timestamp.toString()
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            console.warn('❌ [타임마크 수정] 타임마크 없음:', {
                timemarkId,
                timestamp
            });
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            console.warn('❌ [타임마크 수정] 권한 없음:', {
                timemarkId,
                ownerId: result.Item.userId,
                requesterId: userId
            });
            return res.status(403).json({
                success: false,
                message: '타임마크를 수정할 권한이 없습니다.'
            });
        }

        console.log('✅ [타임마크 수정] 권한 확인 완료');

        // 타임마크 수정
        console.log('💾 [타임마크 수정] DynamoDB 업데이트 시작');
        const updatedTimemark = await updateTimemark(timemarkId, timestamp.toString(), content);
        console.log('✅ [타임마크 수정] DynamoDB 업데이트 완료:', updatedTimemark);

        res.json({
            success: true,
            data: updatedTimemark
        });
    } catch (error) {
        console.error('❌ [타임마크 수정] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            body: req.body,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 수정 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 삭제
 */
router.delete('/:timemarkId', verifyToken, async (req, res) => {
    try {
        const { timemarkId } = req.params;
        const { timestamp } = req.query;
        const userId = req.user.sub;

        console.log('📝 [타임마크 삭제] 요청 시작:', {
            timemarkId,
            timestamp,
            userId
        });

        if (!timestamp) {
            console.warn('❌ [타임마크 삭제] timestamp 파라미터 누락');
            return res.status(400).json({
                success: false,
                message: 'timestamp 쿼리 파라미터가 필요합니다.'
            });
        }

        // 타임마크 소유자 확인
        console.log('🔍 [타임마크 삭제] 타임마크 조회 중');
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            console.warn('❌ [타임마크 삭제] 타임마크 없음:', {
                timemarkId,
                timestamp
            });
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            console.warn('❌ [타임마크 삭제] 권한 없음:', {
                timemarkId,
                ownerId: result.Item.userId,
                requesterId: userId
            });
            return res.status(403).json({
                success: false,
                message: '타임마크를 삭제할 권한이 없습니다.'
            });
        }

        console.log('✅ [타임마크 삭제] 권한 확인 완료');

        // 타임마크 삭제
        console.log('🗑️ [타임마크 삭제] DynamoDB 삭제 시작');
        await deleteTimemark(timemarkId, timestamp);
        console.log('✅ [타임마크 삭제] DynamoDB 삭제 완료');

        res.json({
            success: true,
            message: '타임마크가 삭제되었습니다.'
        });
    } catch (error) {
        console.error('❌ [타임마크 삭제] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            query: req.query,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 삭제 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 