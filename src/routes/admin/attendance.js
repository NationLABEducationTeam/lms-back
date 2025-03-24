const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');

// Zoom API 설정
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;

/**
 * Zoom API 토큰 발급 함수
 * @returns {Promise<string>} Zoom API 토큰
 */
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

/**
 * 활성화된 모든 Zoom 미팅 목록 조회
 */
router.get('/meetings/active', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 사용자 정보 조회
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
        
        // 사용자에게 관련 강좌 정보와 함께 미팅 정보 전송
        const client = await masterPool.connect();
        try {
            // 미팅 목록에서 미팅 ID 추출
            const meetingIds = meetingsResponse.data.meetings.map(meeting => meeting.id);
            
            // 미팅 ID에 해당하는 강좌 정보 조회 (DB에 저장된 경우)
            let courseInfo = [];
            if (meetingIds.length > 0) {
                const courseResult = await client.query(`
                    SELECT c.id, c.title, c.zoom_meeting_id 
                    FROM course_schema.courses c
                    WHERE c.zoom_meeting_id = ANY($1::text[])
                `, [meetingIds]);
                
                courseInfo = courseResult.rows;
            }
            
            // 미팅 정보에 강좌 정보 매핑
            const meetingsWithCourseInfo = meetingsResponse.data.meetings.map(meeting => {
                const course = courseInfo.find(c => c.zoom_meeting_id === meeting.id.toString());
                return {
                    ...meeting,
                    course_id: course?.id || null,
                    course_title: course?.title || null
                };
            });
            
            res.json({
                success: true,
                data: {
                    meetings: meetingsWithCourseInfo,
                    total: meetingsResponse.data.total_records
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('활성화된 Zoom 미팅 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: '활성화된 Zoom 미팅 정보를 조회하는 중 오류가 발생했습니다.',
            error: error.response?.data?.message || error.message
        });
    }
});

/**
 * 종료된 모든 Zoom 미팅 목록 조회 (최근 30일)
 */
router.get('/meetings/completed', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { page = 1, page_size = 20 } = req.query;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 사용자 정보 조회
        const userResponse = await axios.get(
            'https://api.zoom.us/v2/users/me',
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        
        const userId = userResponse.data.id;
        
        // 지난 30일 동안의 미팅 목록 조회
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 30);
        const fromDateStr = fromDate.toISOString().split('T')[0];
        
        const toDate = new Date();
        const toDateStr = toDate.toISOString().split('T')[0];
        
        // 종료된 미팅 목록 조회
        const meetingsResponse = await axios.get(
            `https://api.zoom.us/v2/users/${userId}/meetings`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    type: 'scheduled', // 예약된 미팅 (종료된 미팅 포함)
                    page_size: page_size,
                    page_number: page
                }
            }
        );
        
        // 종료된 미팅만 필터링
        const completedMeetings = meetingsResponse.data.meetings.filter(meeting => {
            const meetingStartTime = new Date(meeting.start_time);
            const currentTime = new Date();
            return meetingStartTime < currentTime;
        });
        
        // 사용자에게 관련 강좌 정보와 함께 미팅 정보 전송
        const client = await masterPool.connect();
        try {
            // 미팅 목록에서 미팅 ID 추출
            const meetingIds = completedMeetings.map(meeting => meeting.id);
            
            // 미팅 ID에 해당하는 강좌 정보 조회 (DB에 저장된 경우)
            let courseInfo = [];
            if (meetingIds.length > 0) {
                const courseResult = await client.query(`
                    SELECT c.id, c.title, c.zoom_meeting_id 
                    FROM course_schema.courses c
                    WHERE c.zoom_meeting_id = ANY($1::text[])
                `, [meetingIds]);
                
                courseInfo = courseResult.rows;
            }
            
            // 미팅 정보에 강좌 정보 매핑
            const meetingsWithCourseInfo = completedMeetings.map(meeting => {
                const course = courseInfo.find(c => c.zoom_meeting_id === meeting.id.toString());
                return {
                    ...meeting,
                    course_id: course?.id || null,
                    course_title: course?.title || null
                };
            });
            
            res.json({
                success: true,
                data: {
                    meetings: meetingsWithCourseInfo,
                    total: meetingsResponse.data.total_records
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('종료된 Zoom 미팅 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: '종료된 Zoom 미팅 정보를 조회하는 중 오류가 발생했습니다.',
            error: error.response?.data?.message || error.message
        });
    }
});

