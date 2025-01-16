const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// CORS 설정
app.use(cors());

// 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ status: 'healthy' });
});

// Hello World endpoint
app.get('/', (req, res) => {
  console.log('Root endpoint accessed - Hello World request received');
  res.json({ 
    message: 'NationsLAB가 첫 배포 됐습니다. 많은 관심 주셔서 감사합니다.',
    timestamp: new Date().toISOString()
  });
});

// Routes will be mounted here
// app.use('/api/courses', require('./routes/courses'));
// app.use('/api/admin', require('./routes/admin'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});