const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { v4: uuidv4 } = require('uuid');

// Zoom API 설정
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
        // 1. 등록된 참가자 (Registrants API)
        {
            url: `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
            params: { page_size: 100, status: 'approved' },
            name: 'Registrants API'
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
    
    return {
        meeting: meetingInfo,
        status: meetingStatus,
        participants: participantsData,
        data_source: successfulEndpoint,
        timestamp: new Date().toISOString()
    };
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
                console.log('미팅 시작 이벤트:', event.payload.object.id);
                break;
            case 'meeting.ended':
                console.log('미팅 종료 이벤트:', event.payload.object.id);
                break;
            case 'meeting.participant_joined':
                console.log('참가자 입장 이벤트:', event.payload.object.participant.user_name);
                break;
            case 'meeting.participant_left':
                console.log('참가자 퇴장 이벤트:', event.payload.object.participant.user_name);
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

// 테스트용 강의 생성 API
router.post('/create-lecture', async (req, res) => {
    try {
        const { 
            topic = '테스트 강의',
            duration = 180
        } = req.body;

        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // 시작 날짜 설정 (다음 화요일 19시)
        const startTime = new Date();
        startTime.setHours(19, 0, 0, 0); // 19시로 설정
        
        // 다음 화요일로 설정
        const currentDay = startTime.getDay();
        const daysUntilTuesday = (2 + 7 - currentDay) % 7;
        startTime.setDate(startTime.getDate() + daysUntilTuesday);
        
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

        res.json({
            success: true,
            message: "테스트 강의가 생성되었습니다.",
            data: zoomResponse.data
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

// 미팅 상세 정보 조회 API
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

// 실시간 참가자 모니터링 API (Pro 계정용)
router.get('/live-participants/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
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
        
        // 등록된 참가자 조회
        const registrantsResponse = await axios.get(
            `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    status: 'approved',
                    page_size: 100
                }
            }
        );
        
        const registrants = registrantsResponse.data.registrants || [];
        
        // 응답 데이터 구성
        const responseData = {
            meeting: meetingInfo,
            registrants: registrants,
            timestamp: new Date().toISOString()
        };
        
        res.json({
            success: true,
            message: "현재 미팅 참가자 정보가 조회되었습니다.",
            data: responseData
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

module.exports = router; 