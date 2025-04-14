const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

// Zoom API 설정
const ZOOM_API_KEY = process.env.ZOOM_API_KEY;
const ZOOM_API_SECRET = process.env.ZOOM_API_SECRET;
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Zoom Webhook 시크릿 토큰
const WEBHOOK_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const WEBHOOK_VERIFICATION_TOKEN = process.env.ZOOM_WEBHOOK_VERIFICATION_TOKEN;

// Zoom API Token 생성 함수
function generateZoomJWT() {
    const payload = {
        iss: process.env.ZOOM_API_KEY,
        exp: new Date().getTime() + 5000
    };

    return jwt.sign(payload, process.env.ZOOM_API_SECRET);
}

// Zoom API 토큰 발급 함수
async function getZoomToken() {
    try {
        console.log('🔵 Zoom API 토큰 요청 시작...');
        console.log('  - ZOOM_CLIENT_ID 설정됨:', Boolean(ZOOM_CLIENT_ID));
        console.log('  - ZOOM_CLIENT_SECRET 설정됨:', Boolean(ZOOM_CLIENT_SECRET));
        console.log('  - ZOOM_ACCOUNT_ID 설정됨:', Boolean(ZOOM_ACCOUNT_ID));
        
        if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET || !ZOOM_ACCOUNT_ID) {
            throw new Error('Zoom API 인증 정보가 제대로 설정되지 않았습니다.');
        }
        
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
        
        console.log('🔵 Zoom API 토큰 발급 성공!');
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Zoom 토큰 발급 오류:');
        if (error.response) {
            console.error('  - 상태 코드:', error.response.status);
            console.error('  - 응답 데이터:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('  - 오류 메시지:', error.message);
        }
        throw new Error('Zoom API 토큰 발급에 실패했습니다: ' + (error.response?.data?.message || error.message));
    }
}

/**
 * Zoom 미팅 생성 함수
 * @param {string} topic - 미팅 주제
 * @param {Date|null} startTime - 시작 시간 (null이면 즉시 미팅)
 * @param {number} duration - 미팅 기간(분)
 * @param {object|null} recurrence - 반복 설정
 * @param {object} options - 추가 설정
 *                 options.start_date: 원본 날짜 문자열 (YYYY-MM-DD)
 *                 options.start_time: 원본 시간 문자열 (HH:MM)
 * @returns {Promise<object>} - 생성된 미팅 정보
 */
