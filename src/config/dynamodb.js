const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { fromEnv } = require('@aws-sdk/credential-providers');

const client = new DynamoDB({
    region: 'ap-northeast-2',
    credentials: fromEnv()
});

const dynamodb = DynamoDBDocument.from(client);

module.exports = dynamodb; 