const { S3Client } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
dotenv.config();
// Alias VITE_ AWS env vars to AWS_ for SDK
process.env.AWS_REGION = process.env.AWS_REGION || process.env.VITE_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.VITE_AWS_ACCESS_KEY_ID;
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.VITE_AWS_SECRET_ACCESS_KEY;
// Debug S3 envs
console.log(' [S3] AWS 설정 정보:', {
  awsRegion: process.env.AWS_REGION,
  hasAwsAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
  hasAwsSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY
});
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-northeast-2',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
module.exports = {
    s3Client
}; 