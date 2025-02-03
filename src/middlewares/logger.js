/**
 * 📝 Request Logging Middleware
 * Logs detailed information about incoming requests and their responses
 */

const chalk = require('chalk');

// Request logging middleware
const requestLogger = (req, res, next) => {
    // Generate unique request ID
    req.id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Capture request start time
    const start = Date.now();
    
    // Log request details
    console.log(
        chalk.cyan('\n🔍 Request:'),
        chalk.yellow(`[${req.id}]`),
        '\n',
        chalk.green('➡️  Method:'), chalk.white(req.method),
        chalk.green('\n➡️  URL:'), chalk.white(req.originalUrl),
        chalk.green('\n➡️  IP:'), chalk.white(req.ip),
        chalk.green('\n➡️  User Agent:'), chalk.white(req.get('user-agent')),
        req.user ? chalk.green('\n➡️  User:') + chalk.white(` ${req.user.sub}`) : ''
    );

    if (Object.keys(req.body).length) {
        console.log(
            chalk.green('➡️  Body:'),
            chalk.white(JSON.stringify(req.body, null, 2))
        );
    }

    // Log response details
    res.on('finish', () => {
        const duration = Date.now() - start;
        const statusColor = res.statusCode >= 500 ? 'red' 
            : res.statusCode >= 400 ? 'yellow'
            : res.statusCode >= 300 ? 'cyan'
            : 'green';

        console.log(
            chalk.cyan('\n✍️  Response:'),
            chalk.yellow(`[${req.id}]`),
            '\n',
            chalk.green('⬅️  Status:'),
            chalk[statusColor](res.statusCode),
            chalk.green('\n⬅️  Duration:'),
            chalk.white(`${duration}ms`),
            '\n'
        );
    });

    next();
};

// Performance monitoring middleware
const performanceMonitor = (req, res, next) => {
    const start = process.hrtime();

    res.on('finish', () => {
        const [seconds, nanoseconds] = process.hrtime(start);
        const duration = seconds * 1000 + nanoseconds / 1000000;

        if (duration > 1000) { // Log slow requests (over 1 second)
            console.log(
                chalk.red('\n⚠️  Slow Request Warning:'),
                chalk.yellow(`[${req.id}]`),
                '\n',
                chalk.green('➡️  Duration:'),
                chalk.red(`${duration.toFixed(2)}ms`),
                chalk.green('\n➡️  Endpoint:'),
                chalk.white(`${req.method} ${req.originalUrl}`),
                '\n'
            );
        }
    });

    next();
};

module.exports = {
    requestLogger,
    performanceMonitor
}; 