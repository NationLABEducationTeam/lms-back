/**
 * 💾 Database Transaction Middleware
 * Manages database transactions for route handlers
 */

const { pool } = require('../config/database');
const { AppError } = require('./error');

/**
 * Wraps a route handler with transaction management
 * Usage: withTransaction(async (client, req, res) => { ... })
 */
const withTransaction = (handler) => {
    return async (req, res, next) => {
        const client = await pool.connect();
        
        try {
            console.log('🔄 Starting database transaction...');
            await client.query('BEGIN');

            // Add the client to the request object
            req.dbClient = client;
            
            // Execute the handler
            await handler(client, req, res);
            
            console.log('✅ Committing transaction...');
            await client.query('COMMIT');
        } catch (error) {
            console.error('❌ Transaction failed, rolling back...', error);
            await client.query('ROLLBACK');
            
            next(new AppError(error.message, 500));
        } finally {
            console.log('🔚 Releasing database client...');
            client.release();
        }
    };
};

/**
 * Transaction middleware for routes that need transaction management
 * Usage: router.post('/', transactionMiddleware, async (req, res) => { ... })
 */
const transactionMiddleware = async (req, res, next) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        req.dbClient = client;
        
        // Store the original end function
        const originalEnd = res.end;
        
        // Override the end function to handle transaction completion
        res.end = async function(...args) {
            try {
                if (!res.headersSent) {
                    await client.query('COMMIT');
                    console.log('✅ Transaction committed successfully');
                }
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('❌ Transaction rolled back:', error);
                throw error;
            } finally {
                client.release();
                originalEnd.apply(res, args);
            }
        };
        
        next();
    } catch (error) {
        await client.query('ROLLBACK');
        client.release();
        next(error);
    }
};

module.exports = {
    withTransaction,
    transactionMiddleware
}; 