async function createZoomMeeting(topic, startTime, duration, recurrence = null, options = {}) {
    console.log('\n🔷 [createZoomMeeting] 함수 호출됨');
    console.log('▶ 미팅 제목:', topic);
    console.log('▶ 시작 시간:', startTime ? startTime.toISOString() : 'null (즉시 미팅)');
    console.log('▶ 미팅 길이:', duration, '분');
    console.log('▶ 반복 설정:', JSON.stringify(recurrence, null, 2));
    console.log('▶ 추가 옵션:', JSON.stringify(options, null, 2));

    // 환경 변수 확인
    console.log('▶ Zoom API 환경 변수 확인:');
    console.log('  - ZOOM_API_KEY:', Boolean(ZOOM_API_KEY));
    console.log('  - ZOOM_API_SECRET:', Boolean(ZOOM_API_SECRET));
    console.log('  - ZOOM_CLIENT_ID:', Boolean(ZOOM_CLIENT_ID));
    console.log('  - ZOOM_CLIENT_SECRET:', Boolean(ZOOM_CLIENT_SECRET));
    console.log('  - ZOOM_ACCOUNT_ID:', Boolean(ZOOM_ACCOUNT_ID));
    
    // Zoom API 인증 방식 결정
    let useOAuth = true;
    let token = null;
    
    try {
        if (!ZOOM_API_KEY || !ZOOM_API_SECRET) {
            console.warn('⚠️ ZOOM_API_KEY 또는 ZOOM_API_SECRET이 없어 OAuth 인증을 사용합니다.');
            useOAuth = true;
        }
        
        if (useOAuth) {
            if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET || !ZOOM_ACCOUNT_ID) {
                throw new Error('OAuth에 필요한 ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_ACCOUNT_ID 중 하나 이상이 설정되지 않았습니다.');
            }
            
            console.log('▶ OAuth 토큰 발급 요청...');
            token = await getZoomToken();
            console.log('▶ OAuth 토큰 발급 성공!');
        } else {
            console.log('▶ JWT 토큰 생성...');
            token = generateZoomJWT();
            console.log('▶ JWT 토큰 생성 완료');
        }
        
        // 미팅 생성 설정
        const meetingConfig = {
            topic: topic || '미팅',
            type: recurrence ? 8 : 2, // 8: 반복 미팅, 2: 예약 미팅, 1: 즉시 미팅
            duration: duration || 60,
            timezone: 'Asia/Seoul'  // 항상 한국 시간대 사용
        };

        // 시작 시간이 있으면 설정
        if (startTime) {
            // 프론트엔드에서 받은 원본 날짜와 시간을 직접 사용하는 것이 가장 정확함
            if (options.start_date && options.start_time) {
                // Zoom API 형식: "YYYY-MM-DDThh:mm:ss"
                meetingConfig.start_time = `${options.start_date}T${options.start_time}:00`;
                console.log('▶ 원본 시간 문자열 사용 (프론트엔드에서 받은 값):', meetingConfig.start_time);
            } 
            // Date 객체에서 형식에 맞게 시간 추출
            else {
                // 유효한 Date 객체인지 확인
                if (!(startTime instanceof Date) || isNaN(startTime.getTime())) {
                    console.error('⚠️ 시작 시간이 유효한 Date 객체가 아닙니다:', startTime);
                    throw new Error('시작 시간이 유효하지 않습니다. 유효한 Date 객체를 전달하세요.');
                }
                
                // Date 객체에서 YYYY-MM-DDThh:mm:ss 형식으로 변환
                const year = startTime.getFullYear();
                const month = String(startTime.getMonth() + 1).padStart(2, '0');
                const day = String(startTime.getDate()).padStart(2, '0');
                const hours = String(startTime.getHours()).padStart(2, '0');
                const minutes = String(startTime.getMinutes()).padStart(2, '0');
                
                meetingConfig.start_time = `${year}-${month}-${day}T${hours}:${minutes}:00`;
                console.log('▶ Date 객체에서 변환된 시간 문자열:', meetingConfig.start_time);
            }
            
            console.log('▶ 설정된 시간대:', meetingConfig.timezone);
        }

        // 반복 설정이 있으면 추가
        if (recurrence) {
            console.log('▶ 반복 설정 적용:');
            // 반복 유형 유효성 검사 (1: 일간, 2: 주간, 3: 월간)
            if (!recurrence.type || ![1, 2, 3].includes(recurrence.type)) {
                console.warn('⚠️ 잘못된 반복 유형:', recurrence.type);
                console.warn('⚠️ 기본값인 주간(2)으로 설정합니다.');
                recurrence.type = 2;
            }
            
            // repeat_interval 유효성 검사
            if (!recurrence.repeat_interval || recurrence.repeat_interval < 1) {
                recurrence.repeat_interval = 1;
            }
            
            // 주간 반복일 경우 weekly_days 설정 확인
            if (recurrence.type === 2) {
                // 두 가지 형식 모두 처리: 배열 또는 쉼표로 구분된 문자열
                if (Array.isArray(recurrence.weekly_days)) {
                    // 배열을 쉼표로 구분된 문자열로 변환
                    recurrence.weekly_days = recurrence.weekly_days.join(',');
                    console.log('  - 요일 배열을 문자열로 변환:', recurrence.weekly_days);
                } else if (!recurrence.weekly_days) {
                    // 요일이 지정되지 않은 경우 기본값으로 화요일 설정
                    recurrence.weekly_days = "2";
                    console.warn('⚠️ 주간 반복에 요일이 지정되지 않아 화요일(2)로 설정합니다.');
                }
                
                console.log('  - 주간 반복 요일:', recurrence.weekly_days);
            }
            
            // end_times와 end_date_time 모두 없는 경우 기본값 설정
            if (!recurrence.end_times && !recurrence.end_date_time) {
                console.warn('⚠️ 반복 종료 설정이 없어 기본값(12회)으로 설정합니다.');
                recurrence.end_times = 12;
            }
            
            meetingConfig.recurrence = recurrence;
            console.log('  - 최종 반복 설정:', JSON.stringify(recurrence, null, 2));
        }

        // 추가 옵션이 있으면 병합
        if (options && typeof options === 'object') {
            console.log('▶ 추가 옵션 병합:');
            
            // 비밀번호 설정
            if (options.password || options.passcode) {
                meetingConfig.password = options.password || options.passcode;
                console.log('  - 비밀번호 설정됨');
            }

            // 설정 병합
            if (options.settings) {
                meetingConfig.settings = options.settings;
                console.log('  - 설정 병합됨');
            }
            
            // 다른 필드 병합 (설정된 필드만)
            const otherFields = ['agenda', 'tracking_fields', 'registration_url'];
            for (const field of otherFields) {
                if (options[field]) {
                    meetingConfig[field] = options[field];
                    console.log(`  - ${field} 설정됨`);
                }
            }
        }

        console.log('▶ Zoom API 요청 준비 완료');
        console.log('▶ 최종 요청 데이터:', JSON.stringify(meetingConfig, null, 2));

        // API 요청
        console.log('▶ Zoom API 요청 전송 중...');
        const authHeader = useOAuth ? `Bearer ${token}` : `Bearer ${token}`;
        
        const response = await axios({
            method: 'post',
            url: 'https://api.zoom.us/v2/users/me/meetings',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            data: meetingConfig,
            timeout: 30000 // 30초 타임아웃 설정
        });

        console.log('✅ Zoom API 응답 상태 코드:', response.status);
        const meetingData = response.data;
        console.log('✅ Zoom 미팅 생성 성공! ID:', meetingData.id);

        // 결과 반환
        const result = {
            success: true,
            meeting_id: meetingData.id,
            join_url: meetingData.join_url,
            start_url: meetingData.start_url,
            password: meetingData.password,
            start_time: meetingData.start_time,
            duration: meetingData.duration,
            recurrence: meetingData.recurrence
        };
        
        return result;
    } catch (error) {
        console.error('❌ Zoom 미팅 생성 오류:');
        console.error('  오류 메시지:', error.message);
        
        // 오류의 종류에 따른 상세 정보 출력
        let errorDetails = {
            message: error.message,
            type: 'unknown'
        };
        
        if (error.code) {
            console.error('  네트워크 오류 코드:', error.code);
            errorDetails.type = 'network';
            errorDetails.code = error.code;
        }
        
        if (error.response) {
            console.error('  API 응답 상태 코드:', error.response.status);
            console.error('  API 응답 데이터:', JSON.stringify(error.response.data, null, 2));
            
            errorDetails.type = 'api_error';
            errorDetails.status = error.response.status;
            errorDetails.data = error.response.data;
            
            // 흔한 오류 원인 판별
            let errorCause = '알 수 없는 오류';
            
            if (error.response.status === 401) {
                errorCause = '인증 오류 (JWT 토큰이 잘못되었거나 만료됨)';
                errorDetails.reason = 'authentication_failed';
            } else if (error.response.status === 404) {
                errorCause = '리소스를 찾을 수 없음';
                errorDetails.reason = 'resource_not_found';
            } else if (error.response.status === 429) {
                errorCause = 'API 속도 제한 초과';
                errorDetails.reason = 'rate_limit_exceeded';
            } else if (error.response.status === 400) {
                errorCause = '잘못된 요청';
                errorDetails.reason = 'bad_request';
                
                // 인증 오류 경우
                if (error.response.data.message?.includes('Invalid access token')) {
                    errorCause = '유효하지 않은 액세스 토큰';
                    errorDetails.reason = 'invalid_token';
                }
                // 시간 관련 오류 경우
                else if (error.response.data.message?.includes('time')) {
                    errorCause = '시간 형식 오류';
                    errorDetails.reason = 'invalid_time_format';
                }
                // 비밀번호 관련 오류 경우
                else if (error.response.data.message?.includes('password')) {
                    errorCause = '비밀번호 형식 오류';
                    errorDetails.reason = 'invalid_password';
                }
            } else if (error.response.status >= 500) {
                errorCause = 'Zoom 서버 오류';
                errorDetails.reason = 'server_error';
            }
            
            console.error('  오류 원인:', errorCause);
            errorDetails.cause = errorCause;
        } else if (error.request) {
            console.error('  요청은 보냈으나 응답을 받지 못함');
            errorDetails.type = 'no_response';
        }
        
        return {
            success: false,
            error: error.message,
            details: errorDetails
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

// 참가자 입장/퇴장 기록 분석 및 세션별 추적 함수 
async function getMeetingParticipantsWithSessions(meetingId, token) {
    // Zoom API에 여러 endpoint 시도
    const participantEndpoints = [
        // 1. 실시간 참가자 (Dashboard API)
        {
            url: `https://api.zoom.us/v2/metrics/meetings/${meetingId}/participants`,
            params: { page_size: 300, type: 'live' },
            name: 'Dashboard API'
        },
        // 2. 미팅 참가자 (Meeting API)
        {
            url: `https://api.zoom.us/v2/meetings/${meetingId}/participants`,
            params: { page_size: 300 },
            name: 'Meeting API'
        },
        // 3. 과거 미팅 참가자 (Past Meeting API)
        {
            url: `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
            params: { page_size: 300 },
            name: 'Past Meeting API'
        }
    ];
    
    let participantRecords = [];
    let participantsFetched = false;
    
    // API 엔드포인트 순차 시도
    for (const endpoint of participantEndpoints) {
        if (participantsFetched) break;
        
        try {
            console.log(`${endpoint.name}를 통해 참가자 조회 시도...`);
            const response = await axios.get(
                endpoint.url,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: endpoint.params
                }
            );
            
            if (response.data && response.data.participants && response.data.participants.length > 0) {
                participantRecords = response.data.participants;
                participantsFetched = true;
                console.log(`${endpoint.name}에서 참가자 기록 ${participantRecords.length}개 조회 성공`);
            }
        } catch (error) {
            console.log(`${endpoint.name} 참가자 조회 실패:`, error.message);
        }
    }
    
    // DB에서 추가 참가자 정보 조회
    const client = await masterPool.connect();
    try {
        const dbResult = await client.query(
            `SELECT * FROM ${SCHEMAS.COURSE}.zoom_meeting_participants
             WHERE meeting_id = $1
             ORDER BY join_time ASC`,
            [meetingId]
        );
        
        if (dbResult.rows.length > 0) {
            console.log(`DB에서 추가 참가자 기록 ${dbResult.rows.length}개 조회 성공`);
            
            // API에서 참가자 정보를 가져오지 못한 경우 DB 데이터 사용
            if (participantRecords.length === 0) {
                participantRecords = dbResult.rows.map(row => ({
                    user_id: row.participant_id,
                    user_name: row.participant_name,
                    join_time: row.join_time,
                    leave_time: row.leave_time,
                    duration: row.duration * 60 // 분 -> 초 변환
                }));
                participantsFetched = true;
            } else {
                // DB 데이터 추가 (중복 방지)
                dbResult.rows.forEach(row => {
                    // API 데이터에 없는 레코드만 추가
                    const existsInApi = participantRecords.some(p => 
                        p.user_id === row.participant_id && 
                        new Date(p.join_time).getTime() === new Date(row.join_time).getTime()
                    );
                    
                    if (!existsInApi) {
                        participantRecords.push({
                            user_id: row.participant_id,
                            user_name: row.participant_name,
                            join_time: row.join_time,
                            leave_time: row.leave_time,
                            duration: row.duration * 60 // 분 -> 초 변환
                        });
                    }
                });
            }
        }
    } catch (error) {
        console.error('DB 조회 오류:', error);
    } finally {
        client.release();
    }
    
    if (participantRecords.length === 0) {
        return {
            active_participants: [],
            past_participants: [],
            all_participants: [],
            error: '참가자 정보를 조회할 수 없습니다.'
        };
    }
    
    // 미팅 정보 조회 - 미팅 시작 시간과 총 기간 파악
    let meetingStartTime = null;
    let meetingEndTime = null;
    let meetingDuration = 0;
    
    try {
        const meetingInfoResponse = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        
        if (meetingInfoResponse.data && meetingInfoResponse.data.start_time) {
            meetingStartTime = new Date(meetingInfoResponse.data.start_time);
            meetingDuration = meetingInfoResponse.data.duration || 60; // 기본값 60분
            meetingEndTime = new Date(meetingStartTime);
            meetingEndTime.setMinutes(meetingEndTime.getMinutes() + meetingDuration);
        }
    } catch (error) {
        console.log('미팅 정보 조회 실패:', error.message);
    }
    
    // 현재 시간 기준
    const now = new Date();
    
    // 미팅 시작 시간이 없거나 미래인 경우 현재 시간 기준 설정
    if (!meetingStartTime || meetingStartTime > now) {
        // 참가자 기록에서 가장 빠른 입장 시간을 미팅 시작 시간으로 사용
        const joinTimes = participantRecords
            .filter(record => record.join_time)
            .map(record => new Date(record.join_time));
        
        if (joinTimes.length > 0) {
            meetingStartTime = new Date(Math.min(...joinTimes.map(time => time.getTime())));
        } else {
            meetingStartTime = new Date(now);
            meetingStartTime.setHours(meetingStartTime.getHours() - 1); // 기본값: 1시간 전
        }
    }
    
    // 미팅 총 시간 (초 단위)
    const totalMeetingSeconds = meetingEndTime && meetingEndTime < now
        ? Math.floor((meetingEndTime - meetingStartTime) / 1000)
        : Math.floor((now - meetingStartTime) / 1000);
    
    // 참가자 기록을 사용자별로 그룹화하고 세션별 참여 시간 분석
    const userSessionsMap = {};
    
    // 정렬: 모든 참가자 기록을 join_time 기준으로 정렬
    participantRecords.sort((a, b) => {
        const timeA = a.join_time ? new Date(a.join_time).getTime() : 0;
        const timeB = b.join_time ? new Date(b.join_time).getTime() : 0;
        return timeA - timeB;
    });
    
    // 참가자 기록을 사용자별로 그룹화
    participantRecords.forEach(record => {
        // 사용자 식별 - user_id, 이메일, 또는 이름 사용
        const userId = record.user_id || record.id || record.user_email || record.name;
        if (!userId) return; // 식별 불가능한 레코드 무시
        
        // 새 사용자면 맵에 추가
        if (!userSessionsMap[userId]) {
            userSessionsMap[userId] = {
                user_id: userId,
                name: record.user_name || record.name || '알 수 없음',
                email: record.user_email || '',
                sessions: [],
                total_duration_seconds: 0,
                is_currently_active: false,
                last_activity: null,
                session_count: 0
            };
        }
        
        // 세션 정보 정규화
        const joinTime = record.join_time ? new Date(record.join_time) : null;
        let leaveTime = record.leave_time ? new Date(record.leave_time) : null;
        
        // 현재 활성 사용자의 경우 퇴장 시간은 null
        if (joinTime && !leaveTime && joinTime <= now) {
            userSessionsMap[userId].is_currently_active = true;
        }
        
        // 세션 지속 시간 계산 (초 단위)
        const sessionDurationSeconds = 
            joinTime && leaveTime ? Math.floor((leaveTime - joinTime) / 1000) : 
            joinTime && userSessionsMap[userId].is_currently_active ? Math.floor((now - joinTime) / 1000) : 
            record.duration || 0;
        
        // 세션 시작 위치와 종료 위치를 상대적인 타임라인 위치로 계산 (0~100%)
        const sessionStartPosition = joinTime ? 
            Math.min(100, Math.max(0, (joinTime - meetingStartTime) / (totalMeetingSeconds * 1000) * 100)) : 0;
        
        const sessionEndPosition = leaveTime ? 
            Math.min(100, Math.max(0, (leaveTime - meetingStartTime) / (totalMeetingSeconds * 1000) * 100)) : 
            userSessionsMap[userId].is_currently_active ? 100 : sessionStartPosition;
        
        // 세션 정보 추가
        const session = {
            join_time: joinTime,
            leave_time: leaveTime,
            duration_seconds: sessionDurationSeconds,
            duration_minutes: Math.floor(sessionDurationSeconds / 60),
            duration_formatted: `${Math.floor(sessionDurationSeconds / 3600)}시간 ${Math.floor((sessionDurationSeconds % 3600) / 60)}분`,
            position_start: parseFloat(sessionStartPosition.toFixed(2)),
            position_end: parseFloat(sessionEndPosition.toFixed(2)),
            position_width: parseFloat((sessionEndPosition - sessionStartPosition).toFixed(2)),
            is_active: !leaveTime && joinTime <= now
        };
        
        // 시간 순서에 맞게 세션 추가
        userSessionsMap[userId].sessions.push(session);
        userSessionsMap[userId].total_duration_seconds += sessionDurationSeconds;
        
        // 현재 활성 상태 및 마지막 활동 시간 업데이트
        if (joinTime && (!userSessionsMap[userId].last_activity || joinTime > userSessionsMap[userId].last_activity)) {
            userSessionsMap[userId].last_activity = joinTime;
        }
        
        if (leaveTime && (!userSessionsMap[userId].last_activity || leaveTime > userSessionsMap[userId].last_activity)) {
            userSessionsMap[userId].last_activity = leaveTime;
        }
    });
    
    // 사용자별 데이터 후처리
    Object.values(userSessionsMap).forEach(user => {
        // 세션 수 계산
        user.session_count = user.sessions.length;
        
        // 총 참여 시간 및 포맷팅
        user.total_duration_minutes = Math.floor(user.total_duration_seconds / 60);
        user.duration_formatted = `${Math.floor(user.total_duration_minutes / 60)}시간 ${user.total_duration_minutes % 60}분`;
        
        // 참여율 계산 (총 미팅 시간 대비)
        user.attendance_rate = parseFloat((user.total_duration_seconds / totalMeetingSeconds * 100).toFixed(1));
        
        // 타임라인 데이터 구성을 위한 세션 간 갭 정보 계산
        user.timeline_data = [];
        
        if (user.sessions.length > 0) {
            // 세션을 시간순으로 정렬
            user.sessions.sort((a, b) => 
                (a.join_time ? a.join_time.getTime() : 0) - 
                (b.join_time ? b.join_time.getTime() : 0)
            );
            
            // 첫 세션 시작 전 갭
            if (user.sessions[0].position_start > 0) {
                user.timeline_data.push({
                    type: 'gap',
                    position_start: 0,
                    position_end: user.sessions[0].position_start,
                    position_width: user.sessions[0].position_start
                });
            }
            
            // 각 세션과 세션 사이의 갭 추가
            user.sessions.forEach((session, index) => {
                // 세션 추가
                user.timeline_data.push({
                    type: 'session',
                    session_index: index,
                    join_time: session.join_time,
                    leave_time: session.leave_time,
                    duration_seconds: session.duration_seconds,
                    duration_formatted: session.duration_formatted,
                    position_start: session.position_start,
                    position_end: session.position_end,
                    position_width: session.position_width,
                    is_active: session.is_active
                });
                
                // 다음 세션과의 갭 추가 (마지막 세션이 아닌 경우)
                if (index < user.sessions.length - 1) {
                    const nextSession = user.sessions[index + 1];
                    if (nextSession.position_start > session.position_end) {
                        user.timeline_data.push({
                            type: 'gap',
                            position_start: session.position_end,
                            position_end: nextSession.position_start,
                            position_width: nextSession.position_start - session.position_end
                        });
                    }
                }
            });
            
            // 마지막 세션 이후 갭 (현재 활성 상태가 아닌 경우)
            const lastSession = user.sessions[user.sessions.length - 1];
            if (!user.is_currently_active && lastSession.position_end < 100) {
                user.timeline_data.push({
                    type: 'gap',
                    position_start: lastSession.position_end,
                    position_end: 100,
                    position_width: 100 - lastSession.position_end
                });
            }
            
            // 첫 입장 및 마지막 퇴장 시간
            user.first_join_time = user.sessions[0].join_time;
            
            // 마지막 세션의 퇴장 시간 또는 현재 시간
            const lastSessionIndex = user.sessions.length - 1;
            user.last_leave_time = user.is_currently_active ? null : user.sessions[lastSessionIndex].leave_time;
        }
    });
    
    // 현재 활성 참가자와 과거 참가자 분류
    const activeParticipants = Object.values(userSessionsMap)
        .filter(user => user.is_currently_active)
        .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    
    const pastParticipants = Object.values(userSessionsMap)
        .filter(user => !user.is_currently_active)
        .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    
    return {
        active_participants: activeParticipants,
        past_participants: pastParticipants,
        all_participants: [...activeParticipants, ...pastParticipants],
        participant_count: activeParticipants.length + pastParticipants.length,
        active_count: activeParticipants.length,
        meeting_info: {
            start_time: meetingStartTime,
            duration_seconds: totalMeetingSeconds,
            duration_minutes: Math.floor(totalMeetingSeconds / 60),
            duration_formatted: `${Math.floor(totalMeetingSeconds / 3600)}시간 ${Math.floor((totalMeetingSeconds % 3600) / 60)}분`
        }
    };
}

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
        let courseStudentCounts = {};
        
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
                
                // 각 코스별 등록된 학생 수 조회
                const courseIds = dbResult.rows.map(row => row.course_id);
                if (courseIds.length > 0) {
                    const enrollmentResult = await client.query(`
                        SELECT course_id, COUNT(*) as student_count
                        FROM enrollment_schema.enrollments
                        WHERE course_id = ANY($1::text[]) AND status = 'ACTIVE'
                        GROUP BY course_id
                    `, [courseIds]);
                    
                    enrollmentResult.rows.forEach(row => {
                        courseStudentCounts[row.course_id] = parseInt(row.student_count);
                    });
                }
            }
        } catch (dbError) {
            console.error('DB 조회 오류:', dbError);
        } finally {
            client.release();
        }
        
        // 현재 진행 중인 미팅에 대한 참가자 정보 수집 - 세션별 추적
        const liveMeetingsWithDetails = [];
        
        if (liveMeetingsResponse.meetings && liveMeetingsResponse.meetings.length > 0) {
            for (const meeting of liveMeetingsResponse.meetings) {
                try {
                    // 새로운 함수 사용: 참가자 세션별 추적 및 정확한 참여 시간 계산
                    const participantDetails = await getMeetingParticipantsWithSessions(meeting.id, token);
                    
                    // 미리 조회한 맵에서 코스 정보 조회
                    const courseInfo = meetingToCourseMap[meeting.id.toString()] || null;
                    const courseId = courseInfo?.course_id;
                    const enrolledStudentsCount = courseId ? (courseStudentCounts[courseId] || 0) : 0;
                    
                    // 미팅 시작 시간과 총 진행 시간 정보
                    const meetingInfo = participantDetails.meeting_info || {
                        start_time: new Date(meeting.start_time || new Date()),
                        duration_minutes: meeting.duration || 0,
                        duration_formatted: `${Math.floor(meeting.duration / 60)}시간 ${meeting.duration % 60}분`,
                        duration_seconds: (meeting.duration || 0) * 60
                    };
                    
                    // 미팅 시작 시간 유효성 검사
                    const currentTime = new Date();
                    const providedStartTime = meeting.start_time ? new Date(meeting.start_time) : null;
                    let validStartTime;
                    
                    if (!providedStartTime || 
                        providedStartTime > currentTime || 
                        providedStartTime.getFullYear() > currentTime.getFullYear() + 10) {
                        // 시작 시간이 없거나 미래이거나 10년 이상 미래인 경우 현재 시간 기준으로 설정
                        validStartTime = currentTime.toISOString();
                        console.log(`미팅 ${meeting.id}의 시작 시간이 미래(${providedStartTime})이므로 현재 시간 기준으로 조정합니다.`);
                    } else {
                        validStartTime = meeting.start_time;
                    }
                    
                    // 참가자 정보 강화
                    const enhancedActiveParticipants = participantDetails.active_participants.map(p => ({
                        name: p.name,
                        email: p.email,
                        duration_minutes: p.total_duration_minutes,
                        duration_formatted: p.duration_formatted,
                        first_join_time: p.first_join_time,
                        is_active: true,
                        session_count: p.session_count,
                        attendance_rate: p.attendance_rate,
                        timeline_data: p.timeline_data,
                        sessions: p.sessions.map(s => ({
                            join_time: s.join_time,
                            leave_time: s.leave_time,
                            duration_formatted: s.duration_formatted,
                            position_start: s.position_start,
                            position_end: s.position_end,
                            position_width: s.position_width,
                            is_active: s.is_active
                        }))
                    }));
                    
                    const enhancedPastParticipants = participantDetails.past_participants
                        .slice(0, 5) // 최근 5명만
                        .map(p => ({
                            name: p.name,
                            email: p.email,
                            duration_minutes: p.total_duration_minutes,
                            duration_formatted: p.duration_formatted,
                            first_join_time: p.first_join_time,
                            last_leave_time: p.last_leave_time,
                            is_active: false,
                            session_count: p.session_count,
                            attendance_rate: p.attendance_rate,
                            timeline_data: p.timeline_data,
                            sessions: p.sessions.map(s => ({
                                join_time: s.join_time,
                                leave_time: s.leave_time,
                                duration_formatted: s.duration_formatted,
                                position_start: s.position_start,
                                position_end: s.position_end,
                                position_width: s.position_width,
                                is_active: false
                            }))
                        }));
                    
                    // 전체 참가자 데이터 - 중복 없이 모든 참가자를 포함
                    const allParticipants = [...enhancedActiveParticipants];
                    enhancedPastParticipants.forEach(pastParticipant => {
                        if (!allParticipants.some(p => p.name === pastParticipant.name)) {
                            allParticipants.push(pastParticipant);
                        }
                    });
                    
                    // 출석률 계산
                    const attendanceRate = enrolledStudentsCount > 0 
                        ? (participantDetails.active_count / enrolledStudentsCount * 100).toFixed(1)
                        : '0.0';
                    
                    // 미팅 상세 정보
                    liveMeetingsWithDetails.push({
                        id: meeting.id,
                        topic: meeting.topic,
                        host_id: meeting.host_id,
                        start_time: validStartTime,
                        duration: meeting.duration,
                        course_id: courseId,
                        course_title: courseInfo?.course_title || null,
                        enrolled_students_count: enrolledStudentsCount,
                        current_attendance_rate: attendanceRate,
                        active_participants_count: participantDetails.active_count,
                        total_participants_count: participantDetails.participant_count,
                        meeting_duration_minutes: meetingInfo.duration_minutes,
                        meeting_duration_formatted: meetingInfo.duration_formatted,
                        meeting_info: {
                            start_time: meetingInfo.start_time,
                            duration_formatted: meetingInfo.duration_formatted,
                            duration_seconds: meetingInfo.duration_seconds,
                            duration_minutes: meetingInfo.duration_minutes
                        },
                        active_participants: enhancedActiveParticipants,
                        recent_past_participants: enhancedPastParticipants,
                        all_participants: allParticipants
                    });
                } catch (error) {
                    console.error(`미팅 ${meeting.id} 참가자 조회 실패:`, error.message);
                    // 기본 정보만 포함
                    
                    // 미팅 시작 시간 유효성 검사
                    const currentTime = new Date();
                    const providedStartTime = meeting.start_time ? new Date(meeting.start_time) : null;
                    let validStartTime;
                    
                    if (!providedStartTime || 
                        providedStartTime > currentTime || 
                        providedStartTime.getFullYear() > currentTime.getFullYear() + 10) {
                        // 시작 시간이 없거나 미래이거나 10년 이상 미래인 경우 현재 시간 기준으로 설정
                        validStartTime = currentTime.toISOString();
                        console.log(`미팅 ${meeting.id}의 시작 시간이 미래(${providedStartTime})이므로 현재 시간 기준으로 조정합니다.`);
                    } else {
                        validStartTime = meeting.start_time;
                    }
                    
                    liveMeetingsWithDetails.push({
                        id: meeting.id,
                        topic: meeting.topic,
                        start_time: validStartTime,
                        duration: meeting.duration,
                        active_participants_count: 0,
                        active_participants: []
                    });
                }
            }
        }
        
        // 최근 종료된 미팅 - 간소화
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
                duration: meeting.duration,
                course_title: meetingToCourseMap[meeting.id]?.course_title || null
            }));
        
        // 응답 데이터 구성
        const responseData = {
            live_meetings: {
                count: liveMeetingsWithDetails.length,
                meetings: liveMeetingsWithDetails
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

// 특정 미팅의 참가자 세션 상세 조회 API
router.get('/meeting/:meetingId/participant-sessions', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 참가자 세션 정보 상세 조회
        const participantSessionsData = await getMeetingParticipantsWithSessions(meetingId, token);
        
        // 미팅 정보 조회
        const meetingInfo = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        
        // 미팅 시작 시간과 현재 시간으로 미팅 진행 시간 계산 (분 단위)
        let meetingDuration = 0;
        if (meetingInfo.data.start_time) {
            const meetingStartTime = new Date(meetingInfo.data.start_time);
            meetingDuration = Math.floor((new Date() - meetingStartTime) / (1000 * 60));
        } else {
            meetingDuration = meetingInfo.data.duration || 0;
        }
        
        // 코스 정보 조회
        const client = await masterPool.connect();
        let courseInfo = null;
        let enrolledStudentsCount = 0;
        
        try {
            const courseResult = await client.query(`
                SELECT c.id, c.title 
                FROM ${SCHEMAS.COURSE}.zoom_meetings zm
                JOIN ${SCHEMAS.COURSE}.courses c ON zm.course_id = c.id
                WHERE zm.zoom_meeting_id = $1
            `, [meetingId]);
            
            if (courseResult.rows.length > 0) {
                courseInfo = courseResult.rows[0];
                
                // 등록 학생 수 조회
                const enrollmentResult = await client.query(`
                    SELECT COUNT(*) as student_count
                    FROM enrollment_schema.enrollments
                    WHERE course_id = $1 AND status = 'ACTIVE'
                `, [courseInfo.id]);
                
                if (enrollmentResult.rows.length > 0) {
                    enrolledStudentsCount = parseInt(enrollmentResult.rows[0].student_count);
                }
            }
        } finally {
            client.release();
        }
        
        // 출석률 계산
        const attendanceRate = enrolledStudentsCount > 0 
            ? (participantSessionsData.active_count / enrolledStudentsCount * 100).toFixed(1)
            : '0.0';
        
        // 응답 데이터 구성
        const responseData = {
            meeting: {
                id: meetingId,
                topic: meetingInfo.data.topic,
                start_time: meetingInfo.data.start_time,
                duration: meetingInfo.data.duration,
                duration_minutes: meetingDuration,
                duration_formatted: `${Math.floor(meetingDuration / 60)}시간 ${meetingDuration % 60}분`
            },
            course: courseInfo ? {
                id: courseInfo.id,
                title: courseInfo.title,
                enrolled_students_count: enrolledStudentsCount,
                current_attendance_rate: attendanceRate
            } : null,
            participants: {
                active: participantSessionsData.active_participants,
                past: participantSessionsData.past_participants,
                active_count: participantSessionsData.active_count,
                total_count: participantSessionsData.participant_count
            }
        };
        
        res.json({
            success: true,
            message: "미팅 참가자 세션 정보가 조회되었습니다.",
            data: responseData
        });
    } catch (error) {
        console.error('미팅 참가자 세션 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "미팅 참가자 세션 정보를 조회하는 중 오류가 발생했습니다.",
            error: error.response?.data?.message || error.message
        });
    }
});

/**
 * 종료된 Zoom 미팅 정보 및 참석자 목록 조회
 * @param {string} meetingId - Zoom 미팅 ID
 * @returns {Promise<Object>} 미팅 정보 및 참석자 목록
 */
async function getPastMeetingInfo(meetingId) {
    console.log(`🔍 종료된 미팅 정보 조회: ${meetingId}`);
    
    try {
        // 액세스 토큰 가져오기
        const token = await getZoomToken();
        
        // 미팅 종료 여부 확인
        const meetingInfoUrl = `https://api.zoom.us/v2/past_meetings/${meetingId}`;
        
        console.log(`미팅 정보 요청: ${meetingInfoUrl}`);
        const meetingResponse = await axios.get(meetingInfoUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const meetingInfo = meetingResponse.data;
        console.log('미팅 기본 정보:', JSON.stringify(meetingInfo, null, 2));
        
        // 참석자 목록 가져오기
        const participantsUrl = `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`;
        
        console.log(`참석자 목록 요청: ${participantsUrl}`);
        const participantsResponse = await axios.get(participantsUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                page_size: 300 // 최대 참석자 수
            }
        });
        
        const participants = participantsResponse.data.participants || [];
        console.log(`참석자 ${participants.length}명 조회됨`);
        
        // 참석자 세션 정보 정리
        const attendeeMap = {};
        
        participants.forEach(participant => {
            const userId = participant.id || participant.user_email || participant.name;
            
            if (!attendeeMap[userId]) {
                attendeeMap[userId] = {
                    id: userId,
                    name: participant.name,
                    email: participant.user_email || '',
                    sessions: []
                };
            }
            
            // 참석자의 세션 정보 추가
            attendeeMap[userId].sessions.push({
                join_time: participant.join_time,
                leave_time: participant.leave_time,
                duration: participant.duration || 0, // 분 단위
                attentiveness_score: participant.attentiveness_score
            });
        });
        
        // 참석자별 총 참여 시간 및 세션 수 계산
        Object.keys(attendeeMap).forEach(userId => {
            const attendee = attendeeMap[userId];
            attendee.total_duration = attendee.sessions.reduce((total, session) => total + (session.duration || 0), 0);
            attendee.session_count = attendee.sessions.length;
        });
        
        // 참석자 정보를 배열로 변환
        const attendeeList = Object.values(attendeeMap);
        
        // 참여 시간이 긴 순서대로 정렬
        attendeeList.sort((a, b) => b.total_duration - a.total_duration);
        
        return {
            meeting: meetingInfo,
            attendees: attendeeList,
            total_participants: attendeeList.length,
            duration: meetingInfo.duration || 0
        };
    } catch (error) {
        console.error('종료된 미팅 정보 조회 중 오류:', error.message);
        
        if (error.response) {
            console.error('Zoom API 응답:', error.response.status, error.response.data);
            
            if (error.response.status === 404) {
                throw new Error('미팅을 찾을 수 없습니다. 미팅이 종료되었는지 확인하세요.');
            } else if (error.response.status === 401) {
                throw new Error('Zoom API 인증에 실패했습니다.');
            }
        }
        
        throw new Error('종료된 미팅 정보 조회 중 오류가 발생했습니다: ' + error.message);
    }
}

// 종료된 미팅의 참석자 보고서 API
router.get('/past-meeting/:meetingId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        if (!meetingId) {
            return res.status(400).json({
                success: false,
                message: '미팅 ID가 필요합니다.'
            });
        }
        
        // 종료된 미팅 정보 및 참석자 목록 조회
        const meetingData = await getPastMeetingInfo(meetingId);
        
        // 추가 통계 계산
        const stats = {
            avg_duration: 0,
            attendance_rate: 0,
            max_duration: 0,
            min_duration: 0
        };
        
        if (meetingData.attendees.length > 0) {
            // 평균 참여 시간 (분)
            stats.avg_duration = Math.round(
                meetingData.attendees.reduce((sum, att) => sum + att.total_duration, 0) / 
                meetingData.attendees.length
            );
            
            // 최대 및 최소 참여 시간
            stats.max_duration = Math.max(...meetingData.attendees.map(att => att.total_duration));
            stats.min_duration = Math.min(...meetingData.attendees.map(att => att.total_duration));
            
            // 참석률 (미팅 시간의 50% 이상 참석한 사용자 비율)
            const meetingDuration = meetingData.duration;
            if (meetingDuration > 0) {
                const attendedHalfTime = meetingData.attendees.filter(
                    att => att.total_duration >= (meetingDuration / 2)
                ).length;
                
                stats.attendance_rate = Math.round((attendedHalfTime / meetingData.attendees.length) * 100);
            }
        }
        
        res.json({
            success: true,
            data: {
                meeting: meetingData.meeting,
                attendees: meetingData.attendees,
                total_participants: meetingData.total_participants,
                stats: stats,
                meeting_duration: meetingData.duration
            }
        });
    } catch (error) {
        console.error('종료된 미팅 보고서 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: error.message || '종료된 미팅 보고서 조회 중 오류가 발생했습니다.'
        });
    }
});

