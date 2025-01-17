const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');

let clientConfig = {
    region: 'ap-northeast-2'
};

// Local environment: Use environment variables
if (process.env.NODE_ENV === 'development') {
    clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
    console.log('Using local environment credentials');
} else {
    // Production (ECS) environment: Use ECS Task Role
    console.log('Using ECS Task Role for credentials');
}

console.log('DynamoDB Client Config:', {
    region: clientConfig.region,
    accessKeyId: clientConfig.credentials?.accessKeyId ? 'Set' : 'Not Set',
    secretAccessKey: clientConfig.credentials?.secretAccessKey ? 'Set' : 'Not Set'
});

const client = new DynamoDB(clientConfig);
const dynamodb = DynamoDBDocument.from(client);

module.exports = dynamodb; 