const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { v4: uuidv4 } = require('uuid');

// Zoom API 설정
const ZOOM_API_KEY = process.env.ZOOM_API_KEY;
const ZOOM_API_SECRET = process.env.ZOOM_API_SECRET;
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Zoom Webhook 시크릿 토큰
const WEBHOOK_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const WEBHOOK_VERIFICATION_TOKEN = process.env.ZOOM_WEBHOOK_VERIFICATION_TOKEN;

// Zoom API 토큰 발급 함수
async function getZoomToken() {
    try {
        const authHeader = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
        const response = await axios.post('https://zoom.us/oauth/token', 
            'grant_type=account_credentials&account_id=' + ZOOM_ACCOUNT_ID,
            {
                headers: {
                    'Authorization': `Basic ${authHeader}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        
        return response.data.access_token;
    } catch (error) {
        console.error('Zoom 토큰 발급 오류:', error.response?.data || error.message);
        throw new Error('Zoom API 토큰 발급에 실패했습니다.');
    }
}

// 강의용 Zoom 미팅 생성 함수 (외부에서 호출 가능)
async function createZoomMeeting(courseTitle, startTime = null, duration = 60, recurrence = null) {
    try {
        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // 시작 시간이 제공되지 않은 경우 기본값 설정 (현재 시간 + 1일)
        if (!startTime) {
            startTime = new Date();
            startTime.setDate(startTime.getDate() + 1);
            startTime.setHours(9, 0, 0, 0); // 다음날 오전 9시
        }

        // 기본 반복 설정
        const defaultRecurrence = {
            type: 2, // 주간 반복
            repeat_interval: 1, // 매주
            weekly_days: "2", // 화요일(2)만 설정
            end_date_time: (() => {
                const endDate = new Date(startTime);
                endDate.setMonth(endDate.getMonth() + 3); // 3달 후
                return endDate.toISOString();
            })()
        };

        // 미팅 설정
        const meetingSettings = {
            topic: courseTitle,
            type: 8, // 반복 미팅
            start_time: startTime.toISOString(),
            duration,
            timezone: 'Asia/Seoul',
            settings: {
                host_video: true,
                participant_video: true,
                join_before_host: false,
                mute_upon_entry: true,
                waiting_room: true,
                auto_recording: 'cloud' // 자동 녹화 설정
            },
            recurrence: recurrence || {
                type: 2, // 주간 반복
                repeat_interval: 1, // 매주
                weekly_days: "2", // 화요일(2)만 설정
                end_date_time: (() => {
                    const endDate = new Date(startTime);
                    endDate.setMonth(endDate.getMonth() + 3); // 3달 후
                    return endDate.toISOString();
                })()
            }
        };

        // Zoom 미팅 생성 요청
        const zoomResponse = await axios.post(
            'https://api.zoom.us/v2/users/me/meetings',
            meetingSettings,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            success: true,
            meeting_id: zoomResponse.data.id,
            join_url: zoomResponse.data.join_url,
            password: zoomResponse.data.password,
            start_time: zoomResponse.data.start_time,
            duration: zoomResponse.data.duration,
            recurrence: zoomResponse.data.recurrence,
            data: zoomResponse.data
        };
    } catch (error) {
        console.error('Zoom 미팅 생성 오류:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

// 공통 함수: 현재 진행 중인 미팅 목록 조회
async function getLiveMeetings(token) {
    // 현재 사용자의 정보 조회
    const userResponse = await axios.get(
        'https://api.zoom.us/v2/users/me',
        {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }
    );
    
    const userId = userResponse.data.id;
    
    // 현재 진행 중인 미팅 목록 조회
    const meetingsResponse = await axios.get(
        `https://api.zoom.us/v2/users/${userId}/meetings`,
        {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                type: 'live', // 현재 진행 중인 미팅만 조회
                page_size: 100
            }
        }
    );
    
    return {
        userId,
        userInfo: userResponse.data,
        meetings: meetingsResponse.data
    };
}

// 공통 함수: 미팅 상태 및 참가자 정보 조회
async function getMeetingStatusAndParticipants(meetingId, token) {
    // 미팅 정보 조회
    const meetingResponse = await axios.get(
        `https://api.zoom.us/v2/meetings/${meetingId}`,
        {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }
    );
    
    // 미팅 상태 확인
    const meetingInfo = meetingResponse.data;
    let participantsData = { participants: [] };
    let meetingStatus = "scheduled";
    
    // 미팅 상태 확인 시도
    try {
        const statusResponse = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}/status`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        
        meetingStatus = statusResponse.data.status || "unknown";
    } catch (statusError) {
        console.log('미팅 상태 조회 실패, 기본값 사용:', statusError.response?.data || statusError.message);
    }
    
    // 참가자 정보 조회 시도 (여러 API 엔드포인트 시도)
    const participantEndpoints = [
        // 1. 실시간 참가자 (Dashboard API)
        {
            url: `https://api.zoom.us/v2/metrics/meetings/${meetingId}/participants`,
            params: { page_size: 100, type: 'live' },
            name: 'Dashboard API'
        },
        // 2. 미팅 참가자 (Meeting API)
        {
            url: `https://api.zoom.us/v2/meetings/${meetingId}/participants`,
            params: { page_size: 100 },
            name: 'Meeting API'
        },
        // 3. 과거 미팅 참가자 (Past Meeting API)
        {
            url: `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
            params: { page_size: 100 },
            name: 'Past Meeting API'
        },
        // 4. 보고서 참가자 (Report API)
        {
            url: `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`,
            params: { page_size: 100 },
            name: 'Report API'
        },
        // 5. 등록된 참가자 (Registrants API)
        {
            url: `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
            params: { page_size: 100, status: 'approved' },
            name: 'Registrants API'
        }
    ];
    
    // 각 엔드포인트를 순차적으로 시도
    let successfulEndpoint = null;
    
    for (const endpoint of participantEndpoints) {
        try {
            console.log(`${endpoint.name} 엔드포인트로 참가자 정보 조회 시도...`);
            
            const response = await axios.get(
                endpoint.url,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: endpoint.params
                }
            );
            
            // 참가자 데이터 형식 통일
            if (response.data.participants) {
                participantsData = response.data;
                successfulEndpoint = endpoint.name;
                console.log(`${endpoint.name}에서 참가자 ${participantsData.participants.length}명 조회 성공`);
                break;
            } else if (response.data.registrants) {
                // 등록된 참가자 형식 변환
                participantsData = {
                    participants: response.data.registrants.map(r => ({
                        id: r.id,
                        user_id: r.id,
                        name: r.first_name + ' ' + r.last_name,
                        email: r.email,
                        join_time: r.create_time,
                        status: r.status
                    }))
                };
                successfulEndpoint = endpoint.name;
                console.log(`${endpoint.name}에서 등록된 참가자 ${participantsData.participants.length}명 조회 성공`);
                break;
            }
        } catch (error) {
            console.log(`${endpoint.name} 참가자 정보 조회 실패:`, error.response?.data?.message || error.message);
        }
    }
    
    // 데이터베이스에서 참가자 정보 조회 (Webhook으로 수집된 데이터)
    try {
        const client = await masterPool.connect();
        try {
            const dbResult = await client.query(
                `SELECT * FROM ${SCHEMAS.COURSE}.zoom_meeting_participants
                 WHERE meeting_id = $1
                 ORDER BY join_time DESC`,
                [meetingId]
            );
            
            if (dbResult.rows.length > 0) {
                console.log(`데이터베이스에서 참가자 ${dbResult.rows.length}명 조회 성공`);
                
                // API에서 참가자 정보를 가져오지 못한 경우 DB 데이터 사용
                if (participantsData.participants.length === 0) {
                    participantsData = {
                        participants: dbResult.rows.map(row => ({
                            id: row.participant_id,
                            user_id: row.participant_id,
                            name: row.participant_name,
                            join_time: row.join_time,
                            leave_time: row.leave_time,
                            duration: row.duration
                        }))
                    };
                    successfulEndpoint = 'Database';
                }
                
                // 현재 접속 중인 참가자 필터링 (leave_time이 없는 참가자)
                const activeParticipants = dbResult.rows.filter(row => row.leave_time === null);
                
                // 추가 정보로 제공
                participantsData.db_participants = {
                    total: dbResult.rows.length,
                    active: activeParticipants.length,
                    active_list: activeParticipants.map(row => ({
                        id: row.participant_id,
                        name: row.participant_name,
                        join_time: row.join_time
                    }))
                };
            }
        } finally {
            client.release();
        }
    } catch (dbError) {
        console.error('DB에서 참가자 정보 조회 실패:', dbError);
    }
    
    return {
        meeting: meetingInfo,
        status: meetingStatus,
        participants: participantsData,
        data_source: successfulEndpoint,
        timestamp: new Date().toISOString()
    };
}

