const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-northeast-2',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

/**
 * S3 버킷의 특정 prefix(폴더)에 있는 모든 객체를 조회합니다.
 * @param {string} prefix - 조회할 폴더 경로 (예: "AI 컴퓨터 비전/")
 * @returns {Promise<Array>} - 주차별로 그룹화된 파일 목록
 */
async function listCourseWeekMaterials(prefix) {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: prefix,
            Delimiter: '/'
        });

        const response = await s3Client.send(command);
        
        // 주차별로 파일들을 그룹화
        const weeklyMaterials = {};
        
        // CommonPrefixes는 폴더를 나타냅니다 (예: "1주차/", "2주차/" 등)
        if (response.CommonPrefixes) {
            for (const prefix of response.CommonPrefixes) {
                // "1주차/" -> "week1"로 변환
                const folderName = prefix.Prefix.split('/').slice(-2)[0];  // "1주차"
                const weekNumber = folderName.replace(/[^0-9]/g, '');  // "1"
                const weekName = `week${weekNumber}`;  // "week1"
                
                const weekFiles = await listWeekFiles(prefix.Prefix);
                weeklyMaterials[weekName] = weekFiles;
            }
        }

        return weeklyMaterials;
    } catch (error) {
        console.error('Error listing course materials:', error);
        throw error;
    }
}

/**
 * 특정 주차 폴더 내의 모든 파일을 조회합니다.
 * @param {string} weekPrefix - 주차 폴더 경로
 * @returns {Promise<Array>} - 파일 목록
 */
async function listWeekFiles(weekPrefix) {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: weekPrefix
        });

        const response = await s3Client.send(command);
        
        // Contents에는 파일 목록이 들어있습니다
        return (response.Contents || [])
            .filter(item => !item.Key.endsWith('/')) // 폴더 제외
            .map(item => ({
                key: item.Key,
                fileName: item.Key.split('/').pop(),
                lastModified: item.LastModified,
                size: item.Size,
                type: getFileType(item.Key)
            }));
    } catch (error) {
        console.error('Error listing week files:', error);
        throw error;
    }
}

/**
 * 파일 확장자를 기반으로 파일 타입을 반환합니다.
 * @param {string} fileName - 파일 이름
 * @returns {string} - 파일 타입
 */
function getFileType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    const typeMap = {
        pdf: 'document',
        doc: 'document',
        docx: 'document',
        ppt: 'presentation',
        pptx: 'presentation',
        xls: 'spreadsheet',
        xlsx: 'spreadsheet',
        txt: 'text',
        json: 'json',
        jpg: 'image',
        jpeg: 'image',
        png: 'image',
        gif: 'image',
        mp4: 'video',
        mp3: 'audio',
        zip: 'archive',
        rar: 'archive'
    };
    
    return typeMap[extension] || 'unknown';
}

module.exports = {
    listCourseWeekMaterials
}; 