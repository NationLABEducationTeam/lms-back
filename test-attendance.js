require('dotenv').config();
const axios = require('axios');
const readline = require('readline');

// 테스트용 토큰 (여기에 실제 토큰을 넣거나 환경 변수에서 가져옵니다)
const TOKEN = process.env.TEST_AUTH_TOKEN;

// API 엔드포인트 기본 URL
const BASE_URL = 'http://localhost:3000/api/v1/admin/attendance';

// 인터랙티브 CLI 설정
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * HTTP 요청 함수
 */
async function makeRequest(method, endpoint, data = null) {
  try {
    const url = `${BASE_URL}${endpoint}`;
    console.log(`\n${method.toUpperCase()} 요청: ${url}`);
    
    const config = {
      method,
      url,
      headers: {
        'Authorization': `Bearer ${TOKEN}`
      },
      ...(data && { data })
    };
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('API 요청 오류:', error.response?.data || error.message);
    return null;
  }
}

/**
 * 활성화된 미팅 목록 조회
 */
async function getActiveMeetings() {
  console.log('\n=== 활성화된 미팅 목록 조회 ===');
  const result = await makeRequest('get', '/meetings/active');
  
  if (result && result.success) {
    const meetings = result.data.meetings;
    console.log(`활성화된 미팅 수: ${meetings.length}`);
    
    meetings.forEach((meeting, index) => {
      console.log(`\n[${index + 1}] ID: ${meeting.id}`);
      console.log(`    제목: ${meeting.topic}`);
      console.log(`    시작 시간: ${meeting.start_time}`);
      console.log(`    연결된 강좌: ${meeting.course_title || '없음'}`);
    });
    
    return meetings;
  }
  
  return [];
}

/**
 * 종료된 미팅 목록 조회
 */
async function getCompletedMeetings() {
  console.log('\n=== 종료된 미팅 목록 조회 ===');
  const result = await makeRequest('get', '/meetings/completed');
  
  if (result && result.success) {
    const meetings = result.data.meetings;
    console.log(`종료된 미팅 수: ${meetings.length}`);
    
    meetings.forEach((meeting, index) => {
      console.log(`\n[${index + 1}] ID: ${meeting.id}`);
      console.log(`    제목: ${meeting.topic}`);
      console.log(`    시작 시간: ${meeting.start_time}`);
      console.log(`    연결된 강좌: ${meeting.course_title || '없음'}`);
    });
    
    return meetings;
  }
  
  return [];
}

/**
 * 미팅 참가자 목록 조회
 */
async function getMeetingParticipants(meetingId, type = 'past') {
  console.log(`\n=== 미팅 참가자 목록 조회 (ID: ${meetingId}) ===`);
  const result = await makeRequest('get', `/meetings/${meetingId}/participants?type=${type}`);
  
  if (result && result.success) {
    const participants = result.data.participants;
    console.log(`참가자 수: ${participants.length}`);
    
    participants.forEach((participant, index) => {
      console.log(`\n[${index + 1}] 이름: ${participant.user_name || participant.name}`);
      console.log(`    이메일: ${participant.user_email || '없음'}`);
      console.log(`    사용자 ID: ${participant.user_id || '없음'}`);
      console.log(`    참석 시간(분): ${participant.attendance_duration_minutes || 0}`);
      console.log(`    등록된 사용자: ${participant.is_registered ? '예' : '아니오'}`);
    });
    
    return participants;
  }
  
  return [];
}

/**
 * 미팅 출석 현황 요약 조회
 */
