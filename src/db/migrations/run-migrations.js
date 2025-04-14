const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// PostgreSQL 연결
const pool = new Pool({
    host: process.env.DB_HOST || 'lmsrds.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
    port: process.env.DB_PORT || 5432,
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

const migrationsToRun = [
    // 기존 마이그레이션
    // ... 다른 마이그레이션 파일들 ...
    
    // 2024-05-17 추가된 마이그레이션
    'enrollment_status_history.sql'
];

async function runMigrations() {
    const client = await pool.connect();
    
    try {
        console.log('마이그레이션 시작...');
        
        // 마이그레이션 로그 테이블 생성 (없는 경우)
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.migration_logs (
                id SERIAL PRIMARY KEY,
                description TEXT NOT NULL,
                executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 각 마이그레이션 파일 실행
        for (const migration of migrationsToRun) {
            const migrationPath = path.join(__dirname, migration);
            
            // 파일 존재 여부 확인
            if (!fs.existsSync(migrationPath)) {
                console.error(`마이그레이션 파일을 찾을 수 없습니다: ${migration}`);
                continue;
            }
            
            console.log(`실행 중: ${migration}`);
            
            // 마이그레이션 파일 읽기
            const sql = fs.readFileSync(migrationPath, 'utf8');
            
            // SQL 실행
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
            
            console.log(`완료: ${migration}`);
        }
        
        console.log('모든 마이그레이션이 성공적으로 완료되었습니다.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('마이그레이션 오류:', error);
    } finally {
        client.release();
        // 연결 종료
        await pool.end();
    }
}

// 마이그레이션 실행
runMigrations(); 