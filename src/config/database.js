// TODO: Implement real database connection using VPC
// const mysql = require('mysql2/promise');
// const dotenv = require('dotenv');
// 
// dotenv.config();
// 
// const pool = mysql.createPool({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME,
//     waitForConnections: true,
//     connectionLimit: 10,
//     queueLimit: 0
// });

// Temporary mock query function
const mockPool = {
    query: async (sql, params) => {
        console.log('Mock SQL:', sql);
        console.log('Mock params:', params);

        // Return empty arrays as mock data
        return [[], []];
    }
};

module.exports = mockPool; 