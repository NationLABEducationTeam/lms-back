const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middlewares/auth');
const { getPool, SCHEMAS, TABLES } = require('../config/database');

/**
 * @swagger
 * tags:
 *   name: Enrollments
 *   description: Course enrollment management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Enrollment:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         course_id:
 *           type: string
 *           format: uuid
 *         student_id:
 *           type: string
 *           format: uuid
 *         enrolled_at:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [ACTIVE, DROPPED, COMPLETED]
 */

/**
 * @swagger
 * /api/v1/enrollments:
 *   post:
 *     summary: Create a new enrollment
 *     tags: [Enrollments]
 *     description: Enrolls a student in a course. Creates related progress tracking and grade records.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [courseId, userId]
 *             properties:
 *               courseId:
 *                 type: string
 *                 format: uuid
 *               userId:
 *                 type: string
 *                 format: uuid
 *               enrolledAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       '201':
 *         description: Enrollment created successfully.
 *       '400':
 *         description: User already enrolled.
 */
// Create enrollment
router.post('/', verifyToken, async (req, res) => {
    const pool = getPool('write');
    const client = await pool.connect();
    
    try {
        const { courseId, userId, enrolledAt } = req.body;

        await client.query('BEGIN');

        // Check if the enrollment already exists
        const checkQuery = `
            SELECT id FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            WHERE course_id = $1 AND student_id = $2
        `;
        const checkResult = await client.query(checkQuery, [courseId, userId]);

        if (checkResult.rows.length > 0) {
            throw new Error('이미 수강신청한 과목입니다.');
        }

        // Create enrollment
        const enrollmentQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            (course_id, student_id, enrolled_at, status)
            VALUES ($1, $2, $3, 'ACTIVE')
            RETURNING *
        `;
        const enrollmentResult = await client.query(enrollmentQuery, [courseId, userId, enrolledAt || new Date()]);
        
        // 생성된 enrollment_id 저장
        const enrollmentId = enrollmentResult.rows[0].id;

        // Create initial progress tracking
        const progressQuery = `
            INSERT INTO ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING}
            (enrollment_id, progress_status, last_accessed_at)
            VALUES ($1, 'NOT_STARTED', $2)
            RETURNING *
        `;
        const progressResult = await client.query(progressQuery, [enrollmentId, enrolledAt || new Date()]);

        // 코스 정보 조회 (weeks_count, assignment_count, exam_count)
        const courseQuery = `
            SELECT weeks_count, assignment_count, exam_count
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES}
            WHERE id = $1
        `;
        const courseResult = await client.query(courseQuery, [courseId]);
        const { weeks_count, assignment_count, exam_count } = courseResult.rows[0];

        // Get all grade items for the course
        const gradeItemsQuery = `
            SELECT item_id, item_type, item_name
            FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1
            ORDER BY item_order
        `;
        const gradeItems = await client.query(gradeItemsQuery, [courseId]);

        // 평가 항목 유형별 개수 계산
        const attendanceItems = gradeItems.rows.filter(item => item.item_type === 'ATTENDANCE');
        const assignmentItems = gradeItems.rows.filter(item => item.item_type === 'ASSIGNMENT');
        const examItems = gradeItems.rows.filter(item => item.item_type === 'EXAM');
        
        console.log(`수강신청 초기화 - 출석: ${attendanceItems.length}/${weeks_count}개, 과제: ${assignmentItems.length}/${assignment_count}개, 시험: ${examItems.length}/${exam_count}개`);

        // 기존 평가 항목에 대한 student_grades 레코드 생성
        if (gradeItems.rows.length > 0) {
            console.log(`${gradeItems.rows.length}개의 평가 항목에 대한 학생 성적 레코드 생성 중...`);
            
            for (const item of gradeItems.rows) {
                await client.query(
                    `INSERT INTO ${SCHEMAS.GRADE}.student_grades 
                    (enrollment_id, item_id, score, is_completed, submission_date)
                    VALUES ($1, $2, 0, false, NULL)`,
                    [enrollmentId, item.item_id]
                );
            }
            
            console.log(`학생 성적 레코드 생성 완료`);
        } else {
            console.log(`평가 항목이 없어 학생 성적 레코드를 생성하지 않음`);
        }

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: '수강신청이 완료되었습니다.',
            data: {
                enrollment: {
                    ...enrollmentResult.rows[0],
                    progress: progressResult.rows[0],
                    grade_items_count: {
                        attendance: attendanceItems.length,
                        assignment: assignmentItems.length,
                        exam: examItems.length,
                        total: gradeItems.rows.length
                    }
                }
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating enrollment:', error);
        res.status(500).json({
            success: false,
            message: '수강신청 중 오류가 발생했습니다.',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/enrollments/course/{courseId}:
 *   get:
 *     summary: Get all enrollments for a course
 *     tags: [Enrollments]
 *     description: Retrieves a list of all students enrolled in a specific course. Requires ADMIN or INSTRUCTOR role.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: A list of enrollments for the course.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enrollments:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Enrollment'
 */
// Get enrollments for a course
router.get('/course/:courseId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { courseId } = req.params;
        const pool = getPool('read');

        const query = `
            SELECT 
                e.*,
                u.given_name as student_name,
                u.email as student_email,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u 
                ON e.student_id = u.cognito_user_id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.course_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [courseId]);

        res.json({
            success: true,
            data: {
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching course enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollments',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/v1/enrollments/student/{studentId}:
 *   get:
 *     summary: Get all enrollments for a student
 *     tags: [Enrollments]
 *     description: Retrieves a list of all courses a student is enrolled in.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: A list of the student's enrollments.
 */
// Get enrollments for a student
router.get('/student/:studentId', verifyToken, async (req, res) => {
    try {
        const { studentId } = req.params;
        
        // 자신의 정보이거나 관리자만 조회 가능
        if (req.user.sub !== studentId && !req.user.groups?.includes('ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Permission denied'
            });
        }

        const pool = getPool('read');
        const query = `
            SELECT 
                e.*,
                c.title as course_title,
                c.description as course_description,
                pt.progress_status,
                pt.last_accessed_at,
                pt.completion_date
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c 
                ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;

        const result = await pool.query(query, [studentId]);

        res.json({
            success: true,
            data: {
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching student enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollments',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/v1/enrollments/{enrollmentId}:
 *   put:
 *     summary: Update enrollment status
 *     tags: [Enrollments]
 *     description: Updates the status of a specific enrollment (e.g., ACTIVE, DROPPED). Requires ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: enrollmentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, DROPPED, COMPLETED]
 *     responses:
 *       '200':
 *         description: Enrollment status updated successfully.
 *       '404':
 *         description: Enrollment not found.
 */
// Update enrollment status
router.put('/:enrollmentId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const pool = getPool('write');
    const client = await pool.connect();
    
    try {
        const { enrollmentId } = req.params;
        const { status } = req.body;

        await client.query('BEGIN');

        // Update enrollment status
        const query = `
            UPDATE ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            SET 
                status = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *
        `;
        
        const result = await client.query(query, [status, enrollmentId]);

        if (result.rows.length === 0) {
            throw new Error('Enrollment not found');
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Enrollment status updated successfully',
            data: {
                enrollment: result.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating enrollment status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update enrollment status',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 진도율 계산 함수
async function calculateProgress(enrollmentId) {
    const pool = getPool('read');
    const client = await pool.connect();
    
    try {
        // 코스 정보 조회
        const courseQuery = `
            SELECT c.weeks_count
            FROM ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c
            JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e ON c.id = e.course_id
            WHERE e.id = $1
        `;
        const courseResult = await client.query(courseQuery, [enrollmentId]);
        
        if (courseResult.rows.length === 0) {
            throw new Error('수강 정보를 찾을 수 없습니다.');
        }
        
        const totalWeeks = parseInt(courseResult.rows[0].weeks_count);
        
        // 완료된 강의 수 조회
        const completedQuery = `
            SELECT COUNT(*) AS completed_weeks
            FROM ${SCHEMAS.GRADE}.student_grades sg
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id = gi.item_id
            WHERE sg.enrollment_id = $1
            AND gi.item_type = 'ATTENDANCE'
            AND sg.is_completed = true
        `;
        const completedResult = await client.query(completedQuery, [enrollmentId]);
        const completedWeeks = parseInt(completedResult.rows[0].completed_weeks);
        
        // 진도율 계산
        const progressRate = (completedWeeks / totalWeeks) * 100;
        
        return {
            completedWeeks,
            totalWeeks,
            progressRate: progressRate.toFixed(2)
        };
    } catch (error) {
        console.error('진도율 계산 중 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * @swagger
 * /api/v1/enrollments/complete-week:
 *   post:
 *     summary: Mark a course week as completed
 *     tags: [Enrollments]
 *     description: Marks a specific week's attendance as completed for an enrollment.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enrollmentId:
 *                 type: string
 *                 format: uuid
 *               weekNumber:
 *                 type: integer
 *     responses:
 *       '200':
 *         description: Week marked as completed.
 *       '400':
 *         description: Missing required parameters.
 *       '404':
 *         description: Attendance item for the week not found.
 */
// 특정 주차 강의 수강 완료 처리
router.post('/complete-week', verifyToken, async (req, res) => {
    const pool = getPool('write');
    const client = await pool.connect();
    
    try {
        const { enrollmentId, weekNumber } = req.body;
        
        if (!enrollmentId || !weekNumber) {
            return res.status(400).json({
                success: false,
                message: '필수 파라미터가 누락되었습니다.'
            });
        }
        
        await client.query('BEGIN');
        
        // 해당 주차의 출석 항목 찾기
        const findItemQuery = `
            SELECT sg.id, sg.item_id
            FROM ${SCHEMAS.GRADE}.student_grades sg
            JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id = gi.item_id
            WHERE sg.enrollment_id = $1
            AND gi.item_type = 'ATTENDANCE'
            AND gi.item_name = $2
        `;
        const itemResult = await client.query(findItemQuery, [enrollmentId, `${weekNumber}주차 출석`]);
        
        if (itemResult.rows.length === 0) {
            throw new Error(`${weekNumber}주차 출석 항목을 찾을 수 없습니다.`);
        }
        
        // 출석 완료 처리
        const updateQuery = `
            UPDATE ${SCHEMAS.GRADE}.student_grades
            SET score = 100, is_completed = true, submission_date = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;
        const updateResult = await client.query(updateQuery, [itemResult.rows[0].id]);
        
        await client.query('COMMIT');
        
        // 진도율 계산
        const progress = await calculateProgress(enrollmentId);
        
        res.json({
            success: true,
            message: `${weekNumber}주차 강의 수강이 완료되었습니다.`,
            data: {
                grade: updateResult.rows[0],
                progress
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('강의 수강 완료 처리 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '강의 수강 완료 처리 중 오류가 발생했습니다.',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @swagger
 * /api/v1/enrollments/progress/{enrollmentId}:
 *   get:
 *     summary: Get enrollment progress
 *     tags: [Enrollments]
 *     description: Calculates and retrieves the progress percentage for a specific enrollment.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: enrollmentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: Progress data.
 *       '404':
 *         description: Enrollment not found.
 */
// 진도율 조회
router.get('/progress/:enrollmentId', verifyToken, async (req, res) => {
    try {
        const { enrollmentId } = req.params;
        
        const progress = await calculateProgress(enrollmentId);
        
        res.json({
            success: true,
            data: {
                progress
            }
        });
    } catch (error) {
        console.error('진도율 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '진도율 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 