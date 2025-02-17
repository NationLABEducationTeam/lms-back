const { S3Client, ListObjectsV2Command, PutObjectCommand, CopyObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { transliterate } = require('transliteration');

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
        const files = await Promise.all((response.Contents || [])
            .filter(item => !item.Key.endsWith('/')) // 폴더 제외
            .map(async item => {
                const downloadable = await isFileDownloadable(item.Key);
                let downloadUrl = null;

                if (downloadable) {
                    // 다운로드 가능한 경우에만 presigned URL 생성
                    const fileName = item.Key.split('/').pop();
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: item.Key,
                        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
                    });
                    downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                }

                return {
                    key: item.Key,
                    fileName: item.Key.split('/').pop(),
                    lastModified: item.LastModified,
                    size: item.Size,
                    type: getFileType(item.Key),
                    downloadable,
                    downloadUrl
                };
            }));

        return files;
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
 * 문자열에서 위험한 특수문자만 제거하고 나머지는 유지합니다.
 * @param {string} str - 처리할 문자열
 * @returns {string} - 처리된 문자열
 */
function sanitizePathComponent(str) {
    // 파일명과 확장자 분리
    const lastDotIndex = str.lastIndexOf('.');
    if (lastDotIndex === -1) {
        // 확장자가 없는 경우
        return str
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // 파일 시스템에서 사용할 수 없는 문자만 제거
            .trim(); // 앞뒤 공백 제거
    }

    // 파일명과 확장자 따로 처리
    const fileName = str.substring(0, lastDotIndex);
    const extension = str.substring(lastDotIndex);
    
    return fileName
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // 파일 시스템에서 사용할 수 없는 문자만 제거
        .trim() // 앞뒤 공백 제거
        + extension;                  // 확장자 그대로 추가
}

/**
 * 파일 업로드를 위한 presigned URL을 생성합니다.
 * @param {string} courseTitle - 강좌 제목
 * @param {number} weekNumber - 주차 번호
 * @param {Array<{name: string, type: string, size: number}>} files - 업로드할 파일 정보 배열
 * @returns {Promise<Array<{fileName: string, sanitizedFileName: string, url: string, key: string}>>} - presigned URL 배열
 */
async function generateUploadUrls(courseTitle, weekNumber, files) {
    try {
        console.log('=== generateUploadUrls called ===');
        console.log('Request parameters:', {
            courseTitle,
            weekNumber,
            files: files.map(f => ({
                name: f.name,
                type: f.type,
                size: f.size
            }))
        });

        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const sanitizedCourseTitle = sanitizePathComponent(courseTitle);
                const sanitizedFileName = sanitizePathComponent(file.name);
                const key = `${sanitizedCourseTitle}/${weekNumber}주차/${sanitizedFileName}`;
                
                console.log('Processing file:', {
                    originalName: file.name,
                    sanitizedName: sanitizedFileName,
                    courseTitle: {
                        original: courseTitle,
                        sanitized: sanitizedCourseTitle
                    },
                    key: key,
                    fileType: file.type,
                    fileSize: file.size
                });
                
                const command = new PutObjectCommand({
                    Bucket: 'nationslablmscoursebucket',
                    Key: key,
                    ContentType: file.type
                });
                
                const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                console.log('Generated presigned URL for file:', {
                    key,
                    urlLength: url.length,
                    expiresIn: '1 hour'
                });

                return {
                    fileName: file.name,
                    sanitizedFileName,
                    url,
                    key
                };
            })
        );

        console.log('=== generateUploadUrls completed ===');
        console.log('Generated URLs count:', presignedUrls.length);
        
        return presignedUrls;
    } catch (error) {
        console.error('=== Error in generateUploadUrls ===');
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
        console.error('Request parameters when error occurred:', {
            courseTitle,
            weekNumber,
            filesCount: files?.length
        });
        throw error;
    }
}

