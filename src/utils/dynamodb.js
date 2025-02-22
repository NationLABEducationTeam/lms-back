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
    console.log('📝 [DynamoDB] 타임마크 생성 시작:', {
        userId,
        courseId,
        videoId,
        timestamp
    });

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

    try {
        await dynamodb.put({
            TableName: 'LMSVOD_TimeMarks',
            Item: item
        });
        console.log('✅ [DynamoDB] 타임마크 생성 완료:', { id });

        return {
            ...item,
            formattedTime: formatTime(timestamp)
        };
    } catch (error) {
        console.error('❌ [DynamoDB] 타임마크 생성 오류:', {
            error: error.message,
            params: item
        });
        throw error;
    }
};

/**
 * 타임마크 목록 조회
 * @param {string} courseId - 강의 ID
 * @param {string} videoId - 비디오 ID
 * @returns {Promise<Array>} 타임마크 목록
 */
const getTimemarks = async (courseId, videoId) => {
    console.log('🔍 [DynamoDB] 타임마크 목록 조회 시작:', {
        courseId,
        videoId
    });

    const params = {
        TableName: 'LMSVOD_TimeMarks',
        FilterExpression: 'courseId = :courseId AND videoId = :videoId',
        ExpressionAttributeValues: {
            ':courseId': courseId,
            ':videoId': videoId
        }
    };

    try {
        const result = await dynamodb.scan(params);
        const timemarks = result.Items.map(item => ({
            ...item,
            formattedTime: formatTime(parseInt(item.timestamp))
        }));

        console.log('✅ [DynamoDB] 타임마크 목록 조회 완료:', {
            count: timemarks.length
        });

        return timemarks;
    } catch (error) {
        console.error('❌ [DynamoDB] 타임마크 목록 조회 오류:', {
            error: error.message,
            params
        });
        throw error;
    }
};

/**
 * 타임마크 수정
 * @param {string} id - 타임마크 ID
 * @param {string} timestamp - 타임스탬프
 * @param {string} content - 수정할 메모 내용
 * @returns {Promise<Object>} 수정된 타임마크 정보
 */
const updateTimemark = async (id, timestamp, content) => {
    console.log('📝 [DynamoDB] 타임마크 수정 시작:', {
        id,
        timestamp
    });

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

    try {
        const result = await dynamodb.update(params);
        console.log('✅ [DynamoDB] 타임마크 수정 완료');

        return {
            ...result.Attributes,
            formattedTime: formatTime(parseInt(timestamp))
        };
    } catch (error) {
        console.error('❌ [DynamoDB] 타임마크 수정 오류:', {
            error: error.message,
            params
        });
        throw error;
    }
};

/**
 * 타임마크 삭제
 * @param {string} id - 타임마크 ID
 * @param {string} timestamp - 타임스탬프
 * @returns {Promise<void>}
 */
const deleteTimemark = async (id, timestamp) => {
    console.log('🗑️ [DynamoDB] 타임마크 삭제 시작:', {
        id,
        timestamp
    });

    const params = {
        TableName: 'LMSVOD_TimeMarks',
        Key: {
            id,
            timestamp
        }
    };

    try {
        await dynamodb.delete(params);
        console.log('✅ [DynamoDB] 타임마크 삭제 완료');
    } catch (error) {
        console.error('❌ [DynamoDB] 타임마크 삭제 오류:', {
            error: error.message,
            params
        });
        throw error;
    }
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