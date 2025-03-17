/**
 * 성적 관리 시스템 개선 SQL 스크립트 실행
 * 2024-05-07
 */

const fs = require('fs');
const path = require('path');
const { masterPool } = require('../../config/database');
const chalk = require('chalk');

async function runMigrations() {
    const client = await masterPool.connect();
    
    try {
        console.log(chalk.yellow('========== 성적 관리 시스템 개선 마이그레이션 시작 =========='));
        
        // 트랜잭션 시작
        await client.query('BEGIN');

        // 개선 스크립트 폴더 경로
        const improvementsDir = path.join(__dirname, 'improvements');
        
        // 폴더 내 모든 SQL 파일 읽기
        const files = fs.readdirSync(improvementsDir)
            .filter(file => file.endsWith('.sql'))
            .sort(); // 파일 이름 순서대로 실행
        
        // 각 SQL 파일 실행
        for (const file of files) {
            console.log(chalk.blue(`실행 중: ${file}`));
            
            const filePath = path.join(improvementsDir, file);
            const sql = fs.readFileSync(filePath, 'utf8');
            
            try {
                await client.query(sql);
                console.log(chalk.green(`✅ 성공: ${file}`));
            } catch (error) {
                console.error(chalk.red(`❌ 오류: ${file}`));
                console.error(chalk.red(error.message));
                
                // 트랜잭션 롤백
                await client.query('ROLLBACK');
                console.log(chalk.red('트랜잭션 롤백됨'));
                return;
            }
        }
        
        // 트랜잭션 커밋
        await client.query('COMMIT');
        console.log(chalk.green('🎉 모든 마이그레이션이 성공적으로 실행되었습니다.'));
        
    } catch (error) {
        console.error(chalk.red('마이그레이션 중 오류 발생:'), error);
        await client.query('ROLLBACK');
        console.log(chalk.red('트랜잭션 롤백됨'));
    } finally {
        client.release();
        console.log(chalk.yellow('========== 성적 관리 시스템 개선 마이그레이션 종료 =========='));
    }
}

// 스크립트가 직접 실행된 경우 마이그레이션 실행
if (require.main === module) {
    runMigrations()
        .then(() => {
            console.log('마이그레이션 프로세스 완료');
            process.exit(0);
        })
        .catch(err => {
            console.error('마이그레이션 프로세스 실패:', err);
            process.exit(1);
        });
}

module.exports = { runMigrations }; 