/**
 * 특정 미팅의 참가자 목록 조회
 */
router.get('/meetings/:meetingId/participants', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { meetingId } = req.params;
        const { type = 'live' } = req.query; // live: 실시간 참석자, past: 종료된 미팅 참석자
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        let participantsData = { participants: [] };
        let apiEndpoint = '';
        
        if (type === 'live') {
            // 실시간 참가자 조회 (Dashboard API)
            apiEndpoint = `https://api.zoom.us/v2/metrics/meetings/${meetingId}/participants`;
        } else {
            // 종료된 미팅 참가자 조회 (Past Meeting API)
            apiEndpoint = `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`;
        }
        
        try {
            const response = await axios.get(
                apiEndpoint,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: { 
                        page_size: 100,
                        type: type === 'live' ? 'live' : undefined
                    }
                }
            );
            
            participantsData = response.data;
        } catch (participantsError) {
            // 첫 번째 API 실패시 다른 API 시도
            console.log('첫 번째 API 실패, 대체 API 시도:', participantsError.response?.data || participantsError.message);
            
            // 대체 API 목록
            const alternativeEndpoints = [
                // 미팅 참가자 (Meeting API)
                `https://api.zoom.us/v2/meetings/${meetingId}/participants`,
                // 보고서 참가자 (Report API)
                `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`
            ];
            
            for (const endpoint of alternativeEndpoints) {
                try {
                    const response = await axios.get(
                        endpoint,
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            },
                            params: { page_size: 100 }
                        }
                    );
                    
                    if (response.data.participants) {
                        participantsData = response.data;
                        break;
                    }
                } catch (altError) {
                    console.log(`대체 API ${endpoint} 실패:`, altError.response?.data || altError.message);
                }
            }
        }
        
        // 참가자 목록 추가 처리 (이름, 이메일 등)
        const enhancedParticipants = await enhanceParticipantsData(participantsData.participants);
        
        res.json({
            success: true,
            data: {
                meeting_id: meetingId,
                participants: enhancedParticipants,
                total_participants: enhancedParticipants.length
            }
        });
    } catch (error) {
        console.error('Zoom 미팅 참가자 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Zoom 미팅 참가자 정보를 조회하는 중 오류가 발생했습니다.',
            error: error.response?.data?.message || error.message
        });
    }
});

/**
 * 데이터베이스에서 사용자 정보로 참가자 데이터 보강
 */
async function enhanceParticipantsData(participants) {
    if (!participants || participants.length === 0) {
        return [];
    }
    
    const client = await masterPool.connect();
    try {
        // 참가자 이메일 목록 추출
        const emails = participants
            .filter(p => p.user_email)
            .map(p => p.user_email.toLowerCase());
        
        // 이메일에 해당하는 사용자 정보 조회
        let userInfo = [];
        if (emails.length > 0) {
            const userResult = await client.query(`
                SELECT cognito_user_id, email, name, role
                FROM auth_schema.users
                WHERE LOWER(email) = ANY($1::text[])
            `, [emails]);
            
            userInfo = userResult.rows;
        }
        
        // 참가자 정보에 사용자 정보 매핑
        return participants.map(participant => {
            const userEmail = participant.user_email ? participant.user_email.toLowerCase() : null;
            const user = userInfo.find(u => u.email && u.email.toLowerCase() === userEmail);
            
            const joinTime = participant.join_time ? new Date(participant.join_time) : null;
            const leaveTime = participant.leave_time ? new Date(participant.leave_time) : null;
            
            // 참석 시간 계산 (분 단위)
            let attendanceDuration = 0;
            if (joinTime && leaveTime) {
                attendanceDuration = Math.floor((leaveTime - joinTime) / (1000 * 60));
            } else if (joinTime && participant.duration) {
                attendanceDuration = Math.floor(participant.duration / 60);
            }
            
            return {
                ...participant,
                user_id: user?.cognito_user_id || null,
                user_name: user?.name || participant.name,
                user_role: user?.role || null,
                attendance_duration_minutes: attendanceDuration,
                is_registered: !!user
            };
        });
    } finally {
        client.release();
    }
}

