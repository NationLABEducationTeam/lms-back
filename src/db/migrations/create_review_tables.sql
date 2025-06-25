-- 설문 템플릿 테이블
CREATE TABLE IF NOT EXISTS review_templates (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    s3_key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 설문 응답 테이블
CREATE TABLE IF NOT EXISTS review_responses (
    id UUID PRIMARY KEY,
    review_template_id UUID NOT NULL REFERENCES review_templates(id) ON DELETE CASCADE,
    user_id TEXT,
    submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 설문 답변 테이블
CREATE TABLE IF NOT EXISTS review_answers (
    id UUID PRIMARY KEY,
    response_id UUID NOT NULL REFERENCES review_responses(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_review_templates_created_at ON review_templates(created_at);
CREATE INDEX IF NOT EXISTS idx_review_responses_template_id ON review_responses(review_template_id);
CREATE INDEX IF NOT EXISTS idx_review_responses_user_id ON review_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_review_answers_response_id ON review_answers(response_id);
CREATE INDEX IF NOT EXISTS idx_review_answers_question_id ON review_answers(question_id);

-- 중복 응답 방지를 위한 유니크 제약조건 (사용자당 템플릿별 1회만 응답 가능)
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_responses_unique_user_template 
ON review_responses(review_template_id, user_id) 
WHERE user_id IS NOT NULL;

COMMENT ON TABLE review_templates IS '설문 템플릿 정보';
COMMENT ON TABLE review_responses IS '설문 응답 정보';
COMMENT ON TABLE review_answers IS '설문 답변 정보';

COMMENT ON COLUMN review_templates.s3_key IS 'S3에 저장된 질문 JSON 파일의 키';
COMMENT ON COLUMN review_responses.user_id IS '응답한 사용자 ID (선택적)';
COMMENT ON COLUMN review_answers.question_id IS '질문 ID (템플릿의 questions JSON 내 질문 ID)'; 