/**
 * 한글 강좌명을 영문으로 변환하여 VOD 폴더를 생성합니다.
 * @param {string} koreanTitle - 한글 강좌명
 * @returns {Promise<{englishTitle: string, folderPath: string}>} - 생성된 영문 폴더명과 전체 경로
 */
async function createVodFolder(koreanTitle) {
    try {
        // 한글을 영문으로 변환하고 공백/특수문자 처리
        let englishTitle = transliterate(koreanTitle)
            .toLowerCase()
            .replace(/\s+/g, '-')        // 공백을 하이픈으로 변환
            .replace(/[^a-z0-9-]/g, '')  // 영문 소문자, 숫자, 하이픈만 허용
            .replace(/-+/g, '-')         // 연속된 하이픈을 하나로
            .replace(/^-+|-+$/g, '');    // 시작과 끝의 하이픈 제거

        console.log('Title conversion:', {
            original: koreanTitle,
            converted: englishTitle
        });

        const folderPath = `vod/${englishTitle}/`;
        
        const command = new PutObjectCommand({
            Bucket: 'vodcourseregistry',
            Key: folderPath,
            Body: ''
        });

        await s3Client.send(command);
        console.log('Successfully created VOD folder:', folderPath);
        
        return {
            englishTitle,
            folderPath
        };
    } catch (error) {
        console.error('Error creating VOD folder:', error);
        throw error;
    }
}

/**
 * VOD 영상 파일 업로드를 위한 presigned URL을 생성합니다.
 * @param {string} englishTitle - 영문 강좌명
 * @param {Array<{name: string, type: string, size: number}>} files - 업로드할 VOD 파일 정보 배열
 * @returns {Promise<Array<{fileName: string, sanitizedFileName: string, url: string, key: string}>>} - presigned URL 배열
 */
async function generateVodUploadUrls(englishTitle, files) {
    try {
        console.log('=== generateVodUploadUrls called ===');
        console.log('Request parameters:', {
            englishTitle,
            files: files.map(f => ({
                name: f.name,
                type: f.type,
                size: f.size
            }))
        });

        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const sanitizedFileName = sanitizePathComponent(file.name);
                const key = `vod/${englishTitle}/${sanitizedFileName}`;
                
                console.log('Processing VOD file:', {
                    originalName: file.name,
                    sanitizedName: sanitizedFileName,
                    englishTitle,
                    key: key,
                    fileType: file.type,
                    fileSize: file.size,
                    bucket: 'vodcourseregistry'
                });
                
                const command = new PutObjectCommand({
                    Bucket: 'vodcourseregistry',
                    Key: key,
                    ContentType: file.type
                });
                
                const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                console.log('Generated presigned URL for VOD file:', {
                    key,
                    urlLength: url.length,
                    expiresIn: '1 hour'
                });

                return {
                    fileName: file.name,
                    sanitizedFileName,
                    url,
                    key
                };
            })
        );

        console.log('=== generateVodUploadUrls completed ===');
        console.log('Generated URLs count:', presignedUrls.length);
        
        return presignedUrls;
    } catch (error) {
        console.error('=== Error in generateVodUploadUrls ===');
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
        console.error('Request parameters when error occurred:', {
            englishTitle,
            filesCount: files?.length
        });
        throw error;
    }
}

/**
 * VOD 폴더의 영상 파일 목록을 조회합니다.
 * @param {string} englishTitle - 영문 강좌명
 * @returns {Promise<Array>} - VOD 파일 목록
 */
