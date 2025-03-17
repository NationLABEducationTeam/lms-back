-- student_grades 테이블에 고유 제약조건 추가
ALTER TABLE grade_schema.student_grades 
ADD CONSTRAINT student_grades_enrollment_item_unique 
UNIQUE (enrollment_id, item_id);

-- 마이그레이션 로그 기록
INSERT INTO public.migration_logs (description)
VALUES ('Added unique constraint on student_grades (enrollment_id, item_id)'); 