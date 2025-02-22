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
        const { courseId, videoId, timestamp, content } = req.body;
        const userId = req.user.sub;

        // 필수 필드 검증
        if (!courseId || !videoId || !timestamp || !content) {
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 수강 중인 강의인지 확인
        const enrollmentQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `;
        const enrollmentResult = await masterPool.query(enrollmentQuery, [userId, courseId]);

        if (enrollmentResult.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: '수강 중인 강의가 아닙니다.'
            });
        }

        // 타임마크 생성
        const timemark = await createTimemark({
            userId,
            courseId,
            videoId,
            timestamp,
            content
        });

        res.status(201).json({
            success: true,
            data: timemark
        });
    } catch (error) {
        console.error('타임마크 생성 오류:', error);
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

        // 수강 중인 강의인지 확인
        const enrollmentQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `;
        const enrollmentResult = await masterPool.query(enrollmentQuery, [userId, courseId]);

        if (enrollmentResult.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: '수강 중인 강의가 아닙니다.'
            });
        }

        // 타임마크 목록 조회
        const timemarks = await getTimemarks(courseId, videoId);

        res.json({
            success: true,
            data: timemarks
        });
    } catch (error) {
        console.error('타임마크 목록 조회 오류:', error);
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

        if (!content || !timestamp) {
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 타임마크 소유자 확인
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp: timestamp.toString()
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '타임마크를 수정할 권한이 없습니다.'
            });
        }

        // 타임마크 수정
        const updatedTimemark = await updateTimemark(timemarkId, timestamp.toString(), content);

        res.json({
            success: true,
            data: updatedTimemark
        });
    } catch (error) {
        console.error('타임마크 수정 오류:', error);
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

        if (!timestamp) {
            return res.status(400).json({
                success: false,
                message: 'timestamp 쿼리 파라미터가 필요합니다.'
            });
        }

        // 타임마크 소유자 확인
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '타임마크를 삭제할 권한이 없습니다.'
            });
        }

        // 타임마크 삭제
        await deleteTimemark(timemarkId, timestamp);

        res.json({
            success: true,
            message: '타임마크가 삭제되었습니다.'
        });
    } catch (error) {
        console.error('타임마크 삭제 오류:', error);
        res.status(500).json({
            success: false,
            message: '타임마크 삭제 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 