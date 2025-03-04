const { S3Client, ListObjectsV2Command, PutObjectCommand, CopyObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { transliterate } = require('transliteration');

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-northeast-2'
});

/**
 * S3 버킷의 특정 prefix(폴더)에 있는 모든 객체를 조회합니다.
 * @param {string} prefix - 조회할 폴더 경로 (예: "ai-keompyuteo-bijeon/")
 * @param {string} userRole - 사용자 역할 ('ADMIN' | 'STUDENT')
 * @returns {Promise<Array>} - 주차별로 그룹화된 파일 목록
 */
async function listCourseWeekMaterials(prefix, userRole = 'STUDENT') {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: prefix,
            Delimiter: '/'
        });

        const response = await s3Client.send(command);
        
        // 주차별로 파일들을 그룹화
        const weeklyMaterials = {};
        
        if (response.CommonPrefixes) {
            for (const prefix of response.CommonPrefixes) {
                const folderName = prefix.Prefix.split('/').slice(-2)[0];
                const weekNumber = folderName.replace(/[^0-9]/g, '');
                const weekName = `week${weekNumber}`;
                
                const weekFiles = await listWeekFiles(prefix.Prefix, userRole);
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
 * @param {string} userRole - 사용자 역할 ('ADMIN' | 'STUDENT')
 * @returns {Promise<Array>} - 파일 목록
 */
async function listWeekFiles(weekPrefix, userRole = 'STUDENT') {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: weekPrefix
        });

        const response = await s3Client.send(command);
        
        // 파일들을 그룹화 (mp4와 관련 HLS 파일들)
        const fileGroups = {};
        
        // 먼저 모든 파일을 순회하면서 그룹화
        (response.Contents || [])
            .filter(item => {
                const fileName = item.Key.split('/').pop();
                // 폴더와 .ts 파일은 제외
                if (item.Key.endsWith('/') || fileName.endsWith('.ts')) {
                    return false;
                }
                
                // 비디오 파일의 경우 사용자 역할에 따라 필터링
                if (fileName.endsWith('.mp4') || fileName.endsWith('.m3u8')) {
                    if (userRole === 'ADMIN') {
                        return fileName.endsWith('.mp4');
                    } else {
                        return fileName.endsWith('.m3u8');
                    }
                }
                
                // 다른 모든 파일 타입은 포함 (ts 파일 제외됨)
                return true;
            })
            .forEach(item => {
                const fileName = item.Key.split('/').pop();
                const baseFileName = fileName.split('.')[0].replace(/\d+x\d+_\d+mbps_qvpr$/, '');
                
                if (!fileGroups[baseFileName]) {
                    fileGroups[baseFileName] = {
                        file: item
                    };
                }
            });

        // 결과 생성
        const files = await Promise.all(
            Object.entries(fileGroups).map(async ([baseFileName, group]) => {
                const fileName = group.file.Key.split('/').pop();
                const isHlsFile = fileName.endsWith('.m3u8');
                const downloadable = await isFileDownloadable(group.file.Key);

                let downloadUrl = null;
                let streamingUrl = null;

                if (userRole === 'ADMIN' && !isHlsFile && downloadable) {
                    // 관리자용 다운로드 URL
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: group.file.Key,
                        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
                    });
                    downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                } else if (userRole === 'STUDENT' && isHlsFile && downloadable) {
                    // 학생용 스트리밍 URL
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: group.file.Key
                    });
                    streamingUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                } else if (downloadable) {
                    // 일반 파일 다운로드 URL
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: group.file.Key,
                        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
                    });
                    downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                }

                return {
                    key: group.file.Key,
                    fileName,
                    lastModified: group.file.LastModified,
                    size: group.file.Size,
                    type: getFileType(group.file.Key),
                    downloadable,
                    downloadUrl,
                    streamingUrl,
                    isHlsFile,
                    baseFileName
                };
            })
        );

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
        m3u8: 'video',  // m3u8 파일을 video 타입으로 처리
        ts: 'video',    // ts 파일도 video 타입으로 처리
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
 * @param {string} courseId - 강좌 ID
 * @param {string|number} weekNumber - 주차 번호 또는 'assignments'와 같은 특수 폴더명
 * @param {Array<{name: string, type: string, size: number, prefix?: string}>} files - 업로드할 파일 정보 배열
 * @returns {Promise<Array>} - presigned URL 배열
 */