/**
 * 특정 학생의 미팅 참석 상세 정보 조회
 */
router.get('/meetings/:meetingId/students/:studentId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { meetingId, studentId } = req.params;
        
        // Zoom API 토큰 발급
        const token = await getZoomToken();
        
        // 학생 정보 조회
        const client = await masterPool.connect();
        try {
            const studentResult = await client.query(`
                SELECT cognito_user_id, email, name, role
                FROM auth_schema.users
                WHERE cognito_user_id = $1
            `, [studentId]);
            
            if (studentResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: '학생 정보를 찾을 수 없습니다.'
                });
            }
            
            const student = studentResult.rows[0];
            
            // 미팅 정보 조회
            const meetingResponse = await axios.get(
                `https://api.zoom.us/v2/meetings/${meetingId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            
            const meetingInfo = meetingResponse.data;
            
            // 학생 참석 정보 조회 (여러 API 시도)
            const endpoints = [
                // 종료된 미팅 참가자 (Past Meeting API)
                {
                    url: `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
                    params: { page_size: 100 }
                },
                // 미팅 참가자 (Meeting API)
                {
                    url: `https://api.zoom.us/v2/meetings/${meetingId}/participants`,
                    params: { page_size: 100 }
                },
                // 보고서 참가자 (Report API)
                {
                    url: `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`,
                    params: { page_size: 100 }
                }
            ];
            
            let studentAttendanceRecords = [];
            
            for (const endpoint of endpoints) {
                try {
                    const response = await axios.get(
                        endpoint.url,
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            },
                            params: endpoint.params
                        }
                    );
                    
                    if (response.data.participants) {
                        // 해당 학생의 참석 기록만 필터링
                        const studentRecords = response.data.participants.filter(
                            p => p.user_email && p.user_email.toLowerCase() === student.email.toLowerCase()
                        );
                        
                        if (studentRecords.length > 0) {
                            studentAttendanceRecords = studentRecords;
                            break;
                        }
                    }
                } catch (error) {
                    console.log(`엔드포인트 ${endpoint.url} 조회 실패:`, error.response?.data || error.message);
                }
            }
            
            // 학생 참석 시간 계산
            let totalAttendanceMinutes = 0;
            const attendanceDetails = studentAttendanceRecords.map(record => {
                const joinTime = record.join_time ? new Date(record.join_time) : null;
                const leaveTime = record.leave_time ? new Date(record.leave_time) : null;
                
                let durationMinutes = 0;
                if (joinTime && leaveTime) {
                    durationMinutes = Math.floor((leaveTime - joinTime) / (1000 * 60));
                } else if (record.duration) {
                    durationMinutes = Math.floor(record.duration / 60);
                }
                
                totalAttendanceMinutes += durationMinutes;
                
                return {
                    join_time: record.join_time,
                    leave_time: record.leave_time || null,
                    duration_minutes: durationMinutes,
                    device: record.device || '알 수 없음'
                };
            });
            
            // 미팅 전체 시간 (분 단위, 기본값 60분)
            const meetingDurationMinutes = meetingInfo.duration || 60;
            
            // 출석 상태 계산 (80% 이상 참석 시 출석)
            const attendanceRate = meetingDurationMinutes > 0 
                ? (totalAttendanceMinutes / meetingDurationMinutes) * 100 
                : 0;
            
            const attendanceStatus = attendanceRate >= 80 ? '출석' : 
                                    attendanceRate >= 50 ? '지각' : 
                                    attendanceRate > 0 ? '결석(참여기록있음)' : '결석';
            
            res.json({
                success: true,
                data: {
                    student: {
                        id: student.cognito_user_id,
                        name: student.name,
                        email: student.email
                    },
                    meeting: {
                        id: meetingInfo.id,
                        topic: meetingInfo.topic,
                        start_time: meetingInfo.start_time,
                        duration_minutes: meetingInfo.duration
                    },
                    attendance: {
                        attendance_records: attendanceDetails,
                        total_attendance_minutes: totalAttendanceMinutes,
                        attendance_rate: parseFloat(attendanceRate.toFixed(2)),
                        attendance_status: attendanceStatus
                    }
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('학생 미팅 참석 정보 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: '학생 미팅 참석 정보를 조회하는 중 오류가 발생했습니다.',
            error: error.response?.data?.message || error.message
        });
    }
});

