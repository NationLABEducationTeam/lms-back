const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { masterPool, SCHEMAS } = require('../../config/database');

// Zoom API 설정
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

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

// 테스트용 강의 생성 API
router.post('/create-lecture', async (req, res) => {
    try {
        const { 
            topic = '테스트 강의',
            duration = 15,
            courseId = null
        } = req.body;

        // Zoom API 토큰 발급
        const token = await getZoomToken();

        // 현재 시간 기준으로 미팅 시작 시간 설정
        const startTime = new Date();
        startTime.setMinutes(startTime.getMinutes() + 5); // 5분 후 시작

        // Zoom 미팅 생성 요청
        const zoomResponse = await axios.post(
            'https://api.zoom.us/v2/users/me/meetings',
            {
                topic,
                type: 2, // 예약된 미팅
                start_time: startTime.toISOString(),
                duration,
                timezone: 'Asia/Seoul',
                settings: {
                    host_video: true,
                    participant_video: true,
                    join_before_host: true,
                    mute_upon_entry: true,
                    waiting_room: false
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

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
        
        // 여러 API 엔드포인트를 시도하여 참가자 정보 수집
        let participantsData = null;
        let errorMessages = [];
        
        // 1. 첫 번째 시도: 실시간 미팅 참가자 조회 (Dashboard API)
        try {
            console.log('시도 1: Dashboard API를 통한 실시간 참가자 조회');
            const dashboardResponse = await axios.get(
                `https://api.zoom.us/v2/metrics/meetings/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100,
                        type: 'live'
                    }
                }
            );
            
            participantsData = dashboardResponse.data;
            console.log('Dashboard API 성공:', JSON.stringify(participantsData, null, 2));
            
            // 참가자가 있으면 바로 반환
            if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                return res.json({
                    success: true,
                    message: "Dashboard API를 통해 실시간 참가자 정보가 조회되었습니다.",
                    data: participantsData,
                    source: "dashboard_api",
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error1) {
            console.error('Dashboard API 실패:', error1.response?.data || error1.message);
            errorMessages.push({
                api: "dashboard_api",
                error: error1.response?.data?.message || error1.message
            });
        }
        
        // 2. 두 번째 시도: 미팅 참가자 조회 (일반 API)
        try {
            console.log('시도 2: 일반 API를 통한 미팅 참가자 조회');
            const meetingResponse = await axios.get(
                `https://api.zoom.us/v2/meetings/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100
                    }
                }
            );
            
            participantsData = meetingResponse.data;
            console.log('일반 API 성공:', JSON.stringify(participantsData, null, 2));
            
            // 참가자가 있으면 바로 반환
            if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                return res.json({
                    success: true,
                    message: "일반 API를 통해 미팅 참가자 정보가 조회되었습니다.",
                    data: participantsData,
                    source: "meeting_api",
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error2) {
            console.error('일반 API 실패:', error2.response?.data || error2.message);
            errorMessages.push({
                api: "meeting_api",
                error: error2.response?.data?.message || error2.message
            });
        }
        
        // 3. 세 번째 시도: 웨비나 참가자 조회 (웨비나 API)
        try {
            console.log('시도 3: 웨비나 API를 통한 참가자 조회');
            const webinarResponse = await axios.get(
                `https://api.zoom.us/v2/webinars/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100
                    }
                }
            );
            
            participantsData = webinarResponse.data;
            console.log('웨비나 API 성공:', JSON.stringify(participantsData, null, 2));
            
            // 참가자가 있으면 바로 반환
            if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                return res.json({
                    success: true,
                    message: "웨비나 API를 통해 참가자 정보가 조회되었습니다.",
                    data: participantsData,
                    source: "webinar_api",
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error3) {
            console.error('웨비나 API 실패:', error3.response?.data || error3.message);
            errorMessages.push({
                api: "webinar_api",
                error: error3.response?.data?.message || error3.message
            });
        }
        
        // 4. 네 번째 시도: 과거 미팅 참가자 조회 (Report API)
        try {
            console.log('시도 4: Report API를 통한 과거 미팅 참가자 조회');
            const reportResponse = await axios.get(
                `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100
                    }
                }
            );
            
            participantsData = reportResponse.data;
            console.log('Report API 성공:', JSON.stringify(participantsData, null, 2));
            
            // 참가자가 있으면 바로 반환
            if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                return res.json({
                    success: true,
                    message: "Report API를 통해 과거 미팅 참가자 정보가 조회되었습니다.",
                    data: participantsData,
                    source: "report_api",
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error4) {
            console.error('Report API 실패:', error4.response?.data || error4.message);
            errorMessages.push({
                api: "report_api",
                error: error4.response?.data?.message || error4.message
            });
        }
        
        // 5. 다섯 번째 시도: 과거 미팅 참가자 조회 (Past Meeting API)
        try {
            console.log('시도 5: Past Meeting API를 통한 과거 미팅 참가자 조회');
            const pastMeetingResponse = await axios.get(
                `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100
                    }
                }
            );
            
            participantsData = pastMeetingResponse.data;
            console.log('Past Meeting API 성공:', JSON.stringify(participantsData, null, 2));
            
            // 참가자가 있으면 바로 반환
            if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                return res.json({
                    success: true,
                    message: "Past Meeting API를 통해 과거 미팅 참가자 정보가 조회되었습니다.",
                    data: participantsData,
                    source: "past_meeting_api",
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error5) {
            console.error('Past Meeting API 실패:', error5.response?.data || error5.message);
            errorMessages.push({
                api: "past_meeting_api",
                error: error5.response?.data?.message || error5.message
            });
        }
        
        // 6. 여섯 번째 시도: 미팅 인스턴스 조회 후 참가자 정보 조회
        try {
            console.log('시도 6: 미팅 인스턴스 조회 후 참가자 정보 조회');
            // 먼저 미팅 인스턴스 목록 조회
            const instancesResponse = await axios.get(
                `https://api.zoom.us/v2/past_meetings/${meetingId}/instances`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            
            console.log('미팅 인스턴스 조회 성공:', JSON.stringify(instancesResponse.data, null, 2));
            
            // 인스턴스가 있으면 가장 최근 인스턴스의 참가자 정보 조회
            if (instancesResponse.data.meetings && instancesResponse.data.meetings.length > 0) {
                const latestInstance = instancesResponse.data.meetings[0];
                const instanceParticipantsResponse = await axios.get(
                    `https://api.zoom.us/v2/past_meetings/${latestInstance.uuid}/participants`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        },
                        params: {
                            page_size: 100
                        }
                    }
                );
                
                participantsData = instanceParticipantsResponse.data;
                console.log('인스턴스 참가자 조회 성공:', JSON.stringify(participantsData, null, 2));
                
                // 참가자가 있으면 바로 반환
                if (participantsData && participantsData.participants && participantsData.participants.length > 0) {
                    return res.json({
                        success: true,
                        message: "미팅 인스턴스 API를 통해 참가자 정보가 조회되었습니다.",
                        data: participantsData,
                        source: "instance_api",
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (error6) {
            console.error('미팅 인스턴스 API 실패:', error6.response?.data || error6.message);
            errorMessages.push({
                api: "instance_api",
                error: error6.response?.data?.message || error6.message
            });
        }
        
        // 모든 시도가 실패하거나 참가자가 없는 경우
        if (!participantsData || !participantsData.participants || participantsData.participants.length === 0) {
            // 미팅 정보 조회
            const meetingInfoResponse = await axios.get(
                `https://api.zoom.us/v2/meetings/${meetingId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            
            return res.json({
                success: true,
                message: "모든 API 시도 후에도 참가자 정보를 찾을 수 없습니다.",
                data: {
                    meeting: meetingInfoResponse.data,
                    participants: [],
                    join_url: meetingInfoResponse.data.join_url
                },
                errors: errorMessages,
                timestamp: new Date().toISOString()
            });
        }
        
        res.json({
            success: true,
            message: "참가자 정보가 조회되었습니다.",
            data: participantsData,
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
        
        res.json({
            success: true,
            message: "현재 진행 중인 미팅 목록이 조회되었습니다.",
            data: meetingsResponse.data,
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
        let participantsData = null;
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
        
        // 참가자 정보 조회 시도
        try {
            const participantsResponse = await axios.get(
                `https://api.zoom.us/v2/metrics/meetings/${meetingId}/participants`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        page_size: 100,
                        type: 'live'
                    }
                }
            );
            
            participantsData = participantsResponse.data;
        } catch (participantsError) {
            console.log('참가자 정보 조회 실패:', participantsError.response?.data || participantsError.message);
            
            // 대체 엔드포인트 시도
            try {
                const alternativeResponse = await axios.get(
                    `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        },
                        params: {
                            page_size: 100
                        }
                    }
                );
                
                participantsData = alternativeResponse.data;
            } catch (alternativeError) {
                console.log('대체 참가자 정보 조회 실패:', alternativeError.response?.data || alternativeError.message);
            }
        }
        
        res.json({
            success: true,
            message: "미팅 상태 및 참가자 정보가 조회되었습니다.",
            data: {
                meeting: meetingInfo,
                status: meetingStatus,
                participants: participantsData
            },
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

module.exports = router; 