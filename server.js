const express = require('express');
const morgan = require('morgan');
const dotenv = require('dotenv');
const dynamodb = require('./src/config/dynamodb');

// Load environment variables
dotenv.config();

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

const TABLE_NAME = 'nationslab-courses';

// Base response (no prefix)
app.get('/', async (req, res) => {
  try {
    console.log('=== Root endpoint accessed - fetching public courses ===');
    
    const params = {
      TableName: TABLE_NAME,
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'published'
      }
    };

    console.log('1. DynamoDB Params:', JSON.stringify(params, null, 2));
    
    const result = await dynamodb.scan(params);
    console.log('2. Raw DynamoDB result:', JSON.stringify(result, null, 2));
    console.log('3. Items from DynamoDB:', JSON.stringify(result.Items, null, 2));
    console.log('4. Count:', result.Count);
    console.log('5. ScannedCount:', result.ScannedCount);

    const responseBody = {
      Items: result.Items || [],
      Count: result.Count || 0,
      ScannedCount: result.ScannedCount || 0
    };

    console.log('6. Response body before stringify:', JSON.stringify(responseBody, null, 2));

    const response = {
      statusCode: 200,
      body: JSON.stringify(responseBody)
    };

    console.log('7. Final response object:', JSON.stringify(response, null, 2));
    console.log('8. Response body type:', typeof response.body);
    
    res.status(response.statusCode).send(response.body);
    console.log('9. Response sent successfully');
  } catch (error) {
    console.error('ERROR in root endpoint:', error);
    console.error('Error stack:', error.stack);
    res.status(500).send(JSON.stringify({
      message: 'Internal server error',
      error: error.message,
      stack: error.stack
    }));
  }
});

// Register routes
app.use(`${API_PREFIX}/courses`, coursesRouter);
app.use(`${API_PREFIX}/students`, studentsRouter);
app.use(`${API_PREFIX}/ai`, aiRouter);
app.use(`${API_PREFIX}/users`, usersRouter);
app.use(`${API_PREFIX}/enrollments`, enrollmentsRouter);
app.use('/courses', require('./src/routes/courses'));
app.use('/admin/courses', require('./src/routes/admin/courses'));

// Handle 404 errors
app.use(notFound);

// Global error handler - should be last
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});