const express = require('express');
const router = express.Router();
const { masterPool, SCHEMAS, TABLES } = require('../config/database');

// Valid enum values
const VALID_ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'];
const VALID_STATUSES = ['ACTIVE', 'COMPLETED', 'DROPPED'];

/**
 * Cognito 회원가입 후 RDS에 사용자 정보를 동기화하는 엔드포인트
 * Cognito Trigger(Post Confirmation)에서 호출됨
 */
router.post('/sync-user', async (req, res) => {
    const client = await masterPool.connect();
    try {
        const {
            cognito_user_id,  // Cognito의 sub 값
            email,
            name,
            given_name,
            role = 'STUDENT',  // 기본값은 STUDENT
            status = 'ACTIVE'  // 기본값은 ACTIVE
        } = req.body;

        // Validate required fields
        if (!cognito_user_id || !email || !name) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: cognito_user_id, email, and name are required'
            });
        }

        // Validate role
        const upperRole = role.toUpperCase();
        if (!VALID_ROLES.includes(upperRole)) {
            return res.status(400).json({
                success: false,
                message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`
            });
        }

        // Validate status
        const upperStatus = status.toUpperCase();
        if (!VALID_STATUSES.includes(upperStatus)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`
            });
        }

        await client.query('BEGIN');

        // Check if user already exists
        const checkQuery = `
            SELECT cognito_user_id 
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        const checkResult = await client.query(checkQuery, [cognito_user_id]);

        if (checkResult.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: 'User already exists'
            });
        }

        // Insert new user
        const insertQuery = `
            INSERT INTO ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            (cognito_user_id, email, name, given_name, role, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const result = await client.query(insertQuery, [
            cognito_user_id,
            email,
            name,
            given_name || name,  // given_name이 없으면 name을 사용
            upperRole,
            upperStatus
        ]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'User synchronized successfully',
            data: {
                user: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error synchronizing user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to synchronize user',
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router; 