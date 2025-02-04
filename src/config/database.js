const { Pool } = require('pg');
const dotenv = require('dotenv');
const chalk = require('chalk');

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

const isProduction = process.env.NODE_ENV === 'production';
const useReadReplica = process.env.USE_READ_REPLICA === 'true' || isProduction;
console.log(chalk.blue('🔧 Environment:'), isProduction ? 'production' : 'development');
console.log(chalk.blue('🔧 Using Read Replica:'), useReadReplica ? 'yes' : 'no');

// Debug database configuration
console.log(chalk.blue('🔧 Database Configuration:'), {
    host: process.env.DB_HOST || 'lmsrds.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
    port: process.env.DB_PORT || 5432,
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

if (useReadReplica) {
    console.log(chalk.blue('🔧 Read Replica Configuration:'), {
        host: process.env.READ_REPLICA_HOST || 'readreplicards.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
        port: process.env.READ_REPLICA_PORT || 5432,
        database: 'postgres',
        user: process.env.DB_USER || 'postgres',
        ssl: { rejectUnauthorized: false },
    });
}

// Add password check (without revealing the actual password)
const dbPassword = process.env.DB_PASSWORD ? String(process.env.DB_PASSWORD) : 'your_password_here';
console.log('DB_PASSWORD environment variable is', process.env.DB_PASSWORD ? 'set' : 'not set');

// Master pool for write operations
const masterPool = new Pool({
    host: process.env.DB_HOST || 'lmsrds.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
    port: process.env.DB_PORT || 5432,
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: { rejectUnauthorized: false }
});

// Read replica pool configuration
const replicaPool = useReadReplica
    ? new Pool({
        host: process.env.READ_REPLICA_HOST || 'readreplicards.cjik2cuykhtl.ap-northeast-2.rds.amazonaws.com',
        port: process.env.READ_REPLICA_PORT || 5432,
        database: 'postgres',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        ssl: { rejectUnauthorized: false }
    })
    : masterPool;

// Function to get appropriate pool based on operation type
const getPool = (operation = 'read') => {
    if (operation === 'write' || !useReadReplica) {
        console.log(chalk.blue('🔄 Using master pool for operation:'), operation);
        return masterPool;
    }
    console.log(chalk.blue('🔄 Using replica pool for operation:'), operation);
    return replicaPool;
};

// Test the connection
masterPool.on('connect', () => {
    console.log(chalk.green('✅ Connected to PostgreSQL master database'));
});

masterPool.on('error', (err) => {
    console.error(chalk.red('❌ Master pool error:'), err);
});

if (useReadReplica) {
    replicaPool.on('connect', () => {
        console.log(chalk.green('✅ Connected to PostgreSQL read replica'));
    });

    replicaPool.on('error', (err) => {
        console.error(chalk.red('❌ Replica pool error:'), err);
    });
}

// Test connection function with more detailed error logging
const testConnection = async () => {
    let client;
    try {
        console.log(chalk.blue('🔄 Attempting to connect to database...'));
        client = await masterPool.connect();
        console.log(chalk.green('✅ Database connection successful'));
        const result = await client.query('SELECT current_database() as db_name, current_user as user, version()');
        console.log(chalk.blue('📊 Database info:'), result.rows[0]);
        return true;
    } catch (err) {
        console.error(chalk.red('❌ Database connection error:'));
        console.error(chalk.red('Error name:'), err.name);
        console.error(chalk.red('Error message:'), err.message);
        console.error(chalk.red('Error stack:'), err.stack);
        return false;
    } finally {
        if (client) {
            client.release();
            console.log(chalk.blue('🔄 Database client released'));
        }
    }
};

// Perform initial connection test
testConnection()
    .then(success => {
        if (!success) {
            console.error(chalk.red('❌ Initial database connection test failed'));
        }
    })
    .catch(err => {
        console.error(chalk.red('❌ Unexpected error during initial connection test:'), err);
    });

module.exports = {
    masterPool,
    replicaPool,
    getPool,
    testConnection,
    SCHEMAS,
    TABLES
}; 