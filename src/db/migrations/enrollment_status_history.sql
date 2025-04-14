-- 수강 상태 변경 이력 테이블 생성
-- 2024-05-17

-- 테이블이 없으면 생성
CREATE TABLE IF NOT EXISTS enrollment_schema.enrollment_status_history (
    id SERIAL PRIMARY KEY,
    enrollment_id UUID NOT NULL REFERENCES enrollment_schema.enrollments(id),
    previous_status VARCHAR(20) NOT NULL,
    new_status VARCHAR(20) NOT NULL,
    modified_by VARCHAR(36) NOT NULL REFERENCES auth_schema.users(cognito_user_id),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_enrollment_status_history_enrollment_id ON enrollment_schema.enrollment_status_history(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_status_history_modified_by ON enrollment_schema.enrollment_status_history(modified_by);

-- 코멘트 추가
COMMENT ON TABLE enrollment_schema.enrollment_status_history IS '수강 상태 변경 이력 테이블';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.id IS '이력 ID';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.enrollment_id IS '수강 ID';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.previous_status IS '이전 상태';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.new_status IS '새로운 상태';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.modified_by IS '변경한 사용자 ID';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.reason IS '변경 사유';
COMMENT ON COLUMN enrollment_schema.enrollment_status_history.created_at IS '변경 일시';

-- 마이그레이션 로그
INSERT INTO public.migration_logs (description)
VALUES ('수강 상태 변경 이력 테이블 생성'); 