/**
 * 특정 미팅의 출석 현황 요약 조회
 */
router.get('/meetings/:meetingId/attendance-summary', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
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
        
        const meetingInfo = meetingResponse.data;
        
        // 참가자 정보 조회
        const participantsResponse = await axios.get(
            `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: { page_size: 300 }
            }
        );
        
        const participants = participantsResponse.data.participants || [];
        
        // 강좌 정보 및 학생 목록 조회
        const client = await masterPool.connect();
        try {
            // 미팅 ID와 연결된 강좌 정보 조회
            const courseResult = await client.query(`
                SELECT c.id, c.title
                FROM course_schema.courses c
                WHERE c.zoom_meeting_id = $1
            `, [meetingId]);
            
            if (courseResult.rows.length === 0) {
                // 연결된 강좌가 없으면 참가자 정보만 반환
                const enhancedParticipants = await enhanceParticipantsData(participants);
                
                return res.json({
                    success: true,
                    data: {
                        meeting: meetingInfo,
                        participants: enhancedParticipants,
                        course: null,
                        enrolled_students: [],
                        attendance_summary: {
                            total_participants: enhancedParticipants.length,
                            registered_participants: enhancedParticipants.filter(p => p.is_registered).length
                        }
                    }
                });
            }
            
            const course = courseResult.rows[0];
            
            // 강좌에 등록된 학생 목록 조회
            const studentsResult = await client.query(`
                SELECT u.cognito_user_id, u.email, u.name
                FROM enrollment_schema.enrollments e
                JOIN auth_schema.users u ON e.student_id = u.cognito_user_id
                WHERE e.course_id = $1 AND e.status = 'ACTIVE'
            `, [course.id]);
            
            const enrolledStudents = studentsResult.rows;
            
            // 참가자 정보 보강
            const enhancedParticipants = await enhanceParticipantsData(participants);
            
            // 각 학생의 출석 상태 계산
            const attendanceStatus = enrolledStudents.map(student => {
                // 학생의 참석 기록 찾기
                const studentRecords = enhancedParticipants.filter(
                    p => p.user_email && p.user_email.toLowerCase() === student.email.toLowerCase()
                );
                
                // 총 참석 시간 계산
                let totalAttendanceMinutes = 0;
                studentRecords.forEach(record => {
                    totalAttendanceMinutes += record.attendance_duration_minutes || 0;
                });
                
                // 미팅 시간 (분)
                const meetingDurationMinutes = meetingInfo.duration || 60;
                
                // 출석률 계산
                const attendanceRate = meetingDurationMinutes > 0 
                    ? (totalAttendanceMinutes / meetingDurationMinutes) * 100 
                    : 0;
                
                // 출석 상태 결정
                const status = attendanceRate >= 80 ? '출석' : 
                              attendanceRate >= 50 ? '지각' : 
                              attendanceRate > 0 ? '결석(참여기록있음)' : '결석';
                
                return {
                    student_id: student.cognito_user_id,
                    student_name: student.name,
                    student_email: student.email,
                    attendance_minutes: totalAttendanceMinutes,
                    attendance_rate: parseFloat(attendanceRate.toFixed(2)),
                    status: status,
                    has_attendance_record: studentRecords.length > 0
                };
            });
            
            // 출석 통계 계산
            const attendanceSummary = {
                total_enrolled: enrolledStudents.length,
                present: attendanceStatus.filter(a => a.status === '출석').length,
                late: attendanceStatus.filter(a => a.status === '지각').length,
                absent_with_record: attendanceStatus.filter(a => a.status === '결석(참여기록있음)').length,
                absent: attendanceStatus.filter(a => a.status === '결석').length,
                attendance_rate: enrolledStudents.length > 0 
                    ? parseFloat(((attendanceStatus.filter(a => a.status === '출석').length / enrolledStudents.length) * 100).toFixed(2))
                    : 0
            };
            
            res.json({
                success: true,
                data: {
                    meeting: meetingInfo,
                    course: course,
                    attendance_records: attendanceStatus,
                    attendance_summary: attendanceSummary
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('미팅 출석 현황 조회 오류:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: '미팅 출석 현황을 조회하는 중 오류가 발생했습니다.',
            error: error.response?.data?.message || error.message
        });
    }
});

module.exports = router; 