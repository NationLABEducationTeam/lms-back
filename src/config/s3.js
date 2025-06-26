const { S3Client } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

dotenv.config();

// --- [START] AWS Credentials Debug Block ---
// 이 블록은 .env 파일의 AWS 관련 변수가 Node.js 프로세스에 올바르게 로드되었는지 확인합니다.
console.log('--- Loading AWS Credentials for S3 Client ---');
console.log(`Region: ${process.env.AWS_REGION}`);
console.log(`Access Key ID Exists: ${!!process.env.AWS_ACCESS_KEY_ID}`);
// 실제 키 값은 보안을 위해 출력하지 않습니다. 'true'가 나와야 합니다.
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('CRITICAL ERROR: AWS Access Key ID or Secret Access Key is missing. Check your .env file.');
}
console.log('-------------------------------------------');
// --- [END] AWS Credentials Debug Block ---

// VITE_ 접두사가 붙은 변수와의 호환성을 위한 코드 (있는 경우 사용)
process.env.AWS_REGION = process.env.AWS_REGION || process.env.VITE_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.VITE_AWS_ACCESS_KEY_ID;
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.VITE_AWS_SECRET_ACCESS_KEY;

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

module.exports = {
    s3Client
}; 