async function listVodFiles(englishTitle) {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'vodcourseregistry',
            Prefix: `vod/${englishTitle}/`
        });

        const response = await s3Client.send(command);
        
        const files = await Promise.all((response.Contents || [])
            .filter(item => !item.Key.endsWith('/')) // 폴더 제외
            .map(async item => {
                // VOD 파일(.m3u8, .ts)은 스트리밍용으로만 처리
                const isStreamingFile = item.Key.endsWith('.m3u8') || item.Key.endsWith('.ts');
                const downloadable = isStreamingFile ? false : await isFileDownloadable(item.Key);
                let downloadUrl = null;

                if (!isStreamingFile && downloadable) {
                    // 스트리밍 파일이 아니고 다운로드 가능한 경우에만 presigned URL 생성
                    const fileName = item.Key.split('/').pop();
                    const command = new GetObjectCommand({
                        Bucket: 'vodcourseregistry',
                        Key: item.Key,
                        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
                    });
                    downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                }

                return {
                    key: item.Key,
                    fileName: item.Key.split('/').pop(),
                    lastModified: item.LastModified,
                    size: item.Size,
                    type: getFileType(item.Key),
                    downloadable,
                    downloadUrl,
                    isStreamingFile
                };
            }));

        return files;
    } catch (error) {
        console.error('Error listing VOD files:', error);
        throw error;
    }
}

/**
 * 파일의 다운로드 가능 여부를 변경합니다.
 * @param {string} key - 파일 키
 * @param {boolean} isDownloadable - 다운로드 가능 여부
 * @param {string} bucketName - S3 버킷 이름
 * @returns {Promise<void>}
 */
async function updateFileDownloadPermission(key, isDownloadable, bucketName = 'nationslablmscoursebucket') {
    try {
        // VOD 스트리밍 파일(.m3u8, .ts)은 다운로드 권한 관리에서 제외
        if (key.endsWith('.m3u8') || key.endsWith('.ts')) {
            console.log('Skipping download permission update for streaming file:', key);
            return;
        }

        // CopySource를 URL 인코딩
        const encodedCopySource = encodeURIComponent(`${bucketName}/${key}`);

        // 기존 객체의 메타데이터를 복사하면서 downloadable 속성 업데이트
        const copyCommand = new CopyObjectCommand({
            Bucket: bucketName,
            CopySource: encodedCopySource,
            Key: key,
            Metadata: {
                downloadable: String(isDownloadable)
            },
            MetadataDirective: 'REPLACE'
        });

        await s3Client.send(copyCommand);
        console.log('Successfully updated file download permission:', {
            key,
            isDownloadable,
            bucket: bucketName
        });
    } catch (error) {
        console.error('Error updating file download permission:', error);
        throw error;
    }
}

/**
 * 파일의 다운로드 가능 여부를 확인합니다.
 * @param {string} key - 파일 키
 * @param {string} bucketName - S3 버킷 이름
 * @returns {Promise<boolean>} - 다운로드 가능 여부
 */
async function isFileDownloadable(key, bucketName = 'nationslablmscoursebucket') {
    try {
        const command = new HeadObjectCommand({
            Bucket: bucketName,
            Key: key
        });

        const response = await s3Client.send(command);
        return response.Metadata?.downloadable === 'true';
    } catch (error) {
        console.error('Error checking file download permission:', error);
        return false;
    }
}

/**
 * 파일 다운로드를 위한 presigned URL을 생성합니다.
 * @param {string} key - 파일 키
 * @returns {Promise<string|null>} - presigned URL 또는 null (다운로드 불가능한 경우)
 */
async function generateDownloadUrl(key) {
    try {
        // 다운로드 가능 여부 확인
        const downloadable = await isFileDownloadable(key);
        if (!downloadable) {
            console.log('File is not downloadable:', key);
            return null;
        }

        const fileName = key.split('/').pop();
        const command = new GetObjectCommand({
            Bucket: 'nationslablmscoursebucket',
            Key: key,
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
        });

        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        return url;
    } catch (error) {
        console.error('Error generating download URL:', error);
        return null;
    }
}

module.exports = {
    listCourseWeekMaterials,
    createEmptyFolder,
    generateUploadUrls,
    createVodFolder,
    generateVodUploadUrls,
    listVodFiles,
    updateFileDownloadPermission,
    isFileDownloadable,
    generateDownloadUrl,
    sanitizePathComponent
}; 