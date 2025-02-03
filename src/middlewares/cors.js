/**
 * 🌐 CORS Middleware Configuration
 * Handles Cross-Origin Resource Sharing settings
 */

const cors = require('cors');

// CORS options for different environments
const corsOptions = {
    development: {
        origin: ['http://localhost:3001', 'http://localhost:5173'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Requested-With',
            'Accept',
            'Origin'
        ],
        exposedHeaders: ['Content-Range', 'X-Content-Range'],
        maxAge: 600 // 10 minutes
    },
    production: {
        origin: [
            'https://lms.nationslab.com',
            'https://admin.nationslab.com'
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Requested-With',
            'Accept',
            'Origin'
        ],
        exposedHeaders: ['Content-Range', 'X-Content-Range'],
        maxAge: 600
    }
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
    // Basic security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Content Security Policy
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "img-src 'self' data: https:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            "connect-src 'self' https://cognito-idp.ap-northeast-2.amazonaws.com"
        ].join('; '));
    }

    next();
};

// Export configured CORS middleware
const corsMiddleware = cors(
    process.env.NODE_ENV === 'production' 
        ? corsOptions.production 
        : corsOptions.development
);

module.exports = {
    corsMiddleware,
    securityHeaders
}; 