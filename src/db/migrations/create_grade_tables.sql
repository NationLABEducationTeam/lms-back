-- 1. course 테이블에 성적 관련 컬럼 추가
ALTER TABLE course_schema.courses
ADD COLUMN attendance_weight integer DEFAULT 20,
ADD COLUMN assignment_weight integer DEFAULT 50,
ADD COLUMN exam_weight integer DEFAULT 30;

-- 2. grade_items 테이블 수정 (평가 항목)
CREATE TABLE grade_schema.grade_items (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    course_id text NOT NULL REFERENCES course_schema.courses(id),
    type varchar(20) NOT NULL CHECK (type IN ('ATTENDANCE', 'ASSIGNMENT', 'EXAM')),
    title varchar(100) NOT NULL,
    max_score integer NOT NULL DEFAULT 100,
    weight integer NOT NULL,  -- 해당 평가 항목의 가중치
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- 3. student_grades 테이블 수정 (학생별 평가 점수)
CREATE TABLE grade_schema.student_grades (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    student_id text NOT NULL,
    course_id text NOT NULL REFERENCES course_schema.courses(id),
    grade_item_id text NOT NULL REFERENCES grade_schema.grade_items(id),
    score integer DEFAULT 0,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, grade_item_id)  -- 학생당 평가항목 하나만 가능
);

-- 4. course_grade_rules 테이블 삭제
DROP TABLE IF EXISTS grade_schema.course_grade_rules CASCADE; 