const express = require('express');
const morgan = require('morgan');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Alias VITE_ AWS credentials to AWS_ env vars for AWS SDKs
process.env.AWS_REGION = process.env.AWS_REGION || process.env.VITE_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.VITE_AWS_ACCESS_KEY_ID;
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.VITE_AWS_SECRET_ACCESS_KEY;

// Check if AWS credentials are loaded
console.log('Checking AWS credentials at server start:', {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ? 'Set' : 'Not set',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'Not set',
    AWS_REGION: process.env.AWS_REGION
});

// Import middlewares
const { corsMiddleware, securityHeaders } = require('./src/middlewares/cors');
const { requestLogger, performanceMonitor } = require('./src/middlewares/logger');
const { errorHandler, notFound } = require('./src/middlewares/error');

// Import routes
const coursesRouter = require('./src/routes/courses');
const studentsRouter = require('./src/routes/students');
const aiRouter = require('./src/routes/ai');
const usersRouter = require('./src/routes/users');
const enrollmentsRouter = require('./src/routes/enrollments');
const authRoutes = require('./src/routes/auth');
const timemarksRouter = require('./src/routes/timemarks');
const assignmentsRouter = require('./src/routes/assignments');
const adminAssignmentsRouter = require('./src/routes/admin/assignments');
const adminAttendanceRouter = require('./src/routes/admin/attendance');

const app = express();

// API version prefix
const API_PREFIX = '/api/v1';

/**
 * 🔧 Middleware Stack
 * Order is important!
 */

// 1. Basic middlewares
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 2. Security middlewares
app.use(corsMiddleware);
app.use(securityHeaders);

// 3. Logging middlewares
app.use(morgan('dev'));
app.use(requestLogger);
app.use(performanceMonitor);

// Health check endpoint (no prefix)
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Base response - redirect to public courses
app.get('/', (req, res) => {
    res.redirect(301, '/api/v1/courses/public');
});

// Register routes
app.use(`${API_PREFIX}/courses`, coursesRouter);
app.use(`${API_PREFIX}/students`, studentsRouter);
app.use(`${API_PREFIX}/ai`, aiRouter);
app.use(`${API_PREFIX}/users`, usersRouter);
app.use(`${API_PREFIX}/enrollments`, enrollmentsRouter);
app.use(`${API_PREFIX}/admin/courses`, require('./src/routes/admin/courses'));
app.use(`${API_PREFIX}/admin/grades`, require('./src/routes/admin/grades'));
app.use(`${API_PREFIX}/admin/assignments`, adminAssignmentsRouter);
app.use(`${API_PREFIX}/admin/zoom`, require('./src/routes/admin/zoom'));
app.use(`${API_PREFIX}/admin/zoom-test`, require('./src/routes/admin/zoom-test'));
app.use(`${API_PREFIX}/admin/attendance`, adminAttendanceRouter);
app.use(`${API_PREFIX}/admin/enrollments`, require('./src/routes/admin/enrollments'));
app.use(`${API_PREFIX}/timemarks`, timemarksRouter);
app.use(`${API_PREFIX}/assignments`, assignmentsRouter);
app.use('/auth', authRoutes);

// 별칭 라우터: /student/grade/{courseId} -> /courses/{courseId}/my-grades
app.get(`${API_PREFIX}/student/grade/:courseId`, (req, res) => {
    res.redirect(301, `${API_PREFIX}/courses/${req.params.courseId}/my-grades`);
});

// Handle 404 errors
app.use(notFound);

// Global error handler - should be last
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});