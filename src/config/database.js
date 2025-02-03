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

// Add password check (without revealing the actual password)
const dbPassword = process.env.DB_PASSWORD ? String(process.env.DB_PASSWORD) : 'your_password_here';
console.log('DB_PASSWORD environment variable is', process.env.DB_PASSWORD ? 'set' : 'not set');
console.log('Initializing database connection with config:', {
    host: process.env.DB_HOST || 'lmsrds.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
    port: process.env.DB_PORT || 5432,
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    // password hidden for security
});

const pool = new Pool({
    host: process.env.DB_HOST || 'lmsrds.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
    port: process.env.DB_PORT || 5432,
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: dbPassword,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test the connection
pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('Database connection error:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
});

// Export an async function to test the connection
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