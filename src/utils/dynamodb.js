const dynamodb = require('../config/dynamodb');
const { v4: uuidv4 } = require('uuid');

/**
 * 타임마크 생성
 * @param {Object} params
 * @param {string} params.userId - 사용자 ID
 * @param {string} params.courseId - 강의 ID
 * @param {string} params.videoId - 비디오 ID
 * @param {number} params.timestamp - 타임스탬프 (초)
 * @param {string} params.content - 메모 내용
 * @returns {Promise<Object>} 생성된 타임마크 정보
 */
const createTimemark = async (params) => {
    const { userId, courseId, videoId, timestamp, content } = params;
    const now = new Date().toISOString();
    const id = uuidv4();

    const item = {
        id,
        timestamp: timestamp.toString(),
        userId,
        courseId,
        videoId,
        content,
        createdAt: now,
        updatedAt: now
    };

    await dynamodb.put({
        TableName: 'LMSVOD_TimeMarks',
        Item: item
    });

    return {
        ...item,
        formattedTime: formatTime(timestamp)
    };
};

/**
 * 타임마크 목록 조회
 * @param {string} courseId - 강의 ID
 * @param {string} videoId - 비디오 ID
 * @returns {Promise<Array>} 타임마크 목록
 */
const getTimemarks = async (courseId, videoId) => {
    const params = {
        TableName: 'LMSVOD_TimeMarks',
        FilterExpression: 'courseId = :courseId AND videoId = :videoId',
        ExpressionAttributeValues: {
            ':courseId': courseId,
            ':videoId': videoId
        }
    };

    const result = await dynamodb.scan(params);
    return result.Items.map(item => ({
        ...item,
        formattedTime: formatTime(parseInt(item.timestamp))
    }));
};

/**
 * 타임마크 수정
 * @param {string} id - 타임마크 ID
 * @param {string} timestamp - 타임스탬프
 * @param {string} content - 수정할 메모 내용
 * @returns {Promise<Object>} 수정된 타임마크 정보
 */
const updateTimemark = async (id, timestamp, content) => {
    const now = new Date().toISOString();

    const params = {
        TableName: 'LMSVOD_TimeMarks',
        Key: {
            id,
            timestamp
        },
        UpdateExpression: 'SET content = :content, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
            ':content': content,
            ':updatedAt': now
        },
        ReturnValues: 'ALL_NEW'
    };

    const result = await dynamodb.update(params);
    return {
        ...result.Attributes,
        formattedTime: formatTime(parseInt(timestamp))
    };
};

/**
 * 타임마크 삭제
 * @param {string} id - 타임마크 ID
 * @param {string} timestamp - 타임스탬프
 * @returns {Promise<void>}
 */
const deleteTimemark = async (id, timestamp) => {
    const params = {
        TableName: 'LMSVOD_TimeMarks',
        Key: {
            id,
            timestamp
        }
    };

    await dynamodb.delete(params);
};

/**
 * 초 단위 시간을 "mm:ss" 형식으로 변환
 * @param {number} seconds - 초 단위 시간
 * @returns {string} "mm:ss" 형식의 시간
 */
const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
};

module.exports = {
    createTimemark,
    getTimemarks,
    updateTimemark,
    deleteTimemark
}; 