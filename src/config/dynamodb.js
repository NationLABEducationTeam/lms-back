const AWS = require('aws-sdk');

// AWS 설정 로깅
console.log('🔧 [DynamoDB] AWS 설정 정보:', {
    region: process.env.AWS_REGION,
    hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
    hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY
});

// AWS 설정
AWS.config.update({
    region: process.env.AWS_REGION || 'ap-northeast-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// DynamoDB 메서드 래핑 및 로깅 추가
const wrappedDynamodb = {
    scan: async (params) => {
        console.log('📡 [DynamoDB] Scan 요청:', JSON.stringify(params, null, 2));
        try {
            const result = await dynamodb.scan(params).promise();
            console.log('✅ [DynamoDB] Scan 결과:', {
                count: result.Items?.length,
                scannedCount: result.ScannedCount,
                firstItem: result.Items?.[0]
            });
            return result;
        } catch (error) {
            console.error('❌ [DynamoDB] Scan 오류:', error);
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

module.exports = wrappedDynamodb; 