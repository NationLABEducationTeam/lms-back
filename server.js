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

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Hello World endpoint
app.get('/', (req, res) => {
    res.json({ message: 'Hello World! This is running on ECS + Fargate.' });
});

// Routes will be mounted here
// app.use('/api/courses', require('./routes/courses'));
// app.use('/api/admin', require('./routes/admin'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});