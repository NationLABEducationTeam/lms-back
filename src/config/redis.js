const Redis = require('ioredis');
const chalk = require('chalk');

// AWS ElastiCache for Redis 설정
const redisClient = new Redis({
    host: process.env.ELASTICACHE_HOST,
    port: process.env.ELASTICACHE_PORT || 6379,
    tls: process.env.NODE_ENV === 'production', // 프로덕션 환경에서는 TLS 사용
    connectTimeout: 10000, // 10초
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: false, // AWS ElastiCache에서는 비활성화 권장
    keepAlive: 30000, // 30초
});

// Redis 연결 이벤트 핸들러
redisClient.on('connect', () => {
    console.log(chalk.green('✅ Connected to AWS ElastiCache'));
});

redisClient.on('error', (err) => {
    console.error(chalk.red('❌ AWS ElastiCache connection error:'), err);
});

redisClient.on('reconnecting', () => {
    console.log(chalk.yellow('🔄 Reconnecting to AWS ElastiCache...'));
});

// 캐시 키 prefix 설정
const CACHE_PREFIX = {
    COURSES: 'lms:courses',
    CATEGORIES: 'lms:categories',
    USER_DATA: 'lms:users',
    ENROLLMENTS: 'lms:enrollments'
};

// 캐시 키 생성 헬퍼 함수
const generateCacheKey = (prefix, params) => {
    return `${CACHE_PREFIX[prefix]}:${JSON.stringify(params)}`;
};

// 캐시 TTL 설정 (초 단위)
const CACHE_TTL = {
    COURSES: 3600,          // 1시간
    CATEGORIES: 86400,      // 24시간
    USER_DATA: 1800,        // 30분
    ENROLLMENTS: 300        // 5분
};

// 캐시 관리 헬퍼 함수
const cacheManager = {
    async get(key) {
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error(chalk.red('Redis GET Error:'), error);
            return null;
        }
    },

    async set(key, value, ttl = 3600) {
        try {
            await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
        } catch (error) {
            console.error(chalk.red('Redis SET Error:'), error);
        }
    },

    async del(key) {
        try {
            await redisClient.del(key);
        } catch (error) {
            console.error(chalk.red('Redis DEL Error:'), error);
        }
    },

    async invalidatePattern(pattern) {
        try {
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        } catch (error) {
            console.error(chalk.red('Redis Pattern Invalidation Error:'), error);
        }
    }
};

module.exports = {
    redisClient,
    generateCacheKey,
    CACHE_TTL,
    CACHE_PREFIX,
    cacheManager
}; 