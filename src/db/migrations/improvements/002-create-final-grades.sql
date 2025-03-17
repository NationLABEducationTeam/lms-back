-- 성적 관리 시스템 개선 - 최종 성적 테이블 생성
-- 2024-05-07

-- final_grades 테이블 생성
CREATE TABLE IF NOT EXISTS grade_schema.final_grades (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL REFERENCES auth_schema.users(cognito_user_id),
    course_id TEXT NOT NULL REFERENCES course_schema.courses(id),
    attendance_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    assignment_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    exam_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    total_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    attendance_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, course_id)
);

-- 인덱스 생성 (성능 향상)
CREATE INDEX IF NOT EXISTS idx_final_grades_student_id ON grade_schema.final_grades(student_id);
CREATE INDEX IF NOT EXISTS idx_final_grades_course_id ON grade_schema.final_grades(course_id);

-- 코멘트 추가
COMMENT ON TABLE grade_schema.final_grades IS '학생 최종 성적 테이블';
COMMENT ON COLUMN grade_schema.final_grades.id IS '최종 성적 ID';
COMMENT ON COLUMN grade_schema.final_grades.student_id IS '학생 ID (cognito_user_id)';
COMMENT ON COLUMN grade_schema.final_grades.course_id IS '강좌 ID';
COMMENT ON COLUMN grade_schema.final_grades.attendance_score IS '출석 점수';
COMMENT ON COLUMN grade_schema.final_grades.assignment_score IS '과제 점수';
COMMENT ON COLUMN grade_schema.final_grades.exam_score IS '시험 점수';
COMMENT ON COLUMN grade_schema.final_grades.total_score IS '최종 총점';
COMMENT ON COLUMN grade_schema.final_grades.attendance_rate IS '출석률 (%)';

-- enrollment 테이블의 final_grade 컬럼과 연동하는 트리거 생성
CREATE OR REPLACE FUNCTION grade_schema.sync_final_grade()
RETURNS TRIGGER AS $$
BEGIN
    -- final_grades가 업데이트될 때마다 enrollments.final_grade도 업데이트
    UPDATE enrollment_schema.enrollments
    SET final_grade = NEW.total_score
    WHERE student_id = NEW.student_id AND course_id = NEW.course_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 트리거 삭제 후 생성 (기존에 있을 경우)
DROP TRIGGER IF EXISTS tr_sync_final_grade ON grade_schema.final_grades;

CREATE TRIGGER tr_sync_final_grade
AFTER INSERT OR UPDATE ON grade_schema.final_grades
FOR EACH ROW
EXECUTE FUNCTION grade_schema.sync_final_grade(); 