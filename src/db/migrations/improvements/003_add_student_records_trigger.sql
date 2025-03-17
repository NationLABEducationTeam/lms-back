-- 학생 레코드 자동 생성을 위한 함수
CREATE OR REPLACE FUNCTION grade_schema.create_student_records()
RETURNS TRIGGER AS $$
BEGIN
    -- 새 평가 항목이 추가되면 모든 등록된 학생에게 성적 레코드 자동 생성
    INSERT INTO grade_schema.student_grades (enrollment_id, item_id, score, is_completed)
    SELECT 
        e.id,
        NEW.item_id,
        0,
        FALSE
    FROM enrollment_schema.enrollments e
    WHERE e.course_id = NEW.course_id
    AND e.status = 'ACTIVE'
    ON CONFLICT (enrollment_id, item_id) DO NOTHING;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 기존 트리거가 있으면 제거
DROP TRIGGER IF EXISTS tr_grade_item_after_insert ON grade_schema.grade_items;

-- 평가 항목 생성 후 학생 레코드 자동 생성 트리거
CREATE TRIGGER tr_grade_item_after_insert
AFTER INSERT ON grade_schema.grade_items
FOR EACH ROW
EXECUTE FUNCTION grade_schema.create_student_records();

-- 디버그 로그
INSERT INTO public.migration_logs (description)
VALUES ('Added automatic student records trigger for new grade items'); 