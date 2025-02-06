const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-northeast-2'
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
                const weekName = `week${weekNumber}`;  // "week123"
                
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

/**
 * S3 버킷에 빈 폴더를 생성합니다.
 * @param {string} folderPath - 생성할 폴더 경로 (끝에 / 포함)
 * @returns {Promise<void>}
 */
async function createEmptyFolder(folderPath) {
    try {
        const command = new PutObjectCommand({
            Bucket: 'nationslablmscoursebucket',
            Key: folderPath,
            Body: ''
        });

        await s3Client.send(command);
        console.log('Successfully created folder:', folderPath);
    } catch (error) {
        console.error('Error creating folder:', error);
        throw error;
    }
}

/**
 * 파일 업로드를 위한 presigned URL을 생성합니다.
 * @param {string} courseTitle - 강좌 제목
 * @param {number} weekNumber - 주차 번호
 * @param {Array<{name: string, type: string, size: number}>} files - 업로드할 파일 정보 배열
 * @returns {Promise<Array<{fileName: string, url: string}>>} - presigned URL 배열
 */
async function generateUploadUrls(courseTitle, weekNumber, files) {
    try {
        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const key = `${courseTitle}/${weekNumber}주차/${file.name}`;
                const command = new PutObjectCommand({
                    Bucket: 'nationslablmscoursebucket',
                    Key: key,
                    ContentType: file.type
                });
                
                const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                return {
                    fileName: file.name,
                    url,
                    key
                };
            })
        );

        return presignedUrls;
    } catch (error) {
        console.error('Error generating presigned URLs:', error);
        throw error;
    }
}

module.exports = {
    listCourseWeekMaterials,
    createEmptyFolder,
    generateUploadUrls
}; 