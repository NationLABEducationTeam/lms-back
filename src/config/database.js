const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Database schemas
const SCHEMAS = {
    AUTH: 'auth_schema',
    COMMUNICATION: 'communication_schema',
    COURSE: 'course_schema',
    ENROLLMENT: 'enrollment_schema',
    LEARNING: 'learning_schema'
};

// Tables in each schema
const TABLES = {
    AUTH: {
        USERS: 'users',
        USER_PROFILES: 'user_profiles',
        REFRESH_TOKENS: 'refresh_tokens'
    },
    COMMUNICATION: {
        COMMENTS: 'comments',
        BOARD_TYPES: 'board_types',
        POSTS: 'posts',
        ATTACHMENTS: 'attachments'
    },
    COURSE: {
        MAIN_CATEGORIES: 'main_categories',
        SUB_CATEGORIES: 'sub_categories',
        COURSES: 'courses',
        COURSE_WEEKS: 'course_weeks',
        COURSE_MATERIALS: 'course_materials'
    },
    ENROLLMENT: {
        ENROLLMENTS: 'enrollments',
        PROGRESS_TRACKING: 'progress_tracking'
    },
    LEARNING: {
        ATTENDANCE: 'attendance',
        ASSIGNMENTS: 'assignments',
        ASSIGNMENT_SUBMISSION: 'assignment_submission'
    }
};

// 필수 환경 변수 체크
if (!process.env.DB_HOST) {
    throw new Error('Database host not configured. Please set DB_HOST environment variable.');
}

if (!process.env.DB_NAME) {
    throw new Error('Database name not configured. Please set DB_NAME environment variable.');
}

if (!process.env.DB_USER) {
    throw new Error('Database user not configured. Please set DB_USER environment variable.');
}

if (!process.env.DB_PASSWORD) {
    throw new Error('Database password not configured. Please set DB_PASSWORD environment variable.');
}

// 데이터베이스 연결 설정
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // 로컬 개발 환경에서만 SSL 설정 필요
    ...(process.env.NODE_ENV !== 'production' && {
        ssl: {
            rejectUnauthorized: false
        }
    })
});

// 연결 이벤트 핸들러
pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('Database connection error:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
});

// 연결 테스트 함수
const testConnection = async () => {
    try {
        console.log('Attempting to connect to database...');
        const client = await pool.connect();
        console.log('Successfully acquired client');
        const result = await client.query('SELECT current_database() as db_name');
        console.log('Current database:', result.rows[0].db_name);
        client.release();
        return true;
    } catch (err) {
        console.error('Test connection failed:', err);
        return false;
    }
};

module.exports = { pool, testConnection, SCHEMAS, TABLES }; 