// 종료된 강좌 미팅 목록 조회
router.get('/course/:courseId/past-meetings', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { courseId } = req.params;
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: '강좌 ID가 필요합니다.'
            });
        }
        
        // 토큰 발급
        const token = await getZoomToken();
        
        // 1. 강좌의 Zoom 미팅 정보 조회
        const client = await masterPool.connect();
        const courseQuery = `
            SELECT id, title, zoom_link
            FROM ${SCHEMAS.COURSE}.courses
            WHERE id = $1
        `;
        
        const courseResult = await client.query(courseQuery, [courseId]);
        client.release();
        
        if (courseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '강좌를 찾을 수 없습니다.'
            });
        }
        
        const course = courseResult.rows[0];
        
        // Zoom 링크에서 미팅 ID 추출
        const zoomLink = course.zoom_link;
        let meetingId = null;
        
        if (zoomLink) {
            const match = zoomLink.match(/\/j\/(\d+)/);
            if (match && match[1]) {
                meetingId = match[1];
            }
        }
        
        if (!meetingId) {
            return res.status(400).json({
                success: false,
                message: '유효한 Zoom 미팅 링크가 없습니다.'
            });
        }
        
        // 2. 사용자의 과거 미팅 목록 조회 (최근 30일)
        try {
            const pastMeetingsUrl = `https://api.zoom.us/v2/past_meetings/${meetingId}/instances`;
            
            console.log(`과거 미팅 목록 요청: ${pastMeetingsUrl}`);
            const pastMeetingsResponse = await axios.get(pastMeetingsUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const pastMeetings = pastMeetingsResponse.data.meetings || [];
            console.log(`${pastMeetings.length}개의 과거 미팅 조회됨`);
            
            // 날짜 기준 내림차순 정렬 (최신순)
            pastMeetings.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
            
            res.json({
                success: true,
                data: {
                    course: {
                        id: course.id,
                        title: course.title
                    },
                    meetings: pastMeetings,
                    total: pastMeetings.length
                }
            });
        } catch (error) {
            console.error('과거 미팅 목록 조회 중 오류:', error.message);
            
            if (error.response?.status === 404) {
                return res.json({
                    success: true,
                    data: {
                        course: {
                            id: course.id,
                            title: course.title
                        },
                        meetings: [],
                        total: 0,
                        message: '과거 미팅 기록이 없습니다.'
                    }
                });
            }
            
            throw error;
        }
    } catch (error) {
        console.error('강좌 과거 미팅 목록 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: error.message || '강좌 과거 미팅 목록 조회 중 오류가 발생했습니다.'
        });
    }
});

