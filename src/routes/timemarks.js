const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { masterPool, SCHEMAS, TABLES } = require('../config/database');
const dynamodb = require('../config/dynamodb');
const {
    createTimemark,
    getTimemarks,
    updateTimemark,
    deleteTimemark,
    getAllNotes
} = require('../utils/dynamodb');

/**
 * 전체 노트 필기 조회 - 이 라우트를 먼저 정의해야 /:courseId/:videoId와 충돌하지 않음
 */
router.get('/notes/all', verifyToken, async (req, res) => {
    try {
        const userId = req.user.sub;

        console.log('📝 [전체 노트 필기 조회] 요청 시작:', {
            userId
        });

        // 노트 필기 목록 조회
        console.log('🔍 [전체 노트 필기 조회] DynamoDB 조회 시작');
        const notes = await getAllNotes(userId);
        
        if (notes.length === 0) {
            return res.json({
                success: true,
                data: []
            });
        }

        // 강의 정보 조회를 위한 courseId 목록 추출
        const courseIds = [...new Set(notes.map(note => note.courseId))];
        
        // 강의 정보 조회
        const coursesQuery = `
            SELECT id, title 
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = ANY($1)
        `;
        const coursesResult = await masterPool.query(coursesQuery, [courseIds]);
        const coursesMap = new Map(coursesResult.rows.map(course => [course.id, course.title]));

        // 노트를 강의별로 그룹화
        const groupedNotes = notes.reduce((acc, note) => {
            if (!acc[note.courseId]) {
                acc[note.courseId] = {
                    courseId: note.courseId,
                    courseTitle: coursesMap.get(note.courseId) || '알 수 없는 강의',
                    totalNotes: 0,
                    videoCount: 0,
                    lastUpdated: null,
                    preview: null,
                    videos: {},
                    notes: [] // 모든 노트 저장
                };
            }

            // 비디오별 그룹화
            if (!acc[note.courseId].videos[note.videoId]) {
                acc[note.courseId].videos[note.videoId] = {
                    videoId: note.videoId,
                    noteCount: 0,
                    notes: [] // 비디오별 노트 저장
                };
                acc[note.courseId].videoCount++;
            }

            // 비디오의 노트 수 업데이트
            acc[note.courseId].videos[note.videoId].noteCount++;
            acc[note.courseId].totalNotes++;

            // 노트 저장
            const noteWithFormattedTime = {
                ...note,
                formattedTime: note.formattedTime || formatTime(parseInt(note.timestamp))
            };
            
            // 비디오별 노트 배열에 추가
            acc[note.courseId].videos[note.videoId].notes.push(noteWithFormattedTime);
            
            // 강의별 전체 노트 배열에 추가
            acc[note.courseId].notes.push(noteWithFormattedTime);

            // 가장 최근 노트를 미리보기로 설정
            if (!acc[note.courseId].lastUpdated || new Date(note.updatedAt) > new Date(acc[note.courseId].lastUpdated)) {
                acc[note.courseId].preview = {
                    content: note.content.length > 50 ? note.content.substring(0, 50) + '...' : note.content,
                    formattedTime: noteWithFormattedTime.formattedTime,
                    videoId: note.videoId
                };
                acc[note.courseId].lastUpdated = note.updatedAt;
            }

            return acc;
        }, {});

        // 응답 데이터 구성
        const summaryData = Object.values(groupedNotes).map(course => ({
            courseId: course.courseId,
            courseTitle: course.courseTitle,
            totalNotes: course.totalNotes,
            videoCount: course.videoCount,
            lastUpdated: course.lastUpdated,
            preview: course.preview,
            videos: Object.values(course.videos).map(video => ({
                videoId: video.videoId,
                noteCount: video.noteCount,
                notes: video.notes.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp)) // 타임스탬프 순으로 정렬
            })),
            notes: course.notes.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp)) // 타임스탬프 순으로 정렬
        }));

        console.log('✅ [전체 노트 필기 조회] 데이터 가공 완료');

        res.json({
            success: true,
            data: summaryData
        });
    } catch (error) {
        console.error('❌ [전체 노트 필기 조회] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '노트 필기 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 생성
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        console.log('📝 [타임마크 생성] 요청 시작:', {
            body: req.body,
            userId: req.user.sub
        });

        const { courseId, videoId, timestamp, content } = req.body;
        const userId = req.user.sub;

        // 필수 필드 검증
        if (!courseId || !videoId || !timestamp || !content) {
            console.warn('❌ [타임마크 생성] 필수 필드 누락:', {
                courseId,
                videoId,
                timestamp,
                content
            });
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 수강 중인 강의인지 확인
        console.log('🔍 [타임마크 생성] 수강 상태 확인 중:', {
            userId,
            courseId
        });

        const enrollmentQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
        `;
        const enrollmentResult = await masterPool.query(enrollmentQuery, [userId, courseId]);

        if (enrollmentResult.rows.length === 0) {
            console.warn('❌ [타임마크 생성] 수강 중이 아닌 강의:', {
                userId,
                courseId
            });
            return res.status(403).json({
                success: false,
                message: '수강 중인 강의가 아닙니다.'
            });
        }

        console.log('✅ [타임마크 생성] 수강 상태 확인 완료');

        // 타임마크 생성
        console.log('💾 [타임마크 생성] DynamoDB 저장 시작');
        const timemark = await createTimemark({
            userId,
            courseId,
            videoId,
            timestamp,
            content
        });
        console.log('✅ [타임마크 생성] DynamoDB 저장 완료:', timemark);

        res.status(201).json({
            success: true,
            data: timemark
        });
    } catch (error) {
        console.error('❌ [타임마크 생성] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?.sub,
            body: req.body
        });
        res.status(500).json({
            success: false,
            message: '타임마크 생성 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 목록 조회
 */
router.get('/:courseId/:videoId', verifyToken, async (req, res) => {
    try {
        const { courseId, videoId } = req.params;
        const userId = req.user.sub;

        console.log('📝 [타임마크 조회] 요청 시작:', {
            courseId,
            videoId,
            userId
        });

        // 타임마크 목록 조회
        console.log('🔍 [타임마크 조회] DynamoDB 조회 시작');
        const timemarks = await getTimemarks(courseId, videoId, userId);
        console.log('✅ [타임마크 조회] DynamoDB 조회 완료:', {
            count: timemarks.length
        });

        res.json({
            success: true,
            data: timemarks
        });
    } catch (error) {
        console.error('❌ [타임마크 조회] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 수정
 */
router.put('/:timemarkId', verifyToken, async (req, res) => {
    try {
        const { timemarkId } = req.params;
        const { content, timestamp } = req.body;
        const userId = req.user.sub;

        console.log('📝 [타임마크 수정] 요청 시작:', {
            timemarkId,
            userId,
            body: req.body
        });

        if (!content || !timestamp) {
            console.warn('❌ [타임마크 수정] 필수 필드 누락:', {
                content,
                timestamp
            });
            return res.status(400).json({
                success: false,
                message: '필수 필드가 누락되었습니다.'
            });
        }

        // 타임마크 소유자 확인
        console.log('🔍 [타임마크 수정] 타임마크 조회 중');
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp: timestamp.toString()
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            console.warn('❌ [타임마크 수정] 타임마크 없음:', {
                timemarkId,
                timestamp
            });
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            console.warn('❌ [타임마크 수정] 권한 없음:', {
                timemarkId,
                ownerId: result.Item.userId,
                requesterId: userId
            });
            return res.status(403).json({
                success: false,
                message: '타임마크를 수정할 권한이 없습니다.'
            });
        }

        console.log('✅ [타임마크 수정] 권한 확인 완료');

        // 타임마크 수정
        console.log('💾 [타임마크 수정] DynamoDB 업데이트 시작');
        const updatedTimemark = await updateTimemark(timemarkId, timestamp.toString(), content);
        console.log('✅ [타임마크 수정] DynamoDB 업데이트 완료:', updatedTimemark);

        res.json({
            success: true,
            data: updatedTimemark
        });
    } catch (error) {
        console.error('❌ [타임마크 수정] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            body: req.body,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 수정 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 타임마크 삭제
 */
router.delete('/:timemarkId', verifyToken, async (req, res) => {
    try {
        const { timemarkId } = req.params;
        const { timestamp } = req.query;
        const userId = req.user.sub;

        console.log('📝 [타임마크 삭제] 요청 시작:', {
            timemarkId,
            timestamp,
            userId
        });

        if (!timestamp) {
            console.warn('❌ [타임마크 삭제] timestamp 파라미터 누락');
            return res.status(400).json({
                success: false,
                message: 'timestamp 쿼리 파라미터가 필요합니다.'
            });
        }

        // 타임마크 소유자 확인
        console.log('🔍 [타임마크 삭제] 타임마크 조회 중');
        const params = {
            TableName: 'LMSVOD_TimeMarks',
            Key: {
                id: timemarkId,
                timestamp
            }
        };

        const result = await dynamodb.get(params);
        if (!result.Item) {
            console.warn('❌ [타임마크 삭제] 타임마크 없음:', {
                timemarkId,
                timestamp
            });
            return res.status(404).json({
                success: false,
                message: '타임마크를 찾을 수 없습니다.'
            });
        }

        if (result.Item.userId !== userId) {
            console.warn('❌ [타임마크 삭제] 권한 없음:', {
                timemarkId,
                ownerId: result.Item.userId,
                requesterId: userId
            });
            return res.status(403).json({
                success: false,
                message: '타임마크를 삭제할 권한이 없습니다.'
            });
        }

        console.log('✅ [타임마크 삭제] 권한 확인 완료');

        // 타임마크 삭제
        console.log('🗑️ [타임마크 삭제] DynamoDB 삭제 시작');
        await deleteTimemark(timemarkId, timestamp);
        console.log('✅ [타임마크 삭제] DynamoDB 삭제 완료');

        res.json({
            success: true,
            message: '타임마크가 삭제되었습니다.'
        });
    } catch (error) {
        console.error('❌ [타임마크 삭제] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            params: req.params,
            query: req.query,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '타임마크 삭제 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 내 모든 노트 조회
 */
router.get('/my/notes', verifyToken, async (req, res) => {
    try {
        const userId = req.user.sub;

        console.log('📝 [내 노트 조회] 요청 시작 ================');
        console.log('1. 토큰 정보:', req.user);
        console.log('2. userId:', userId);

        // 노트 필기 목록 조회
        console.log('3. DynamoDB 조회 시작');
        const notes = await getAllNotes(userId);
        
        console.log('4. DynamoDB 조회 결과:', {
            notesCount: notes.length,
            notes: notes
        });

        if (notes.length === 0) {
            console.log('❌ 노트가 없습니다');
            return res.json({
                success: true,
                data: []
            });
        }

        // 강의 정보 조회를 위한 courseId 목록 추출
        const courseIds = [...new Set(notes.map(note => note.courseId))];
        console.log('5. 조회할 강의 ID:', courseIds);

        // 강의 정보 조회
        const coursesQuery = `
            SELECT id, title 
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = ANY($1)
        `;
        const coursesResult = await masterPool.query(coursesQuery, [courseIds]);
        console.log('6. 강의 정보 조회 결과:', coursesResult.rows);

        const coursesMap = new Map(coursesResult.rows.map(course => [course.id, course.title]));

        // 노트를 강의별로 그룹화
        const groupedNotes = notes.reduce((acc, note) => {
            if (!acc[note.courseId]) {
                acc[note.courseId] = {
                    courseId: note.courseId,
                    courseTitle: coursesMap.get(note.courseId) || '알 수 없는 강의',
                    totalNotes: 0,
                    videoCount: 0,
                    lastUpdated: null,
                    preview: null,
                    videos: {},
                    notes: [] // 모든 노트 저장
                };
            }

            // 비디오별 그룹화
            if (!acc[note.courseId].videos[note.videoId]) {
                acc[note.courseId].videos[note.videoId] = {
                    videoId: note.videoId,
                    noteCount: 0,
                    notes: [] // 비디오별 노트 저장
                };
                acc[note.courseId].videoCount++;
            }

            // 비디오의 노트 수 업데이트
            acc[note.courseId].videos[note.videoId].noteCount++;
            acc[note.courseId].totalNotes++;

            // 노트 저장
            const noteWithFormattedTime = {
                ...note,
                formattedTime: note.formattedTime || formatTime(parseInt(note.timestamp))
            };
            
            // 비디오별 노트 배열에 추가
            acc[note.courseId].videos[note.videoId].notes.push(noteWithFormattedTime);
            
            // 강의별 전체 노트 배열에 추가
            acc[note.courseId].notes.push(noteWithFormattedTime);

            // 가장 최근 노트를 미리보기로 설정
            if (!acc[note.courseId].lastUpdated || new Date(note.updatedAt) > new Date(acc[note.courseId].lastUpdated)) {
                acc[note.courseId].preview = {
                    content: note.content.length > 50 ? note.content.substring(0, 50) + '...' : note.content,
                    formattedTime: noteWithFormattedTime.formattedTime,
                    videoId: note.videoId
                };
                acc[note.courseId].lastUpdated = note.updatedAt;
            }

            return acc;
        }, {});

        // 응답 데이터 구성
        const summaryData = Object.values(groupedNotes).map(course => ({
            courseId: course.courseId,
            courseTitle: course.courseTitle,
            totalNotes: course.totalNotes,
            videoCount: course.videoCount,
            lastUpdated: course.lastUpdated,
            preview: course.preview,
            videos: Object.values(course.videos).map(video => ({
                videoId: video.videoId,
                noteCount: video.noteCount,
                notes: video.notes.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp)) // 타임스탬프 순으로 정렬
            })),
            notes: course.notes.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp)) // 타임스탬프 순으로 정렬
        }));

        console.log('7. 최종 응답 데이터:', {
            courseCount: summaryData.length,
            totalNotes: notes.length,
            firstCourse: summaryData[0]
        });

        res.json({
            success: true,
            data: summaryData
        });
    } catch (error) {
        console.error('❌ [내 노트 조회] 오류 발생:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?.sub
        });
        res.status(500).json({
            success: false,
            message: '노트 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 