async function generateUploadUrls(courseId, weekNumber, files) {
    try {
        console.log('=== generateUploadUrls called ===');
        console.log('Request parameters:', {
            courseId,
            weekNumber,
            files: files.map(f => ({
                name: f.name,
                type: f.type,
                size: f.size,
                prefix: f.prefix
            }))
        });

        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const sanitizedFileName = sanitizePathComponent(file.name);
                
                // 파일 경로 결정 (과제/퀴즈 파일인 경우 prefix 사용)
                let key;
                if (file.prefix) {
                    // 과제/퀴즈 파일 경로: assignments/{itemId}/{fileName}
                    key = `${file.prefix}/${sanitizedFileName}`;
                } else {
                    // 일반 강의 자료 경로: {courseId}/{weekNumber}주차/{fileName}
                    const weekSuffix = typeof weekNumber === 'number' ? `${weekNumber}주차` : weekNumber;
                    key = `${courseId}/${weekSuffix}/${sanitizedFileName}`;
                }
                
                console.log('Processing file:', {
                    originalName: file.name,
                    sanitizedName: sanitizedFileName,
                    key: key,
                    fileType: file.type,
                    fileSize: file.size
                });
                
                const command = new PutObjectCommand({
                    Bucket: 'nationslablmscoursebucket',
                    Key: key,
                    ContentType: file.type,
                    Metadata: {
                        downloadable: 'false'  // 기본적으로 다운로드 불가능으로 설정
                    }
                });
                
                const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                
                return {
                    fileName: file.name,
                    sanitizedFileName,
                    url,
                    key
                };
            })
        );

        return presignedUrls;
    } catch (error) {
        console.error('Error in generateUploadUrls:', error);
        throw error;
    }
}

/**
 * VOD 폴더를 생성합니다.
 * @param {string} engTitle - 영문 강좌명
 * @returns {Promise<{folderPath: string}>} - 생성된 폴더 경로
 */
async function createVodFolder(engTitle) {
    try {
        const folderPath = `vod/${engTitle}/`;
        
        const command = new PutObjectCommand({
            Bucket: 'nationslablmscoursebucket',
            Key: folderPath,
            Body: ''
        });

        await s3Client.send(command);
        console.log('Successfully created VOD folder:', folderPath);
        
        return {
            folderPath
        };
    } catch (error) {
        console.error('Error creating VOD folder:', error);
        throw error;
    }
}

/**
 * VOD 영상 파일 업로드를 위한 presigned URL을 생성합니다.
 * @param {string} courseId - 강좌 ID
 * @param {number} weekNumber - 주차 번호
 * @param {Array<{name: string, type: string, size: number}>} files - 업로드할 VOD 파일 정보 배열
 * @returns {Promise<Array<{fileName: string, sanitizedFileName: string, url: string, key: string}>>} - presigned URL 배열
 */
