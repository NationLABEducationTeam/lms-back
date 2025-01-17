const express = require('express');
const cors = require('cors');
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

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Import routes
const coursesRouter = require('./src/routes/courses');
const studentsRouter = require('./src/routes/students');
const aiRouter = require('./src/routes/ai');

// API 버전 prefix
const API_PREFIX = '/api/v1';

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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  res.status(500).json({ message: 'Something broke!' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});