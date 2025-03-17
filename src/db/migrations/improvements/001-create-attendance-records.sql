-- 성적 관리 시스템 개선 - 출석 기록 테이블 생성
-- 2024-05-07

-- attendance_records 테이블 생성
CREATE TABLE IF NOT EXISTS grade_schema.attendance_records (
    record_id SERIAL PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL REFERENCES auth_schema.users(cognito_user_id),
    course_id TEXT NOT NULL REFERENCES course_schema.courses(id),
    session_type VARCHAR(20) NOT NULL, -- 'LIVE', 'VOD'
    session_id TEXT NOT NULL, -- 강의 세션 ID
    duration_seconds INTEGER NOT NULL DEFAULT 0, -- 학생 참여 시간
    total_duration_seconds INTEGER NOT NULL DEFAULT 0, -- 전체 강의 시간
    attendance_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, course_id, session_id)
);

-- 인덱스 생성 (성능 향상)
CREATE INDEX IF NOT EXISTS idx_attendance_student_id ON grade_schema.attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_course_id ON grade_schema.attendance_records(course_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON grade_schema.attendance_records(attendance_date);

-- 코멘트 추가
COMMENT ON TABLE grade_schema.attendance_records IS '학생 출석 기록 테이블';
COMMENT ON COLUMN grade_schema.attendance_records.record_id IS '출석 기록 ID';
COMMENT ON COLUMN grade_schema.attendance_records.student_id IS '학생 ID (cognito_user_id)';
COMMENT ON COLUMN grade_schema.attendance_records.course_id IS '강좌 ID';
COMMENT ON COLUMN grade_schema.attendance_records.session_type IS '강의 세션 타입 (LIVE, VOD)';
COMMENT ON COLUMN grade_schema.attendance_records.session_id IS '강의 세션 ID';
COMMENT ON COLUMN grade_schema.attendance_records.duration_seconds IS '학생 참여 시간 (초)';
COMMENT ON COLUMN grade_schema.attendance_records.total_duration_seconds IS '전체 강의 시간 (초)';
COMMENT ON COLUMN grade_schema.attendance_records.attendance_date IS '출석 일자'; 