async function generateVodUploadUrls(courseId, weekNumber, files) {
    try {
        console.log('=== generateVodUploadUrls called ===');
        console.log('Request parameters:', {
            courseId,
            weekNumber,
            files: files.map(f => ({
                name: f.name,
                type: f.type,
                size: f.size
            }))
        });

        const presignedUrls = await Promise.all(
            files.map(async (file) => {
                const sanitizedFileName = sanitizePathComponent(file.name);
                const key = `${courseId}/${weekNumber}주차/${sanitizedFileName}`;
                
                console.log('Processing VOD file:', {
                    originalName: file.name,
                    sanitizedName: sanitizedFileName,
                    courseId,
                    key: key,
                    fileType: file.type,
                    fileSize: file.size,
                    bucket: 'nationslablmscoursebucket'
                });
                
                const command = new PutObjectCommand({
                    Bucket: 'nationslablmscoursebucket',
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
            courseId,
            weekNumber,
            filesCount: files?.length
        });
        throw error;
    }
}

/**
 * VOD 폴더의 영상 파일 목록을 조회합니다.
 * @param {string} englishTitle - 영문 강좌명
 * @param {string} userRole - 사용자 역할 ('ADMIN' | 'STUDENT')
 * @returns {Promise<Array>} - VOD 파일 목록
 */
async function listVodFiles(englishTitle, userRole = 'STUDENT') {
    try {
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: `vod/${englishTitle}/`
        });

        const response = await s3Client.send(command);
        
        const files = await Promise.all((response.Contents || [])
            .filter(item => {
                const fileName = item.Key.split('/').pop();
                // 관리자는 mp4만, 학생은 m3u8만 필터링
                if (userRole === 'ADMIN') {
                    return !item.Key.endsWith('/') && fileName.endsWith('.mp4');
                } else {
                    return !item.Key.endsWith('/') && fileName.endsWith('.m3u8');
                }
            })
            .map(async item => {
                const fileName = item.Key.split('/').pop();
                const isHlsFile = fileName.endsWith('.m3u8');
                const downloadable = await isFileDownloadable(item.Key);
                let downloadUrl = null;
                let streamingUrl = null;

                if (userRole === 'ADMIN' && !isHlsFile && downloadable) {
                    // 관리자용 다운로드 URL
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: item.Key,
                        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
                    });
                    downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                } else if (userRole === 'STUDENT' && isHlsFile && downloadable) {
                    // 학생용 스트리밍 URL
                    const command = new GetObjectCommand({
                        Bucket: 'nationslablmscoursebucket',
                        Key: item.Key
                    });
                    streamingUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                }

                return {
                    key: item.Key,
                    fileName,
                    lastModified: item.LastModified,
                    size: item.Size,
                    type: getFileType(item.Key),
                    downloadable,
                    downloadUrl,
                    streamingUrl,  // 스트리밍 URL 추가
                    isHlsFile,
                    baseFileName: fileName.split('.')[0]
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
        // 파일 경로에서 기본 정보 추출
        const pathParts = key.split('/');
        const fileName = pathParts.pop();
        const folderPath = pathParts.join('/');
        
        // 해당 파일의 권한만 업데이트
        const encodedCopySource = encodeURIComponent(`${bucketName}/${key}`);
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
        console.log('Updated permission for file:', {
            key: key,
            isDownloadable
        });

        // 만약 이 파일이 mp4 파일이라면, 관련된 m3u8와 ts 파일들의 권한도 업데이트
        if (fileName.endsWith('.mp4')) {
            const baseFileName = fileName.split('.')[0].replace(/\d+x\d+_\d+mbps_qvpr$/, '');
            
            // 관련된 모든 파일의 키 목록 조회
            const command = new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: `${folderPath}/`
            });
            
            const response = await s3Client.send(command);
            const relatedFiles = (response.Contents || [])
                .filter(item => {
                    const itemFileName = item.Key.split('/').pop();
                    return (itemFileName.startsWith(baseFileName) &&
                           (itemFileName.endsWith('.m3u8') || 
                            itemFileName.endsWith('.ts'))) ||
                           (itemFileName.startsWith(baseFileName) && 
                            itemFileName.includes('_qvpr'));
                })
                .map(item => item.Key);

            // 관련 파일들의 권한 업데이트
            for (const fileKey of relatedFiles) {
                const encodedRelatedCopySource = encodeURIComponent(`${bucketName}/${fileKey}`);
                const relatedCopyCommand = new CopyObjectCommand({
                    Bucket: bucketName,
                    CopySource: encodedRelatedCopySource,
                    Key: fileKey,
                    Metadata: {
                        downloadable: String(isDownloadable)
                    },
                    MetadataDirective: 'REPLACE'
                });

                await s3Client.send(relatedCopyCommand);
                // console.log('Updated permission for related file:', {
                //     key: fileKey,
                //     isDownloadable
                // });
            }
        }
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

/**
 * 과제/퀴즈 파일 목록을 조회합니다.
 * @param {string} itemId - 평가 항목 ID
 * @returns {Promise<Array>} - 파일 목록
 */
async function listAssignmentFiles(itemId) {
    try {
        console.log('=== listAssignmentFiles called ===');
        console.log('Request parameters:', { itemId });

        const prefix = `assignments/${itemId}/`;
        
        const command = new ListObjectsV2Command({
            Bucket: 'nationslablmscoursebucket',
            Prefix: prefix,
            Delimiter: '/'
        });

        const response = await s3Client.send(command);
        
        // S3 응답에서 파일 목록 추출
        const files = [];
        
        // Contents에는 파일 목록이 포함됨
        if (response.Contents) {
            for (const item of response.Contents) {
                // 폴더 자체는 제외
                if (item.Key !== prefix) {
                    const fileName = item.Key.replace(prefix, '');
                    const fileType = getFileType(fileName);
                    const isDownloadable = await isFileDownloadable(item.Key);
                    
                    files.push({
                        key: item.Key,
                        fileName,
                        fileType,
                        lastModified: item.LastModified,
                        size: item.Size,
                        isDownloadable
                    });
                }
            }
        }
        
        console.log(`Found ${files.length} files for assignment item ${itemId}`);
        return files;
    } catch (error) {
        console.error(`Error listing assignment files for item ${itemId}:`, error);
        throw error;
    }
}

module.exports = {
    listCourseWeekMaterials,
    listWeekFiles,
    getFileType,
    createEmptyFolder,
    generateUploadUrls,
    createVodFolder,
    generateVodUploadUrls,
    listVodFiles,
    updateFileDownloadPermission,
    isFileDownloadable,
    generateDownloadUrl,
    sanitizePathComponent,
    listAssignmentFiles
}; 