const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// In production, force removal of any credential env vars to ensure IAM Role is used.
if (process.env.NODE_ENV === 'production') {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
}

// AWS 설정
AWS.config.update({
    region: process.env.AWS_REGION || 'ap-northeast-2'
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// DynamoDB 메서드 래핑 및 로깅 추가
const wrappedDynamodb = {
    scan: async (params) => {
        console.log('📡 [DynamoDB] Scan 시작 ================');
        console.log('테이블:', params.TableName);
        console.log('필터:', params.FilterExpression);
        console.log('파라미터:', params.ExpressionAttributeValues);
        
        try {
            const result = await dynamodb.scan(params).promise();
            console.log('✅ [DynamoDB] Scan 완료 ================');
            console.log('총 아이템 수:', result.Items?.length);
            console.log('스캔된 아이템 수:', result.ScannedCount);
            if (result.Items?.length > 0) {
                console.log('첫 번째 아이템:', JSON.stringify(result.Items[0], null, 2));
            } else {
                console.log('❌ 아이템이 없습니다');
            }
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Scan 오류 ================');
            console.error('에러 메시지:', error.message);
            console.error('에러 코드:', error.code);
            console.error('요청 파라미터:', JSON.stringify(params, null, 2));
            throw error;
        }
    },
    get: async (params) => {
        console.log('📡 [DynamoDB] Get 요청:', JSON.stringify(params, null, 2));
        try {
            const result = await dynamodb.get(params).promise();
            console.log('✅ [DynamoDB] Get 결과:', {
                hasItem: !!result.Item,
                item: result.Item
            });
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Get 오류:', error);
            throw error;
        }
    },
    put: async (params) => {
        console.log('📡 [DynamoDB] Put 요청:', JSON.stringify(params, null, 2));
        try {
            const result = await dynamodb.put(params).promise();
            console.log('✅ [DynamoDB] Put 성공');
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Put 오류:', error);
            throw error;
        }
    },
    update: async (params) => {
        console.log('📡 [DynamoDB] Update 요청:', JSON.stringify(params, null, 2));
        try {
            const result = await dynamodb.update(params).promise();
            console.log('✅ [DynamoDB] Update 성공:', result);
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Update 오류:', error);
            throw error;
        }
    },
    delete: async (params) => {
        console.log('📡 [DynamoDB] Delete 요청:', JSON.stringify(params, null, 2));
        try {
            const result = await dynamodb.delete(params).promise();
            console.log('✅ [DynamoDB] Delete 성공');
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Delete 오류:', error);
            throw error;
        }
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

/**
 * 모든 노트 필기 조회
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Array>} 노트 필기 목록
 */
const getAllNotes = async (userId) => {
    console.log('🔍 [DynamoDB] 전체 노트 필기 조회 시작:', {
        userId,
        TableName: 'LMSVOD_TimeMarks'
    });

    const params = {
        TableName: 'LMSVOD_TimeMarks',
        FilterExpression: 'userId = :userId',
        ExpressionAttributeValues: {
            ':userId': userId
        }
    };

    try {
        console.log('📡 [DynamoDB] Scan 시작 ================');
        console.log('테이블:', params.TableName);
        console.log('필터:', params.FilterExpression);
        console.log('파라미터:', params.ExpressionAttributeValues);
        
        const result = await dynamodb.scan(params).promise();
        
        console.log('✅ [DynamoDB] Scan 완료 ================');
        console.log('총 아이템 수:', result.Items?.length);
        console.log('스캔된 아이템 수:', result.ScannedCount);
        if (result.Items?.length > 0) {
            console.log('첫 번째 아이템:', JSON.stringify(result.Items[0], null, 2));
        } else {
            console.log('❌ 아이템이 없습니다');
        }

        const notes = result.Items.map(item => ({
            ...item,
            formattedTime: formatTime(parseInt(item.timestamp))
        }));

        return notes;
    } catch (error) {
        console.error('❌ [DynamoDB] 전체 노트 필기 조회 오류:', {
            error: error.message,
            params
        });
        throw error;
    }
};

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
        }).promise();
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
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Array>} 타임마크 목록
 */
const getTimemarks = async (courseId, videoId, userId) => {
    console.log('🔍 [DynamoDB] 타임마크 목록 조회 시작:', {
        courseId,
        videoId,
        userId
    });

    const params = {
        TableName: 'LMSVOD_TimeMarks',
        FilterExpression: 'courseId = :courseId AND videoId = :videoId AND userId = :userId',
        ExpressionAttributeValues: {
            ':courseId': courseId,
            ':videoId': videoId,
            ':userId': userId
        }
    };

    try {
        const result = await dynamodb.scan(params).promise();
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
        const result = await dynamodb.update(params).promise();
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
        await dynamodb.delete(params).promise();
        console.log('✅ [DynamoDB] 타임마크 삭제 완료');
    } catch (error) {
        console.error('❌ [DynamoDB] 타임마크 삭제 오류:', {
            error: error.message,
            params
        });
        throw error;
    }
};

module.exports = {
    createTimemark,
    getTimemarks,
    updateTimemark,
    deleteTimemark,
    getAllNotes
}; 