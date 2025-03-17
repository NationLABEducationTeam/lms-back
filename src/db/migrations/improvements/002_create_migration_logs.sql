-- 마이그레이션 로그 테이블 생성 (없는 경우)
CREATE TABLE IF NOT EXISTS public.migration_logs (
    id SERIAL PRIMARY KEY,
    description TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 초기 로그 기록
INSERT INTO public.migration_logs (description)
VALUES ('Migration logs table created or verified'); 