/**
 * 특정 Zoom 미팅 ID에 대한 모든 과거 세션 목록과 상세 정보 조회
 * @param {string} meetingId - Zoom 미팅 ID
 * @returns {Promise<Object[]>} 모든 세션 정보 목록
 */
async function getMeetingSessionHistory(meetingId) {
    try {
        // 토큰 발급
        const token = await getZoomToken();
        
        // 1. 해당 미팅 ID의 모든 인스턴스(세션) 목록 조회
        const instancesUrl = `https://api.zoom.us/v2/past_meetings/${meetingId}/instances`;
        console.log(`미팅 인스턴스 조회 요청: ${instancesUrl}`);
        
        const instancesResponse = await axios.get(instancesUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const instances = instancesResponse.data.meetings || [];
        console.log(`${instances.length}개의 미팅 세션 조회됨`);
        
        if (instances.length === 0) {
            return {
                meeting_id: meetingId,
                sessions: [],
                message: "과거 세션 기록이 없습니다."
            };
        }
        
        // 시작 시간 기준 내림차순 정렬
        instances.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
        
        // 2. 각 세션별로 상세 정보와 참석자 정보 조회
        const sessionsWithDetails = [];
        
        // 최대 10개의 세션만 상세 정보 조회 (성능 고려)
        const sessionsToProcess = instances.slice(0, 10);
        
        for (const session of sessionsToProcess) {
            try {
                // 세션 UUID를 사용하여 상세 정보 조회
                const sessionUuid = session.uuid;
                
                // 세션 참석자 정보 조회
                const participantsUrl = `https://api.zoom.us/v2/past_meetings/${sessionUuid}/participants`;
                
                const participantsResponse = await axios.get(participantsUrl, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 300
                    }
                });
                
                const participants = participantsResponse.data.participants || [];
                
                // 참석자별 세션 정보 정리
                const attendeeMap = {};
                
                participants.forEach(participant => {
                    const userId = participant.id || participant.user_email || participant.name;
                    
                    if (!attendeeMap[userId]) {
                        attendeeMap[userId] = {
                            id: userId,
                            name: participant.name,
                            email: participant.user_email || '',
                            sessions: []
                        };
                    }
                    
                    // 참석자의 세션 정보 추가
                    attendeeMap[userId].sessions.push({
                        join_time: participant.join_time,
                        leave_time: participant.leave_time,
                        duration: participant.duration || 0
                    });
                });
                
                // 참석자 정보를 배열로 변환하고 참석 시간 순으로 정렬
                const attendeeList = Object.values(attendeeMap);
                
                // 참석자별 총 참여 시간 계산
                attendeeList.forEach(attendee => {
                    attendee.total_duration = attendee.sessions.reduce(
                        (total, s) => total + (s.duration || 0), 0
                    );
                });
                
                // 참여 시간 내림차순 정렬
                attendeeList.sort((a, b) => b.total_duration - a.total_duration);
                
                // 세션 정보를 결과에 추가
                sessionsWithDetails.push({
                    session_id: sessionUuid,
                    meeting_id: meetingId,
                    topic: session.topic || "제목 없음",
                    start_time: session.start_time,
                    end_time: session.end_time || null,
                    duration: session.duration || 0,
                    participants: {
                        total: attendeeList.length,
                        list: attendeeList
                    }
                });
            } catch (error) {
                console.error(`세션 ${session.uuid} 상세 정보 조회 중 오류:`, error.message);
                
                // 오류 발생해도 다음 세션 계속 처리
                sessionsWithDetails.push({
                    session_id: session.uuid,
                    meeting_id: meetingId,
                    topic: session.topic || "제목 없음",
                    start_time: session.start_time,
                    error: "상세 정보 조회 중 오류 발생"
                });
            }
        }
        
        // 나머지 세션은 기본 정보만 추가
        if (instances.length > 10) {
            const remainingSessions = instances.slice(10).map(session => ({
                session_id: session.uuid,
                meeting_id: meetingId,
                topic: session.topic || "제목 없음",
                start_time: session.start_time,
                basic_info_only: true
            }));
            
            sessionsWithDetails.push(...remainingSessions);
        }
        
        return {
            meeting_id: meetingId,
            total_sessions: instances.length,
            sessions: sessionsWithDetails
        };
    } catch (error) {
        console.error('미팅 세션 기록 조회 중 오류:', error.message);
        
        if (error.response) {
            console.error('Zoom API 응답:', error.response.status, error.response.data);
            
            if (error.response.status === 404) {
                return {
                    meeting_id: meetingId,
                    sessions: [],
                    error: "미팅을 찾을 수 없습니다."
                };
            }
        }
        
        throw new Error('미팅 세션 기록 조회 중 오류가 발생했습니다: ' + error.message);
    }
}

