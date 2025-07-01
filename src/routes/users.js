const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { getPool, SCHEMAS, TABLES } = require('../config/database');

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User management APIs
 */

/**
 * @swagger
 * /api/v1/users:
 *   get:
 *     summary: Retrieve a list of all users
 *     tags: [Users]
 *     description: Fetches a complete list of all users. Requires ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: A list of users.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/User'
 *                     total:
 *                       type: integer
 *       '401':
 *         description: Unauthorized, token is missing or invalid.
 *       '403':
 *         description: Forbidden, user is not an ADMIN.
 */
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
        console.error('Error fetching all users:', error, 'Requesting user roles:', req.user['cognito:groups']);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/v1/users/{userId}:
 *   get:
 *     summary: Retrieve a specific user by ID
 *     tags: [Users]
 *     description: Fetches details for a specific user. Users can fetch their own profile. Admins can fetch any user's profile.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user to retrieve.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: User data.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       '403':
 *         description: Permission denied.
 *       '404':
 *         description: User not found.
 */
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

/**
 * @swagger
 * /api/v1/users/{userId}:
 *   put:
 *     summary: Update a user's profile
 *     tags: [Users]
 *     description: Updates a user's profile information. Users can only update their own profile.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user to update.
 *         schema:
 *           type: string
 *     requestBody:
 *       description: User data to update.
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: The user's new full name.
 *               email:
 *                 type: string
 *                 format: email
 *                 description: The user's new email address.
 *     responses:
 *       '200':
 *         description: User updated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
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
 *       '403':
 *         description: Permission denied.
 *       '404':
 *         description: User not found.
 */
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