// 공통 함수: 강의 관련 Zoom 미팅 정보 조회
async function getCourseMeetingInfo(meetingId) {
    const client = await masterPool.connect();
    let courseInfo = null;
    
    try {
        const dbResult = await client.query(
            `SELECT zm.*, c.title as course_title, c.description as course_description 
             FROM ${SCHEMAS.COURSE}.zoom_meetings zm
             LEFT JOIN ${SCHEMAS.COURSE}.courses c ON zm.course_id = c.id
             WHERE zm.zoom_meeting_id = $1`,
            [meetingId]
        );
        
        if (dbResult.rows.length > 0) {
            courseInfo = dbResult.rows[0];
        }
    } catch (dbError) {
        console.error('DB 조회 오류:', dbError);
    } finally {
        client.release();
    }
    
    return courseInfo;
}

// Zoom Webhook 시그니처 검증 미들웨어
const verifyZoomWebhook = (req, res, next) => {
    try {
        const timestamp = req.headers['x-zm-request-timestamp'];
        const signature = req.headers['x-zm-signature'];
        const token = req.headers['x-zm-verification-token'];

        // 검증 토큰 확인
        if (token !== WEBHOOK_VERIFICATION_TOKEN) {
            console.error('Zoom Webhook 검증 토큰이 일치하지 않습니다.');
            return res.status(401).json({ 
                success: false, 
                message: '유효하지 않은 검증 토큰' 
            });
        }

        // 시그니처 검증
        if (timestamp && signature) {
            const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
            const hashForVerify = crypto.createHmac('sha256', WEBHOOK_SECRET_TOKEN)
                .update(message)
                .digest('hex');
            const computedSignature = `v0=${hashForVerify}`;

            if (computedSignature === signature) {
                return next();
            }
        }

        console.error('Zoom Webhook 시그니처 검증 실패');
        return res.status(401).json({ 
            success: false, 
            message: '유효하지 않은 시그니처' 
        });
    } catch (error) {
        console.error('Webhook 검증 중 오류:', error);
        return res.status(500).json({ 
            success: false, 
            message: '웹훅 검증 중 오류 발생' 
        });
    }
};