async function getMeetingAttendanceSummary(meetingId) {
  console.log(`\n=== 미팅 출석 현황 요약 (ID: ${meetingId}) ===`);
  const result = await makeRequest('get', `/meetings/${meetingId}/attendance-summary`);
  
  if (result && result.success) {
    const { meeting, course, attendance_records, attendance_summary } = result.data;
    
    console.log(`미팅 제목: ${meeting.topic}`);
    console.log(`연결된 강좌: ${course ? course.title : '없음'}`);
    
    if (attendance_summary) {
      console.log(`\n출석 현황 요약:`);
      console.log(`  전체 등록 학생: ${attendance_summary.total_enrolled || 0}명`);
      console.log(`  출석: ${attendance_summary.present || 0}명`);
      console.log(`  지각: ${attendance_summary.late || 0}명`);
      console.log(`  결석(참여기록있음): ${attendance_summary.absent_with_record || 0}명`);
      console.log(`  결석: ${attendance_summary.absent || 0}명`);
      console.log(`  출석률: ${attendance_summary.attendance_rate || 0}%`);
    }
    
    if (attendance_records && attendance_records.length > 0) {
      console.log(`\n개별 학생 출석 현황:`);
      attendance_records.forEach((record, index) => {
        console.log(`\n[${index + 1}] 학생: ${record.student_name}`);
        console.log(`    이메일: ${record.student_email}`);
        console.log(`    참석 시간(분): ${record.attendance_minutes || 0}`);
        console.log(`    출석률: ${record.attendance_rate || 0}%`);
        console.log(`    상태: ${record.status}`);
      });
    }
    
    return result.data;
  }
  
  return null;
}

/**
 * 학생 참석 상세 정보 조회
 */
async function getStudentAttendanceDetails(meetingId, studentId) {
  console.log(`\n=== 학생 참석 상세 정보 (미팅 ID: ${meetingId}, 학생 ID: ${studentId}) ===`);
  const result = await makeRequest('get', `/meetings/${meetingId}/students/${studentId}`);
  
  if (result && result.success) {
    const { student, meeting, attendance } = result.data;
    
    console.log(`학생 이름: ${student.name}`);
    console.log(`이메일: ${student.email}`);
    console.log(`미팅 제목: ${meeting.topic}`);
    console.log(`미팅 시작 시간: ${meeting.start_time}`);
    console.log(`미팅 시간(분): ${meeting.duration_minutes || 60}`);
    
    console.log(`\n출석 정보:`);
    console.log(`  총 참석 시간(분): ${attendance.total_attendance_minutes || 0}`);
    console.log(`  출석률: ${attendance.attendance_rate || 0}%`);
    console.log(`  출석 상태: ${attendance.attendance_status}`);
    
    if (attendance.attendance_records && attendance.attendance_records.length > 0) {
      console.log(`\n참석 세부 기록:`);
      attendance.attendance_records.forEach((record, index) => {
        console.log(`\n[${index + 1}] 입장 시간: ${record.join_time}`);
        console.log(`    퇴장 시간: ${record.leave_time || '기록 없음'}`);
        console.log(`    참석 시간(분): ${record.duration_minutes || 0}`);
        console.log(`    디바이스: ${record.device}`);
      });
    }
    
    return result.data;
  }
  
  return null;
}

/**
 * 메인 메뉴 표시 및 선택 처리
 */
function showMainMenu() {
  console.log('\n===== Zoom 출결 관리 API 테스트 =====');
  console.log('1. 활성화된 미팅 목록 조회');
  console.log('2. 종료된 미팅 목록 조회');
  console.log('3. 미팅 참가자 목록 조회');
  console.log('4. 미팅 출석 현황 요약 조회');
  console.log('5. 학생 참석 상세 정보 조회');
  console.log('0. 종료');
  
  rl.question('\n메뉴 선택: ', async (choice) => {
    switch (choice) {
      case '1':
        await getActiveMeetings();
        showMainMenu();
        break;
      
      case '2':
        await getCompletedMeetings();
        showMainMenu();
        break;
      
      case '3':
        rl.question('미팅 ID 입력: ', async (meetingId) => {
          rl.question('조회 타입 입력 (live/past): ', async (type) => {
            await getMeetingParticipants(meetingId, type || 'past');
            showMainMenu();
          });
        });
        break;
      
      case '4':
        rl.question('미팅 ID 입력: ', async (meetingId) => {
          await getMeetingAttendanceSummary(meetingId);
          showMainMenu();
        });
        break;
      
      case '5':
        rl.question('미팅 ID 입력: ', async (meetingId) => {
          rl.question('학생 ID 입력: ', async (studentId) => {
            await getStudentAttendanceDetails(meetingId, studentId);
            showMainMenu();
          });
        });
        break;
      
      case '0':
        console.log('\n테스트를 종료합니다.');
        rl.close();
        break;
      
      default:
        console.log('\n잘못된 메뉴 선택입니다. 다시 선택해주세요.');
        showMainMenu();
        break;
    }
  });
}

// 테스트 실행
showMainMenu(); 