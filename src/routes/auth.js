const express = require('express');
const router = express.Router();
const { masterPool, SCHEMAS, TABLES } = require('../config/database');

// Valid enum values
const VALID_ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'];
const VALID_STATUSES = ['ACTIVE', 'COMPLETED', 'DROPPED'];

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and synchronization
 */

/**
 * @swagger
 * /auth/sync-user:
 *   post:
 *     summary: Sync user data from Cognito
 *     tags: [Auth]
 *     description: This endpoint is intended to be called by an AWS Cognito Post Confirmation trigger. It synchronizes the user's data from Cognito to the local application database.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cognito_user_id:
 *                 type: string
 *                 description: The user's sub claim from Cognito.
 *               email:
 *                 type: string
 *                 format: email
 *               name:
 *                 type: string
 *                 description: The user's full name.
 *               given_name:
 *                 type: string
 *                 description: The user's given name.
 *               role:
 *                 type: string
 *                 description: The user's role.
 *                 enum: [STUDENT, INSTRUCTOR, ADMIN]
 *                 default: STUDENT
 *               status:
 *                 type: string
 *                 description: The user's status.
 *                 enum: [ACTIVE, COMPLETED, DROPPED]
 *                 default: ACTIVE
 *             required:
 *               - cognito_user_id
 *               - email
 *               - name
 *     responses:
 *       '201':
 *         description: User synchronized successfully.
 *         content:
 *           application/json:
 *             schema:
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       '400':
 *         description: Bad request, missing required fields or invalid values.
 *       '409':
 *         description: Conflict, user with this cognito_user_id already exists.
 *       '500':
 *         description: Internal server error.
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