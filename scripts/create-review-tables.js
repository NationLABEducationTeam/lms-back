const { masterPool } = require('../src/config/database');
const fs = require('fs');
const path = require('path');

async function createReviewTables() {
    const client = await masterPool.connect();
    
    try {
        console.log('🚀 Creating review tables...');
        
        // SQL 파일 읽기
        const sqlFile = path.join(__dirname, '../src/db/migrations/create_review_tables.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');
        
        // SQL 실행
        await client.query(sql);
        
        console.log('✅ Review tables created successfully!');
        
        // 테이블 확인
        const result = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'review_%'
            ORDER BY table_name
        `);
        
        console.log('📊 Created tables:');
        result.rows.forEach(row => {
            console.log(`  - ${row.table_name}`);
        });
        
    } catch (error) {
        console.error('❌ Error creating review tables:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 스크립트가 직접 실행될 때만 실행
if (require.main === module) {
    createReviewTables()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { createReviewTables }; 