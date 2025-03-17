-- 성적 관리 시스템 개선 - 성적 히스토리 테이블 생성
-- 2024-05-07

-- grade_history 테이블 생성
CREATE TABLE IF NOT EXISTS grade_schema.grade_history (
    id SERIAL PRIMARY KEY,
    grade_id INTEGER NOT NULL REFERENCES grade_schema.student_grades(grade_id),
    previous_score NUMERIC(10,5) NOT NULL,
    new_score NUMERIC(10,5) NOT NULL,
    modified_by VARCHAR(36) NOT NULL REFERENCES auth_schema.users(cognito_user_id),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스 생성 (성능 향상)
CREATE INDEX IF NOT EXISTS idx_grade_history_grade_id ON grade_schema.grade_history(grade_id);
CREATE INDEX IF NOT EXISTS idx_grade_history_modified_by ON grade_schema.grade_history(modified_by);
CREATE INDEX IF NOT EXISTS idx_grade_history_created_at ON grade_schema.grade_history(created_at);

-- 코멘트 추가
COMMENT ON TABLE grade_schema.grade_history IS '성적 변경 히스토리 테이블';
COMMENT ON COLUMN grade_schema.grade_history.id IS '히스토리 ID';
COMMENT ON COLUMN grade_schema.grade_history.grade_id IS '학생 성적 ID (student_grades 테이블 참조)';
COMMENT ON COLUMN grade_schema.grade_history.previous_score IS '이전 점수';
COMMENT ON COLUMN grade_schema.grade_history.new_score IS '새 점수';
COMMENT ON COLUMN grade_schema.grade_history.modified_by IS '변경한 사용자 ID';
COMMENT ON COLUMN grade_schema.grade_history.reason IS '변경 사유';

-- 성적 변경 시 히스토리에 자동 기록하는 트리거 생성
CREATE OR REPLACE FUNCTION grade_schema.record_grade_history()
RETURNS TRIGGER AS $$
BEGIN
    -- 점수가 변경된 경우에만 히스토리 기록
    IF OLD.score != NEW.score THEN
        INSERT INTO grade_schema.grade_history (
            grade_id, 
            previous_score, 
            new_score, 
            modified_by, 
            reason
        ) VALUES (
            NEW.grade_id,
            OLD.score,
            NEW.score,
            current_setting('app.current_user_id', true),
            current_setting('app.score_change_reason', true)
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 트리거 삭제 후 생성 (기존에 있을 경우)
DROP TRIGGER IF EXISTS tr_record_grade_history ON grade_schema.student_grades;

CREATE TRIGGER tr_record_grade_history
AFTER UPDATE ON grade_schema.student_grades
FOR EACH ROW
EXECUTE FUNCTION grade_schema.record_grade_history(); 