// Zoom Webhook 이벤트 처리
router.post('/webhook', verifyZoomWebhook, async (req, res) => {
    try {
        const event = req.body;
        console.log('Zoom Webhook 이벤트 수신:', JSON.stringify(event, null, 2));

        // 이벤트 타입에 따른 처리
        switch (event.event) {
            case 'meeting.started':
                await handleMeetingStarted(event);
                break;
            case 'meeting.ended':
                await handleMeetingEnded(event);
                break;
            case 'meeting.participant_joined':
                await handleParticipantJoined(event);
                break;
            case 'meeting.participant_left':
                await handleParticipantLeft(event);
                break;
            default:
                console.log('처리되지 않은 이벤트 타입:', event.event);
        }

        res.status(200).json({ 
            success: true, 
            message: '이벤트가 성공적으로 처리되었습니다.' 
        });
    } catch (error) {
        console.error('Webhook 이벤트 처리 중 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: '이벤트 처리 중 오류가 발생했습니다.' 
        });
    }
});

// 미팅 시작 이벤트 처리
async function handleMeetingStarted(event) {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        
        // zoom_meetings 테이블 업데이트
        await client.query(
            `UPDATE ${SCHEMAS.COURSE}.zoom_meetings 
            SET status = 'STARTED', 
                actual_start_time = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE zoom_meeting_id = $2`,
            [new Date(event.payload.object.start_time), event.payload.object.id]
        );

        await client.query('COMMIT');
        console.log('미팅 시작 처리 완료:', event.payload.object.id);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('미팅 시작 처리 중 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 미팅 종료 이벤트 처리
async function handleMeetingEnded(event) {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        
        // zoom_meetings 테이블 업데이트
        await client.query(
            `UPDATE ${SCHEMAS.COURSE}.zoom_meetings 
            SET status = 'ENDED', 
                actual_end_time = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE zoom_meeting_id = $2`,
            [new Date(event.payload.object.end_time), event.payload.object.id]
        );

        await client.query('COMMIT');
        console.log('미팅 종료 처리 완료:', event.payload.object.id);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('미팅 종료 처리 중 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 참가자 입장 이벤트 처리
async function handleParticipantJoined(event) {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        
        // zoom_meeting_participants 테이블에 참가 기록 추가
        await client.query(
            `INSERT INTO ${SCHEMAS.COURSE}.zoom_meeting_participants
            (id, meeting_id, participant_id, participant_name, join_time)
            VALUES ($1, $2, $3, $4, $5)`,
            [
                crypto.randomUUID(),
                event.payload.object.id,
                event.payload.object.participant.user_id || event.payload.object.participant.id,
                event.payload.object.participant.user_name,
                new Date(event.payload.object.participant.join_time)
            ]
        );

        await client.query('COMMIT');
        console.log('참가자 입장 처리 완료:', event.payload.object.participant.user_name);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('참가자 입장 처리 중 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 참가자 퇴장 이벤트 처리
async function handleParticipantLeft(event) {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        
        // zoom_meeting_participants 테이블 업데이트
        await client.query(
            `UPDATE ${SCHEMAS.COURSE}.zoom_meeting_participants
            SET leave_time = $1,
                duration = EXTRACT(EPOCH FROM ($1 - join_time))/60
            WHERE meeting_id = $2 
            AND participant_id = $3
            AND leave_time IS NULL`,
            [
                new Date(event.payload.object.participant.leave_time),
                event.payload.object.id,
                event.payload.object.participant.user_id || event.payload.object.participant.id
            ]
        );

        await client.query('COMMIT');
        console.log('참가자 퇴장 처리 완료:', event.payload.object.participant.user_name);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('참가자 퇴장 처리 중 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 강의 생성 시 Zoom 미팅 URL 발급 API
router.post('/create-course-meeting', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { 
            courseTitle,
            startTime,
            duration = 180, // 3시간으로 기본값 변경
            recurrence
        } = req.body;

        if (!courseTitle) {
            return res.status(400).json({
                success: false,
                message: "강의 제목은 필수 항목입니다."
            });
        }

        // 시작 시간이 제공되지 않은 경우, 다음 화요일 19시로 설정
        let meetingStartTime = startTime ? new Date(startTime) : null;
        if (!meetingStartTime) {
            meetingStartTime = new Date();
            meetingStartTime.setHours(19, 0, 0, 0); // 19시로 설정
            
            // 다음 화요일로 설정
            const currentDay = meetingStartTime.getDay();
            const daysUntilTuesday = (2 + 7 - currentDay) % 7;
            meetingStartTime.setDate(meetingStartTime.getDate() + daysUntilTuesday);
        }

        // 기본 반복 설정
        const defaultRecurrence = {
            type: 2, // 주간 반복
            repeat_interval: 1, // 매주
            weekly_days: "2", // 화요일(2)만 설정
            end_date_time: (() => {
                const endDate = new Date(meetingStartTime);
                endDate.setMonth(endDate.getMonth() + 3); // 3달 후
                return endDate.toISOString();
            })()
        };

        // Zoom 미팅 생성
        const meetingResult = await createZoomMeeting(
            courseTitle, 
            meetingStartTime,
            duration,
            recurrence || defaultRecurrence
        );

        if (!meetingResult.success) {
            return res.status(500).json({
                success: false,
                message: "Zoom 미팅 생성 중 오류가 발생했습니다.",
                error: meetingResult.error
            });
        }

        res.json({
            success: true,
            message: "Zoom 미팅이 생성되었습니다.",
            data: {
                join_url: meetingResult.join_url,
                meeting_id: meetingResult.meeting_id,
                password: meetingResult.password,
                start_time: meetingResult.start_time,
                duration: meetingResult.duration,
                recurrence: meetingResult.recurrence
            }
        });
    } catch (error) {
        console.error('Zoom 미팅 생성 오류:', error);
        res.status(500).json({
            success: false,
            message: "Zoom 미팅 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

// 테스트용 강의 생성 API
router.post('/create-lecture', async (req, res) => {
    try {
        const { 
            topic = '테스트 강의',
            duration = 180, // 기본값 3시간
            courseId = null
        } = req.body;

        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // 시작 날짜 설정 (4월 17일)
        const startTime = new Date('2024-04-17T16:00:00');
        
        // 종료 날짜 설정 (3개월 후)
        const endDate = new Date(startTime);
        endDate.setMonth(endDate.getMonth() + 3);
        
        console.log(`시작 시간: ${startTime.toISOString()}, 종료 시간: ${endDate.toISOString()}`);

        // 미팅 설정
        const meetingSettings = {
            topic,
            type: 8, // 반복 미팅 (8 = 반복 미팅)
            start_time: startTime.toISOString(),
            duration: parseInt(duration),
            timezone: 'Asia/Seoul',
            recurrence: {
                type: 2, // 주간 반복
                repeat_interval: 1, // 매주
                weekly_days: "2", // 화요일(2)
                end_date_time: endDate.toISOString() // 종료 날짜 (3개월 후)
            },
            settings: {
                host_video: true,
                participant_video: true,
                join_before_host: true,
                mute_upon_entry: true,
                waiting_room: true,
                auto_recording: "cloud"
            }
        };

        console.log('Zoom API 요청 설정:', JSON.stringify(meetingSettings, null, 2));

        // Zoom 미팅 생성 요청
        const zoomResponse = await axios.post(
            'https://api.zoom.us/v2/users/me/meetings',
            meetingSettings,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Zoom API 응답:', JSON.stringify(zoomResponse.data, null, 2));

        // DB에 미팅 정보 저장 (courseId가 제공된 경우)
        let dbResult = null;
        if (courseId) {
            const client = await masterPool.connect();
            try {
                await client.query('BEGIN');
                
                const insertResult = await client.query(
                    `INSERT INTO ${SCHEMAS.COURSE}.zoom_meetings
                    (id, course_id, topic, start_time, duration, zoom_meeting_id, zoom_join_url, zoom_password)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING *`,
                    [
                        uuidv4(),
                        courseId,
                        topic,
                        startTime,
                        duration,
                        zoomResponse.data.id,
                        zoomResponse.data.join_url,
                        zoomResponse.data.password
                    ]
                );

                await client.query('COMMIT');
                dbResult = insertResult.rows[0];
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('DB 저장 오류:', error);
            } finally {
                client.release();
            }
        }

        res.json({
            success: true,
            message: "테스트 강의가 생성되었습니다.",
            data: {
                zoom_meeting: zoomResponse.data,
                db_record: dbResult
            }
        });
    } catch (error) {
        console.error('테스트 강의 생성 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "테스트 강의 생성 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 테스트용 참가자 로그 조회 API
router.get('/participants/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // Zoom API에서 참가자 정보 조회
        const zoomResponse = await axios.get(
            `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        res.json({
            success: true,
            data: zoomResponse.data
        });
    } catch (error) {
        console.error('참가자 로그 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "참가자 로그 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 실시간 참가자 모니터링 API
router.get('/live-participants/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 등록된 참가자 정보 조회
        const registrantsResponse = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    page_size: 100,
                    status: 'approved'
                }
            }
        );
        
        res.json({
            success: true,
            message: "현재 미팅 참가자 정보가 조회되었습니다.",
            data: registrantsResponse.data,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('참가자 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "참가자 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 현재 진행 중인 미팅 목록 조회 API
router.get('/live-meetings', async (req, res) => {
    try {
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 공통 함수를 사용하여 진행 중인 미팅 목록 조회
        const liveMeetingsData = await getLiveMeetings(token);
        
        res.json({
            success: true,
            message: "현재 진행 중인 미팅 목록이 조회되었습니다.",
            data: liveMeetingsData.meetings,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('진행 중인 미팅 목록 조회 오류:', error.response?.data || error.message);
        
        // 대체 방법으로 모든 예정된 미팅 조회 시도
        try {
            const token = await getZoomToken();
            
            const userResponse = await axios.get(
                'https://api.zoom.us/v2/users/me',
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            
            const userId = userResponse.data.id;
            
            const allMeetingsResponse = await axios.get(
                `https://api.zoom.us/v2/users/${userId}/meetings`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100
                    }
                }
            );
            
            res.json({
                success: true,
                message: "모든 미팅 목록이 조회되었습니다. (진행 중인 미팅 조회 실패)",
                data: allMeetingsResponse.data,
                originalError: error.response?.data?.message || error.message,
                timestamp: new Date().toISOString()
            });
        } catch (secondError) {
            res.status(500).json({
                success: false,
                message: "미팅 목록 조회 중 오류가 발생했습니다.",
                error: secondError.response?.data?.message || secondError.message,
                originalError: error.response?.data?.message || error.message
            });
        }
    }
});

// 미팅 상태 확인 및 참가자 정보 조회 API
router.get('/meeting-status/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 공통 함수를 사용하여 미팅 상태 및 참가자 정보 조회
        const meetingData = await getMeetingStatusAndParticipants(meetingId, token);
        
        res.json({
            success: true,
            message: "미팅 상태 및 참가자 정보가 조회되었습니다.",
            data: meetingData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('미팅 상태 및 참가자 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "미팅 상태 및 참가자 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 테스트용 미팅 상세 정보 조회 API
router.get('/meeting/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // Zoom API에서 미팅 정보 조회
        const zoomResponse = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        res.json({
            success: true,
            data: zoomResponse.data
        });
    } catch (error) {
        console.error('미팅 정보 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "미팅 정보 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 진행 중인 미팅에 초점을 맞춘 간소화된 대시보드 요약 API
router.get('/dashboard-summary', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 공통 함수를 사용하여 진행 중인 미팅 목록 조회
        const liveMeetingsData = await getLiveMeetings(token);
        const userId = liveMeetingsData.userId;
        const userInfo = liveMeetingsData.userInfo;
        const liveMeetingsResponse = liveMeetingsData.meetings;
        
        // 예정된 미팅 목록 조회 - 간소화 (가장 가까운 3개만)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const scheduledMeetingsResponse = await axios.get(
            `https://api.zoom.us/v2/users/${userId}/meetings`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    type: 'scheduled',
                    page_size: 10
                }
            }
        );
        
        // 오늘 이후 예정된 미팅만 필터링 (최대 3개) - 진행 중인 미팅 제외
        const upcomingMeetings = scheduledMeetingsResponse.data.meetings
            .filter(meeting => {
                // 시작 시간이 없는 경우 제외
                if (!meeting.start_time) return false;
                
                // 시작 시간이 현재보다 미래인 경우만 포함
                const meetingDate = new Date(meeting.start_time);
                const now = new Date();
                
                // 진행 중인 미팅인지 확인 (liveMeetingsResponse.meetings에 존재하는지)
                const isLiveMeeting = liveMeetingsResponse.meetings && 
                                      liveMeetingsResponse.meetings.some(live => live.id === meeting.id);
                
                // 미래의 미팅이면서 현재 진행 중이 아닌 미팅만 포함
                return meetingDate > now && !isLiveMeeting;
            })
            .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
            .slice(0, 3)
            .map(meeting => ({
                id: meeting.id,
                topic: meeting.topic,
                start_time: meeting.start_time,
                duration: meeting.duration,
                join_url: meeting.join_url
            }));
        
        // DB에서 미팅 ID와 코스 정보 매핑 데이터 미리 조회
        const client = await masterPool.connect();
        let meetingToCourseMap = {};
        
        try {
            // zoom_meetings 테이블을 통해 미팅 ID와 코스 정보 매핑
            const dbResult = await client.query(`
                SELECT zm.zoom_meeting_id, c.id as course_id, c.title as course_title
                FROM ${SCHEMAS.COURSE}.zoom_meetings zm
                JOIN ${SCHEMAS.COURSE}.courses c ON zm.course_id = c.id
            `);
            
            // 미팅 ID를 키로 한 해시맵 생성
            if (dbResult.rows.length > 0) {
                dbResult.rows.forEach(row => {
                    meetingToCourseMap[row.zoom_meeting_id] = {
                        course_id: row.course_id,
                        course_title: row.course_title
                    };
                });
            }
        } catch (dbError) {
            console.error('DB 조회 오류:', dbError);
        } finally {
            client.release();
        }
        
        // 현재 진행 중인 미팅에 대한 참가자 정보 수집 - 간소화
        const simplifiedLiveMeetings = [];
        
        if (liveMeetingsResponse.meetings && liveMeetingsResponse.meetings.length > 0) {
            for (const meeting of liveMeetingsResponse.meetings) {
                try {
                    // 참가자 정보 조회 - 여러 API 엔드포인트 시도
                    let participants = [];
                    let participantsFetched = false;
                    
                    // 1. 먼저 실시간 참가자 시도 (Dashboard API)
                    try {
                        const response = await axios.get(
                            `https://api.zoom.us/v2/metrics/meetings/${meeting.id}/participants`,
                            {
                                headers: {
                                    'Authorization': `Bearer ${token}`
                                },
                                params: {
                                    page_size: 300,
                                    type: 'live'
                                }
                            }
                        );
                        
                        if (response.data && response.data.participants && response.data.participants.length > 0) {
                            participants = response.data.participants;
                            participantsFetched = true;
                        }
                    } catch (error) {
                        console.log('Dashboard API 참가자 조회 실패:', error.message);
                    }
                    
                    // 2. 실패 시 미팅 참가자 API 시도 (Meeting API)
                    if (!participantsFetched) {
                        try {
                            const response = await axios.get(
                                `https://api.zoom.us/v2/meetings/${meeting.id}/participants`,
                                {
                                    headers: {
                                        'Authorization': `Bearer ${token}`
                                    },
                                    params: {
                                        page_size: 300
                                    }
                                }
                            );
                            
                            if (response.data && response.data.participants && response.data.participants.length > 0) {
                                participants = response.data.participants;
                                participantsFetched = true;
                            }
                        } catch (error) {
                            console.log('Meeting API 참가자 조회 실패:', error.message);
                        }
                    }
                    
                    // 3. 실패 시 과거 미팅 참가자 API 시도 (Past Meeting API)
                    if (!participantsFetched) {
                        try {
                            const response = await axios.get(
                                `https://api.zoom.us/v2/past_meetings/${meeting.id}/participants`,
                                {
                                    headers: {
                                        'Authorization': `Bearer ${token}`
                                    },
                                    params: {
                                        page_size: 300
                                    }
                                }
                            );
                            
                            if (response.data && response.data.participants && response.data.participants.length > 0) {
                                participants = response.data.participants;
                                participantsFetched = true;
                            }
                        } catch (error) {
                            console.log('Past Meeting API 참가자 조회 실패:', error.message);
                        }
                    }
                    
                    // 미리 조회한 맵에서 코스 정보 조회
                    const courseInfo = meetingToCourseMap[meeting.id.toString()] || null;
                    
                    // 매우 간소화된 참가자 정보
                    const simplifiedParticipants = participants.map(participant => ({
                        name: participant.user_name || participant.name,
                        email: participant.user_email || '',
                        join_time: participant.join_time
                    }));
                    
                    // 미팅 시작 시간과 현재 시간으로 미팅 진행 시간 계산 (분 단위)
                    let meetingDuration = 0;
                    if (meeting.start_time) {
                        const meetingStartTime = new Date(meeting.start_time);
                        meetingDuration = Math.floor((new Date() - meetingStartTime) / (1000 * 60));
                    }
                    
                    // 매우 간소화된 미팅 정보
                    simplifiedLiveMeetings.push({
                        id: meeting.id,
                        topic: meeting.topic,
                        start_time: meeting.start_time,
                        duration: meeting.duration,
                        course_id: courseInfo?.course_id || null,
                        course_title: courseInfo?.course_title || null,
                        participant_count: simplifiedParticipants.length,
                        participants: simplifiedParticipants
                    });
                } catch (error) {
                    console.error(`미팅 ${meeting.id} 참가자 조회 실패:`, error.message);
                    // 기본 정보만 포함
                    simplifiedLiveMeetings.push({
                        id: meeting.id,
                        topic: meeting.topic,
                        start_time: meeting.start_time,
                        duration: meeting.duration,
                        participant_count: 0,
                        participants: []
                    });
                }
            }
        }
        
        // 최근 종료된 미팅 - 매우 간소화 (최대 3개)
        const pastMeetingsResponse = await axios.get(
            `https://api.zoom.us/v2/users/${userId}/meetings`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    type: 'past',
                    page_size: 10
                }
            }
        );
        
        // 실제로 종료된 미팅만 필터링
        const recentPastMeetings = pastMeetingsResponse.data.meetings
            .filter(meeting => {
                if (!meeting.start_time) return false;
                
                // 시작 시간이 현재보다 과거인지 확인
                const meetingDate = new Date(meeting.start_time);
                const now = new Date();
                const meetingEndTime = new Date(meetingDate);
                meetingEndTime.setMinutes(meetingEndTime.getMinutes() + (meeting.duration || 60)); // 종료 시간 계산
                
                // 미팅이 이미 종료되었는지 확인 (종료 시간 < 현재 시간)
                const isMeetingEnded = meetingEndTime < now;
                
                // 진행 중인 미팅인지 확인
                const isLiveMeeting = liveMeetingsResponse.meetings && 
                                      liveMeetingsResponse.meetings.some(live => live.id === meeting.id);
                
                // 종료된 미팅이고 현재 진행 중이 아닌 미팅만 포함
                return isMeetingEnded && !isLiveMeeting;
            })
            .sort((a, b) => new Date(b.start_time) - new Date(a.start_time)) // 최신순 정렬
            .slice(0, 3)
            .map(meeting => ({
                id: meeting.id,
                topic: meeting.topic,
                start_time: meeting.start_time,
                duration: meeting.duration
            }));
        
        // 매우 간소화된 응답 데이터
        const responseData = {
            live_meetings: {
                count: simplifiedLiveMeetings.length,
                meetings: simplifiedLiveMeetings
            },
            upcoming_meetings: {
                count: upcomingMeetings.length,
                meetings: upcomingMeetings
            },
            recent_past_meetings: {
                count: recentPastMeetings.length,
                meetings: recentPastMeetings
            },
            timestamp: new Date().toISOString()
        };
        
        res.json({
            success: true,
            message: "Zoom 대시보드 요약 정보가 조회되었습니다.",
            data: responseData
        });
    } catch (error) {
        console.error('Zoom 대시보드 요약 정보 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "Zoom 대시보드 요약 정보 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 특정 미팅의 실시간 참가자 정보 조회 API
router.get('/dashboard-meeting-detail/:meetingId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 공통 함수를 사용하여 미팅 상태 및 참가자 정보 조회
        const meetingData = await getMeetingStatusAndParticipants(meetingId, token);
        
        // 공통 함수를 사용하여 강의 관련 정보 조회
        const courseInfo = await getCourseMeetingInfo(meetingId);
        
        // 응답 데이터 구성
        const responseData = {
            meeting: meetingData.meeting,
            status: meetingData.status,
            participants: meetingData.participants.participants || [],
            participant_count: meetingData.participants.participants ? meetingData.participants.participants.length : 0,
            course_info: courseInfo,
            is_course_meeting: !!courseInfo,
            timestamp: new Date().toISOString()
        };
        
        res.json({
            success: true,
            message: "미팅 상세 정보가 조회되었습니다.",
            data: responseData
        });
    } catch (error) {
        console.error('미팅 상세 정보 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "미팅 상세 정보 조회 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

// 함수 내보내기
module.exports = router;

// createZoomMeeting 함수도 외부에서 사용할 수 있도록 설정
module.exports.createZoomMeeting = createZoomMeeting; 