// 줌 미팅 ID로 모든 세션의 회의 기록 조회 API
router.get('/meeting/:meetingId/history', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        if (!meetingId) {
            return res.status(400).json({
                success: false,
                message: '미팅 ID가 필요합니다.'
            });
        }
        
        // 미팅 세션 기록 조회
        const sessionHistory = await getMeetingSessionHistory(meetingId);
        
        res.json({
            success: true,
            data: sessionHistory
        });
    } catch (error) {
        console.error('미팅 기록 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: error.message || '미팅 기록 조회 중 오류가 발생했습니다.'
        });
    }
});

// 강좌 Zoom 세션 출석 보고서 API
router.get('/course/:courseId/attendance', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { courseId } = req.params;
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: '강좌 ID가 필요합니다.'
            });
        }
        
        // 1. 강좌 정보 조회
        const client = await masterPool.connect();
        const courseQuery = `
            SELECT c.id, c.title, c.zoom_link
            FROM ${SCHEMAS.COURSE}.courses c
            WHERE c.id = $1
        `;
        
        const courseResult = await client.query(courseQuery, [courseId]);
        
        // 2. 강좌에 등록된 학생 목록 조회
        const studentsQuery = `
            SELECT 
                u.cognito_user_id as student_id,
                u.given_name as student_name,
                u.email as student_email,
                e.enrolled_at
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            JOIN ${SCHEMAS.AUTH}.users u ON e.student_id = u.cognito_user_id
            WHERE e.course_id = $1 AND e.status = 'ACTIVE'
            ORDER BY u.given_name
        `;
        
        const studentsResult = await client.query(studentsQuery, [courseId]);
        client.release();
        
        if (courseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '강좌를 찾을 수 없습니다.'
            });
        }
        
        const course = courseResult.rows[0];
        const students = studentsResult.rows;
        
        if (!course.zoom_link) {
            return res.status(400).json({
                success: false,
                message: '이 강좌에 Zoom 링크가 설정되지 않았습니다.'
            });
        }
        
        // Zoom 링크에서 미팅 ID 추출
        const zoomLink = course.zoom_link;
        let meetingId = null;
        
        if (zoomLink) {
            const match = zoomLink.match(/\/j\/(\d+)/);
            if (match && match[1]) {
                meetingId = match[1];
            }
        }
        
        if (!meetingId) {
            return res.status(400).json({
                success: false,
                message: '유효한 Zoom 미팅 링크가 없습니다.'
            });
        }
        
        // 3. 미팅 세션 기록 조회
        const sessionHistory = await getMeetingSessionHistory(meetingId);
        
        // 4. 학생별 출석 현황 생성
        const attendanceReport = {
            course: {
                id: course.id,
                title: course.title,
                meeting_id: meetingId
            },
            sessions: sessionHistory.sessions.map(session => ({
                session_id: session.session_id,
                start_time: session.start_time,
                topic: session.topic,
                duration: session.duration
            })),
            students: students.map(student => {
                // 학생의 세션별 출석 현황 계산
                const sessionAttendance = sessionHistory.sessions.map(session => {
                    // 참석자 목록에서 이 학생 찾기
                    const found = session.participants?.list?.find(p => 
                        p.email === student.student_email || 
                        p.name === student.student_name
                    );
                    
                    if (!found) {
                        return {
                            session_id: session.session_id,
                            attended: false,
                            duration: 0,
                            attendance_rate: 0
                        };
                    }
                    
                    // 출석률 계산 (세션 길이 대비 참석 시간)
                    const sessionDuration = session.duration || 60; // 기본값 60분
                    const attendanceRate = Math.min(100, Math.round((found.total_duration / sessionDuration) * 100));
                    
                    return {
                        session_id: session.session_id,
                        attended: true,
                        duration: found.total_duration,
                        attendance_rate: attendanceRate
                    };
                });
                
                // 전체 출석률 계산
                const totalSessions = sessionAttendance.length;
                const attendedSessions = sessionAttendance.filter(sa => sa.attended).length;
                const overallAttendanceRate = totalSessions > 0 
                    ? Math.round((attendedSessions / totalSessions) * 100)
                    : 0;
                
                return {
                    student_id: student.student_id,
                    name: student.student_name,
                    email: student.student_email,
                    overall_attendance_rate: overallAttendanceRate,
                    sessions: sessionAttendance
                };
            })
        };
        
        res.json({
            success: true,
            data: attendanceReport
        });
    } catch (error) {
        console.error('강좌 출석 보고서 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: error.message || '강좌 출석 보고서 조회 중 오류가 발생했습니다.'
        });
    }
});

// 함수 내보내기
module.exports = router;

// createZoomMeeting 함수도 외부에서 사용할 수 있도록 설정
module.exports.createZoomMeeting = createZoomMeeting; 