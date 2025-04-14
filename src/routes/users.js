const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { getPool, SCHEMAS, TABLES } = require('../config/database');

// Get all users
router.get('/', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const pool = getPool('read');
        const query = `
            SELECT 
                u.cognito_user_id,
                u.given_name,
                u.email,
                u.role,
                u.created_at,
                u.updated_at
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
            ORDER BY u.created_at DESC
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: {
                users: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users',
            error: error.message
        });
    }
});

// Get user by ID
router.get('/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // 자신의 정보이거나 관리자만 조회 가능
        if (req.user.sub !== userId && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const pool = getPool('read');
        const query = `
            SELECT 
                u.cognito_user_id,
                u.given_name,
                u.email,
                u.role,
                u.created_at,
                u.updated_at
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u
            WHERE u.cognito_user_id = $1
        `;
        
        const result = await pool.query(query, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            data: {
                user: result.rows[0]
            }
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user',
            error: error.message
        });
    }
});

// Update user
router.put('/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { name, email } = req.body;
        
        // 자신의 정보만 수정 가능
        if (req.user.sub !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const pool = getPool('write');
        const query = `
            UPDATE ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            SET 
                name = COALESCE($1, name),
                email = COALESCE($2, email),
                updated_at = CURRENT_TIMESTAMP
            WHERE cognito_user_id = $3
            RETURNING *
        `;
        
        const result = await pool.query(query, [name, email, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            message: 'User updated successfully',
            data: {
                user: result.rows[0]
            }
        });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user',
            error: error.message
        });
    }
});

module.exports = router; 