const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, getPool, SCHEMAS, TABLES } = require('../../config/database');
const dynamoDB = require('../../config/dynamodb');
const { v4: uuidv4 } = require('uuid');

// 학생 노트 테이블 이름
const STUDENT_NOTES_TABLE = 'LMS_StudentNotes';

// 학생 노트 테이블 키 구조
// id: 파티션 키 (노트 ID)
// student_id: 정렬 키 (학생 ID)

/**
 * @api {get} /api/v1/admin/enrollments/course/:courseId 특정 과목의 모든 수강생 조회
 * @apiDescription 관리자가 특정 과목의 모든 수강생 목록을 조회합니다.
 * @apiName GetCourseEnrollments
 * @apiGroup AdminEnrollments
 * @apiParam {String} courseId 과목 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.enrollments 수강생 목록
 * @apiSuccess {Number} data.total 총 수강생 수
 */
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
        console.error('수강생 목록 조회 중 오류 발생:', error);
        res.status(500).json({
            success: false,
            message: '수강생 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * @api {put} /api/v1/admin/enrollments/:enrollmentId/status 수강생 상태 변경
 * @apiDescription 관리자가 수강생의 상태를 변경합니다. (ACTIVE, SUSPENDED)
 * @apiName UpdateEnrollmentStatus
 * @apiGroup AdminEnrollments
 * @apiParam {String} enrollmentId 수강 ID
 * @apiParam {String} status 새로운 상태 (ACTIVE, SUSPENDED)
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object} data.enrollment 업데이트된 수강 정보
 */
router.put('/:enrollmentId/status', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    const client = await masterPool.connect();
    
    try {
        const { enrollmentId } = req.params;
        const { status } = req.body;

        // 상태값 검증
        if (!status || !['ACTIVE', 'DROPPED'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: '유효한 상태값이 아닙니다. (ACTIVE 또는 DROPPED)'
            });
        }

        await client.query('BEGIN');

        // 수강 정보 확인
        const checkQuery = `
            SELECT e.*, c.title as course_title
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            WHERE e.id = $1
        `;
        
        const checkResult = await client.query(checkQuery, [enrollmentId]);
        
        if (checkResult.rows.length === 0) {
            throw new Error('수강 정보를 찾을 수 없습니다.');
        }

        const enrollment = checkResult.rows[0];
        
        // 이미 같은 상태인 경우 확인
        if (enrollment.status === status) {
            return res.status(200).json({
                success: true,
                message: `이미 ${status === 'ACTIVE' ? '활성화' : '정지'} 상태입니다.`,
                data: {
                    enrollment
                }
            });
        }

        // 수강 상태 업데이트
        const updateQuery = `
            UPDATE ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS}
            SET 
                status = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *
        `;
        
        const updateResult = await client.query(updateQuery, [status, enrollmentId]);

        // 상태 변경 이력 기록
        // const historyQuery = `
        //     INSERT INTO ${SCHEMAS.ENROLLMENT}.enrollment_status_history
        //     (enrollment_id, previous_status, new_status, modified_by, reason)
        //     VALUES ($1, $2, $3, $4, $5)
        // `;
        
        // await client.query(historyQuery, [
        //     enrollmentId,
        //     enrollment.status,
        //     status,
        //     req.user.sub,
        //     req.body.reason || null
        // ]);

        await client.query('COMMIT');

        // 사용자 및 과목 정보 조회하여 응답에 추가
        const detailQuery = `
            SELECT 
                e.*,
                u.given_name as student_name,
                u.email as student_email,
                c.title as course_title
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u ON e.student_id = u.cognito_user_id
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            WHERE e.id = $1
        `;
        
        const detailResult = await client.query(detailQuery, [enrollmentId]);

        res.json({
            success: true,
            message: `수강 상태가 ${status === 'ACTIVE' ? '활성화' : '정지'}로 변경되었습니다.`,
            data: {
                enrollment: detailResult.rows[0]
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('수강 상태 변경 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '수강 상태 변경 중 오류가 발생했습니다.',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @api {get} /api/v1/admin/enrollments/suspended 모든 정지된 수강 목록 조회
 * @apiDescription 관리자가 모든 정지된 수강 목록을 조회합니다.
 * @apiName GetSuspendedEnrollments
 * @apiGroup AdminEnrollments
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.enrollments 정지된 수강 목록
 * @apiSuccess {Number} data.total 총 정지된 수강 수
 */
router.get('/suspended', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const pool = getPool('read');
        
        const query = `
            SELECT 
                e.*,
                u.given_name as student_name,
                u.email as student_email,
                c.title as course_title,
                c.id as course_id,
                pt.progress_status
            FROM ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.ENROLLMENTS} e
            JOIN ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS} u ON e.student_id = u.cognito_user_id
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.status = 'DROPPED'
            ORDER BY e.updated_at DESC
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: {
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('정지된 수강 목록 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '정지된 수강 목록 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * @api {get} /api/v1/admin/enrollments/student/:studentId 특정 학생의 모든 수강 정보 조회
 * @apiDescription 관리자가 특정 학생의 모든 수강 정보를 조회합니다.
 * @apiName GetStudentEnrollments
 * @apiGroup AdminEnrollments
 * @apiParam {String} studentId 학생 ID
 * @apiSuccess {Boolean} success 성공 여부
 * @apiSuccess {Object[]} data.enrollments 수강 목록
 * @apiSuccess {Number} data.total 총 수강 수
 */
router.get('/student/:studentId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
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
            JOIN ${SCHEMAS.COURSE}.${TABLES.COURSE.COURSES} c ON e.course_id = c.id
            LEFT JOIN ${SCHEMAS.ENROLLMENT}.${TABLES.ENROLLMENT.PROGRESS_TRACKING} pt
                ON e.id = pt.enrollment_id
            WHERE e.student_id = $1
            ORDER BY e.enrolled_at DESC
        `;
        
        const result = await pool.query(query, [studentId]);
        
        // 학생 정보 조회
        const userQuery = `
            SELECT given_name, email, role
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        
        const userResult = await pool.query(userQuery, [studentId]);
        
        res.json({
            success: true,
            data: {
                student: userResult.rows[0] || null,
                enrollments: result.rows,
                total: result.rowCount
            }
        });
    } catch (error) {
        console.error('학생 수강 정보 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 수강 정보 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 학생 노트 조회 API
 * 특정 학생에 대한 모든 관리자 노트를 조회합니다.
 */
router.get('/students/:studentId/notes', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
        
        // studentId가 유효한지 확인 (옵션)
        const checkStudentQuery = `
            SELECT * FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        const studentCheck = await masterPool.query(checkStudentQuery, [studentId]);
        
        if (studentCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '해당 학생을 찾을 수 없습니다.'
            });
        }
        
        // DynamoDB에서 학생 노트 조회
        const params = {
            TableName: STUDENT_NOTES_TABLE,
            FilterExpression: 'student_id = :studentId',
            ExpressionAttributeValues: {
                ':studentId': studentId
            }
        };
        
        console.log('학생 노트 조회 요청:', params);
        // query 대신 scan 사용 (student_id가 정렬 키이므로)
        const result = await dynamoDB.scan(params).promise();
        console.log('조회된 노트 수:', result.Items?.length || 0);
        
        // 관리자 정보 추가
        const adminIds = [...new Set(result.Items.map(note => note.admin_id))];
        const adminInfo = {};
        
        if (adminIds.length > 0) {
            const adminQuery = `
                SELECT cognito_user_id, given_name, email 
                FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
                WHERE cognito_user_id = ANY($1)
            `;
            
            const adminResult = await masterPool.query(adminQuery, [adminIds]);
            
            adminResult.rows.forEach(admin => {
                adminInfo[admin.cognito_user_id] = {
                    name: admin.given_name,
                    email: admin.email
                };
            });
        }
        
        // 노트에 관리자 정보 추가
        const notesWithAdminInfo = result.Items.map(note => ({
            ...note,
            admin: adminInfo[note.admin_id] || { name: '알 수 없음', email: '' }
        }));
        
        // 작성 시간 기준 내림차순 정렬
        notesWithAdminInfo.sort((a, b) => 
            new Date(b.created_at) - new Date(a.created_at)
        );
        
        res.json({
            success: true,
            data: {
                notes: notesWithAdminInfo,
                total: notesWithAdminInfo.length
            }
        });
    } catch (error) {
        console.error('학생 노트 조회 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 노트 조회 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 학생 노트 추가 API
 * 특정 학생에 대한 관리자 노트를 추가합니다.
 */
router.post('/students/:studentId/notes', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId } = req.params;
        const { content, course_id } = req.body;
        
        if (!content || content.trim() === '') {
            return res.status(400).json({
                success: false,
                message: '노트 내용을 입력해주세요.'
            });
        }
        
        // studentId가 유효한지 확인
        const checkStudentQuery = `
            SELECT * FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        const studentCheck = await masterPool.query(checkStudentQuery, [studentId]);
        
        if (studentCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '해당 학생을 찾을 수 없습니다.'
            });
        }
        
        // 현재 시간 생성
        const now = new Date().toISOString();
        
        // 노트 ID 생성
        const noteId = uuidv4();
        
        // DynamoDB에 노트 저장 - id가 파티션 키, student_id가 정렬 키
        const params = {
            TableName: STUDENT_NOTES_TABLE,
            Item: {
                id: noteId,                 // 파티션 키
                student_id: studentId,      // 정렬 키
                admin_id: req.user.sub,
                content: content.trim(),
                created_at: now,
                updated_at: now
            }
        };
        
        // course_id가 있으면 추가
        if (course_id) {
            params.Item.course_id = course_id;
        }
        
        console.log('학생 노트 생성 요청:', params);
        await dynamoDB.put(params).promise();
        
        // 관리자 정보 조회
        const adminQuery = `
            SELECT given_name, email 
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        
        const adminResult = await masterPool.query(adminQuery, [req.user.sub]);
        const admin = adminResult.rows[0] || { given_name: '', email: '' };
        
        // 생성된 노트 반환
        res.status(201).json({
            success: true,
            message: '학생 노트가 추가되었습니다.',
            data: {
                note: {
                    ...params.Item,
                    admin: {
                        name: admin.given_name,
                        email: admin.email
                    }
                }
            }
        });
    } catch (error) {
        console.error('학생 노트 추가 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 노트 추가 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 학생 노트 수정 API
 * 특정 학생의 특정 노트를 수정합니다.
 */
router.put('/students/:studentId/notes/:noteId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId, noteId } = req.params;
        const { content } = req.body;
        
        if (!content || content.trim() === '') {
            return res.status(400).json({
                success: false,
                message: '노트 내용을 입력해주세요.'
            });
        }
        
        // 노트 존재 확인
        const getParams = {
            TableName: STUDENT_NOTES_TABLE,
            Key: {
                id: noteId,
                student_id: studentId
            }
        };
        
        const existingNote = await dynamoDB.get(getParams).promise();
        
        if (!existingNote.Item) {
            return res.status(404).json({
                success: false,
                message: '해당 노트를 찾을 수 없습니다.'
            });
        }
        
        // 본인이 작성한 노트만 수정 가능 (또는 ADMIN만 수정 가능하게 설정 가능)
        if (existingNote.Item.admin_id !== req.user.sub && !req.user.groups.includes('SUPER_ADMIN')) {
            return res.status(403).json({
                success: false,
                message: '다른 관리자가 작성한 노트는 수정할 수 없습니다.'
            });
        }
        
        // 노트 업데이트
        const updateParams = {
            TableName: STUDENT_NOTES_TABLE,
            Key: {
                id: noteId,
                student_id: studentId
            },
            UpdateExpression: 'SET content = :content, updated_at = :updated_at',
            ExpressionAttributeValues: {
                ':content': content.trim(),
                ':updated_at': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };
        
        console.log('학생 노트 수정 요청:', updateParams);
        const result = await dynamoDB.update(updateParams).promise();
        
        // 관리자 정보 조회
        const adminQuery = `
            SELECT given_name, email 
            FROM ${SCHEMAS.AUTH}.${TABLES.AUTH.USERS}
            WHERE cognito_user_id = $1
        `;
        
        const adminResult = await masterPool.query(adminQuery, [result.Attributes.admin_id]);
        const admin = adminResult.rows[0] || { given_name: '', email: '' };
        
        res.json({
            success: true,
            message: '학생 노트가 수정되었습니다.',
            data: {
                note: {
                    ...result.Attributes,
                    admin: {
                        name: admin.given_name,
                        email: admin.email
                    }
                }
            }
        });
    } catch (error) {
        console.error('학생 노트 수정 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 노트 수정 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

/**
 * 학생 노트 삭제 API
 * 특정 학생의 특정 노트를 삭제합니다.
 */
router.delete('/students/:studentId/notes/:noteId', verifyToken, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { studentId, noteId } = req.params;
        
        // 노트 존재 확인
        const getParams = {
            TableName: STUDENT_NOTES_TABLE,
            Key: {
                id: noteId,
                student_id: studentId
            }
        };
        
        const existingNote = await dynamoDB.get(getParams).promise();
        
        if (!existingNote.Item) {
            return res.status(404).json({
                success: false,
                message: '해당 노트를 찾을 수 없습니다.'
            });
        }
        
        // 본인이 작성한 노트만 삭제 가능 (또는 ADMIN만 삭제 가능하게 설정 가능)
        if (existingNote.Item.admin_id !== req.user.sub && !req.user.groups.includes('SUPER_ADMIN')) {
            return res.status(403).json({
                success: false,
                message: '다른 관리자가 작성한 노트는 삭제할 수 없습니다.'
            });
        }
        
        // 노트 삭제
        const deleteParams = {
            TableName: STUDENT_NOTES_TABLE,
            Key: {
                id: noteId,
                student_id: studentId
            }
        };
        
        console.log('학생 노트 삭제 요청:', deleteParams);
        await dynamoDB.delete(deleteParams).promise();
        
        res.json({
            success: true,
            message: '학생 노트가 삭제되었습니다.'
        });
    } catch (error) {
        console.error('학생 노트 삭제 중 오류:', error);
        res.status(500).json({
            success: false,
            message: '학생 노트 삭제 중 오류가 발생했습니다.',
            error: error.message
        });
    }
});

module.exports = router; 