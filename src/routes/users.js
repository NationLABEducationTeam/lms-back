const express = require('express');
const router = express.Router();
const { pool, SCHEMAS, TABLES } = require('../config/database');
const { verifyToken, requireRole } = require('../middlewares/auth');

// Get all users
router.get('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const query = `
            SELECT 
                cognito_user_id, 
                name, 
                email, 
                role,
                created_at,
                updated_at
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            ORDER BY created_at DESC
        `;
        
        const client = await pool.connect();
        try {
            const result = await client.query(query);
            res.json({
                success: true,
                source: 'database',
                data: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to fetch users',
            error: error.message 
        });
    }
});

// Get user by cognito_user_id
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        // 자신의 정보이거나 관리자만 조회 가능
        if (req.user.sub !== id && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const query = `
            SELECT 
                cognito_user_id,
                name,
                email,
                role,
                created_at,
                updated_at
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        
        const client = await pool.connect();
        try {
            const result = await client.query(query, [id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                source: 'database',
                data: result.rows[0]
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user',
            error: error.message
        });
    }
});

module.exports = router; 