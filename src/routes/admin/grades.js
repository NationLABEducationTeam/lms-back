const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { validateGradeItem, validateAttendance, validateGradeRules } = require('../../middlewares/validation');
const { v4: uuidv4 } = require('uuid');

// 평가 항목 추가 (과제 또는 시험)
router.post('/items', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        const { courseId, type, title, maxScore = 100, weight } = req.body;

        // 평가 항목 유효성 검사
        if (!['ASSIGNMENT', 'EXAM'].includes(type)) {
            throw new Error('평가 항목 유형은 ASSIGNMENT 또는 EXAM이어야 합니다.');
        }

        // 해당 과목의 현재 평가 항목들의 총 가중치 확인
        const weightQuery = `
            SELECT 
                c.${type.toLowerCase()}_weight as total_category_weight,
                COALESCE(SUM(gi.weight), 0) as current_items_weight
            FROM ${SCHEMAS.COURSE}.courses c
            LEFT JOIN ${SCHEMAS.GRADE}.grade_items gi updateFileDownloadPermission
                ON c.id = gi.course_id 
                AND gi.type = $1
            WHERE c.id = $2
            GROUP BY c.id, c.${type.toLowerCase()}_weight
        `;
        
        const weightResult = await client.query(weightQuery, [type, courseId]);
        
        if (weightResult.rows.length === 0) {
            throw new Error('과목을 찾을 수 없습니다.');
        }

        const { total_category_weight, current_items_weight } = weightResult.rows[0];
        
        if (current_items_weight + weight > total_category_weight) {
            throw new Error(`${type} 유형의 총 가중치(${total_category_weight}%)를 초과할 수 없습니다.`);
        }

        // 새 평가 항목 추가
        const insertResult = await client.query(
            `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
            (course_id, type, title, max_score, weight)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
            [courseId, type, title, maxScore, weight]
        );

        // 수강 중인 모든 학생들의 점수 초기화
        await client.query(
            `INSERT INTO ${SCHEMAS.GRADE}.student_grades 
            (student_id, course_id, grade_item_id, score)
            SELECT 
                e.student_id,
                e.course_id,
                $1,
                0  // 여기서 모든 학생의 점수를 0으로 초기화
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            WHERE e.course_id = $2 AND e.status = 'ACTIVE'`,
            [insertResult.rows[0].id, courseId]
        );

        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: "평가 항목이 추가되었습니다.",
            data: insertResult.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding grade item:', error);
        res.status(500).json({
            success: false,
            message: "평가 항목 추가 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 특정 평가 항목 조회
router.get('/items/detail/:itemId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { itemId } = req.params;

        const result = await client.query(
            `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
            WHERE id = $1`,
            [itemId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "평가 항목을 찾을 수 없습니다."
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching grade item:', error);
        res.status(500).json({
            success: false,
            message: "평가 항목 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 특정 평가 항목 조회 (ID로 직접 접근)
router.get('/items/:itemId', verifyToken, async (req, res, next) => {
    // UUID 형식인 경우에도 항목 ID가 아닌 course_id로 처리
    const { itemId } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (uuidRegex.test(itemId)) {
        // 강의 상세 페이지에서 자동으로 호출되는 경우 빈 배열 반환
        // 실제 필요한 경우에만 명시적으로 호출하도록 프론트엔드 수정 필요
        const referer = req.headers.referer || '';
        if (referer.includes('/admin/courses/')) {
            console.log(`자동 호출 감지 (GET): ${referer} -> 빈 배열 반환`);
            return res.json({
                success: true,
                data: []
            });
        }
        
        const client = await masterPool.connect();
        try {
            // course_id로 조회하도록 수정
            const result = await client.query(
                `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
                WHERE course_id = $1
                ORDER BY created_at ASC`,
                [itemId]
            );

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('Error fetching grade items:', error);
            res.status(500).json({
                success: false,
                message: "평가 항목 조회 중 오류가 발생했습니다.",
                error: error.message
            });
        } finally {
            client.release();
        }
    } else {
        // UUID 형식이 아닌 경우 다음 라우터로 넘김
        next();
    }
});

// POST 메서드로도 동일한 기능 지원 (UUID를 course_id로 처리)
router.post('/items/:itemId', verifyToken, async (req, res, next) => {
    // UUID 형식인 경우에도 항목 ID가 아닌 course_id로 처리
    const { itemId } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (uuidRegex.test(itemId)) {
        // 강의 상세 페이지에서 자동으로 호출되는 경우 빈 배열 반환
        // 실제 필요한 경우에만 명시적으로 호출하도록 프론트엔드 수정 필요
        const referer = req.headers.referer || '';
        if (referer.includes('/admin/courses/')) {
            console.log(`자동 호출 감지 (POST): ${referer} -> 빈 배열 반환`);
            return res.json({
                success: true,
                data: []
            });
        }
        
        const client = await masterPool.connect();
        try {
            // course_id로 조회하도록 수정
            const result = await client.query(
                `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
                WHERE course_id = $1
                ORDER BY created_at ASC`,
                [itemId]
            );

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('Error fetching grade items:', error);
            res.status(500).json({
                success: false,
                message: "평가 항목 조회 중 오류가 발생했습니다.",
                error: error.message
            });
        } finally {
            client.release();
        }
    } else {
        // UUID 형식이 아닌 경우 다음 라우터로 넘김
        next();
    }
});

// 평가 항목 수정
router.put('/items/:itemId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        const { itemId } = req.params;
        const { title, maxScore, weight, type } = req.body;

        // type 필드 확인
        if (!type || !['ASSIGNMENT', 'EXAM'].includes(type)) {
            return res.status(400).json({
                success: false,
                message: "평가 항목 유형(type)은 ASSIGNMENT 또는 EXAM이어야 합니다."
            });
        }

        // 평가 항목 존재 확인
        const itemCheckResult = await client.query(
            `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
            WHERE id = $1`,
            [itemId]
        );

        if (itemCheckResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "평가 항목을 찾을 수 없습니다."
            });
        }

        const gradeItem = itemCheckResult.rows[0];
        const courseId = gradeItem.course_id;

        // 과목 정보 조회
        const courseResult = await client.query(
            `SELECT * FROM ${SCHEMAS.COURSE}.courses
            WHERE id = $1`,
            [courseId]
        );

        if (courseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과목 정보를 찾을 수 없습니다."
            });
        }

        const course = courseResult.rows[0];
        const total_category_weight = type.toLowerCase() === 'assignment' 
            ? course.assignment_weight 
            : course.exam_weight;

        // 해당 과목의 현재 평가 항목들의 총 가중치 확인 (수정하려는 항목 제외)
        const weightQuery = `
            SELECT 
                COALESCE(SUM(weight), 0) as current_items_weight
            FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1 
            AND type = $2
            AND id != $3
        `;
        
        const weightResult = await client.query(weightQuery, [courseId, type, itemId]);
        const { current_items_weight } = weightResult.rows[0];
        
        if (current_items_weight + weight > total_category_weight) {
            throw new Error(`${type} 유형의 총 가중치(${total_category_weight}%)를 초과할 수 없습니다.`);
        }

        // 평가 항목 업데이트
        const updateResult = await client.query(
            `UPDATE ${SCHEMAS.GRADE}.grade_items
            SET 
                title = $1,
                max_score = $2,
                weight = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
            RETURNING *`,
            [title, maxScore, weight, itemId]
        );

        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: "평가 항목이 수정되었습니다.",
            data: updateResult.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating grade item:', error);
        res.status(500).json({
            success: false,
            message: "평가 항목 수정 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 평가 항목 삭제
router.delete('/items/:itemId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        const { itemId } = req.params;

        // 평가 항목 존재 확인
        const checkResult = await client.query(
            `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
            WHERE id = $1`,
            [itemId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "평가 항목을 찾을 수 없습니다."
            });
        }

        // 관련 학생 점수 삭제
        await client.query(
            `DELETE FROM ${SCHEMAS.GRADE}.student_grades
            WHERE grade_item_id = $1`,
            [itemId]
        );

        // 평가 항목 삭제
        await client.query(
            `DELETE FROM ${SCHEMAS.GRADE}.grade_items
            WHERE id = $1`,
            [itemId]
        );

        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: "평가 항목이 삭제되었습니다."
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting grade item:', error);
        res.status(500).json({
            success: false,
            message: "평가 항목 삭제 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 평가 항목 목록 조회
router.get('/items/:courseId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;

        const result = await client.query(
            `SELECT * FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1
            ORDER BY created_at ASC`,
            [courseId]
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching grade items:', error);
        res.status(500).json({
            success: false,
            message: "평가 항목 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 학생 점수 입력/수정
router.put('/scores', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');

        const { gradeItemId, scores } = req.body;
        // scores 형식: [{ studentId: 'xxx', score: 85 }, ...]

        // 평가 항목 존재 확인 및 정보 조회
        const gradeItemResult = await client.query(
            `SELECT gi.*, c.${type.toLowerCase()}_weight as category_weight
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            WHERE gi.id = $1`,
            [gradeItemId]
        );

        if (gradeItemResult.rows.length === 0) {
            throw new Error('평가 항목을 찾을 수 없습니다.');
        }

        const gradeItem = gradeItemResult.rows[0];

        // 점수 유효성 검사 및 업데이트
        for (const { studentId, score } of scores) {
            if (score < 0 || score > gradeItem.max_score) {
                throw new Error(`학생 ${studentId}의 점수가 유효하지 않습니다. (0-${gradeItem.max_score})`);
            }

            // 점수 업데이트
            await client.query(
                `UPDATE ${SCHEMAS.GRADE}.student_grades
                SET 
                    score = $1, 
                    updated_at = CURRENT_TIMESTAMP
                WHERE grade_item_id = $2 AND student_id = $3`,
                [score, gradeItemId, studentId]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: "점수가 업데이트되었습니다."
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating scores:', error);
        res.status(500).json({
            success: false,
            message: "점수 업데이트 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 학생의 과목별 성적 조회
router.get('/course/:courseId/student/:studentId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId, studentId } = req.params;

        // 권한 확인 (본인 또는 관리자/교수자만 조회 가능)
        if (req.user.sub !== studentId && !['ADMIN', 'INSTRUCTOR'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: "성적 조회 권한이 없습니다."
            });
        }

        // 성적 정보 조회
        const result = await client.query(
            `WITH grade_summary AS (
                SELECT 
                    gi.type,
                    gi.weight,
                    gi.max_score,
                    sg.score,
                    CASE 
                        WHEN gi.max_score > 0 THEN 
                            (sg.score::float / gi.max_score) * gi.weight
                        ELSE 0 
                    END as weighted_score
                FROM ${SCHEMAS.GRADE}.grade_items gi
                LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                    ON gi.id = sg.grade_item_id 
                    AND sg.student_id = $1
                WHERE gi.course_id = $2
            )
            SELECT 
                c.title as course_title,
                c.attendance_weight,
                c.assignment_weight,
                c.exam_weight,
                json_build_object(
                    'ASSIGNMENT', (
                        SELECT json_agg(row_to_json(gs))
                        FROM grade_summary gs
                        WHERE gs.type = 'ASSIGNMENT'
                    ),
                    'EXAM', (
                        SELECT json_agg(row_to_json(gs))
                        FROM grade_summary gs
                        WHERE gs.type = 'EXAM'
                    )
                ) as grade_items,
                COALESCE(
                    SUM(CASE WHEN type = 'ASSIGNMENT' THEN weighted_score ELSE 0 END),
                    0
                ) as total_assignment_score,
                COALESCE(
                    SUM(CASE WHEN type = 'EXAM' THEN weighted_score ELSE 0 END),
                    0
                ) as total_exam_score
            FROM ${SCHEMAS.COURSE}.courses c
            LEFT JOIN grade_summary gs ON true
            WHERE c.id = $2
            GROUP BY 
                c.id, 
                c.title,
                c.attendance_weight,
                c.assignment_weight,
                c.exam_weight`,
            [studentId, courseId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과목 정보를 찾을 수 없습니다."
            });
        }

        const gradeInfo = result.rows[0];

        res.json({
            success: true,
            data: {
                courseTitle: gradeInfo.course_title,
                weights: {
                    attendance: gradeInfo.attendance_weight,
                    assignment: gradeInfo.assignment_weight,
                    exam: gradeInfo.exam_weight
                },
                scores: {
                    assignments: gradeInfo.grade_items.ASSIGNMENT || [],
                    exams: gradeInfo.grade_items.EXAM || [],
                    totalAssignment: gradeInfo.total_assignment_score,
                    totalExam: gradeInfo.total_exam_score
                }
            }
        });
    } catch (error) {
        console.error('Error fetching grades:', error);
        res.status(500).json({
            success: false,
            message: "성적 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 수업 참여 기록
router.post('/attendance', verifyToken, validateAttendance, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { studentId, courseId, sessionType, sessionId, durationSeconds, totalDurationSeconds, attendanceDate } = req.body;

        // 기존 참여 기록 확인
        const existingRecord = await client.query(
            `SELECT * FROM grade_schema.attendance_records
            WHERE student_id = $1 AND course_id = $2 AND session_id = $3`,
            [studentId, courseId, sessionId]
        );

        let result;
        if (existingRecord.rows.length > 0) {
            // 기존 기록 업데이트
            result = await client.query(
                `UPDATE grade_schema.attendance_records
                SET duration_seconds = LEAST($4, $5),
                    updated_at = CURRENT_TIMESTAMP
                WHERE student_id = $1 AND course_id = $2 AND session_id = $3
                RETURNING *`,
                [studentId, courseId, sessionId, durationSeconds, totalDurationSeconds]
            );
        } else {
            // 새 기록 생성
            result = await client.query(
                `INSERT INTO grade_schema.attendance_records
                (student_id, course_id, session_type, session_id, duration_seconds, total_duration_seconds, attendance_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [studentId, courseId, sessionType, sessionId, durationSeconds, totalDurationSeconds, attendanceDate]
            );
        }

        // 출석률 계산 및 최종 성적 업데이트
        await updateFinalGrades(client, courseId, studentId);

        res.json({
            success: true,
            message: "수업 참여가 기록되었습니다.",
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error recording attendance:', error);
        res.status(500).json({
            success: false,
            message: "수업 참여 기록 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 성적 산출 규칙 설정
router.post('/rules', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), validateGradeRules, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId, attendance_weight, assignment_weight, exam_weight, min_attendance_weight } = req.body;

        // 가중치 합계 확인
        const totalWeight = attendance_weight + assignment_weight + exam_weight;
        if (totalWeight !== 100) {
            return res.status(400).json({
                success: false,
                message: "가중치의 합이 100이 되어야 합니다."
            });
        }

        const result = await client.query(
            `INSERT INTO grade_schema.course_grade_rules
            (course_id, attendance_weight, assignment_weight, exam_weight, min_attendance_rate)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (course_id)
            DO UPDATE SET
                attendance_weight = EXCLUDED.attendance_weight,
                assignment_weight = EXCLUDED.assignment_weight,
                exam_weight = EXCLUDED.exam_weight,
                min_attendance_rate = EXCLUDED.min_attendance_rate,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *`,
            [courseId, attendance_weight, assignment_weight, exam_weight, min_attendance_weight]
        );

        res.json({
            success: true,
            message: "성적 산출 규칙이 설정되었습니다.",
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error setting grade rules:', error);
        res.status(500).json({
            success: false,
            message: "성적 산출 규칙 설정 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 최종 성적 조회
router.get('/final/:courseId/:studentId', verifyToken, async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId, studentId } = req.params;

        // 권한 확인
        if (req.user.role !== 'ADMIN' && req.user.role !== 'INSTRUCTOR' && req.user.id !== studentId) {
            return res.status(403).json({
                success: false,
                message: "성적 조회 권한이 없습니다."
            });
        }

        const result = await client.query(
            `SELECT 
                fg.*,
                u.name as student_name,
                c.title as course_title,
                cgr.attendance_weight,
                cgr.assignment_weight,
                cgr.exam_weight,
                cgr.min_attendance_rate
            FROM grade_schema.final_grades fg
            JOIN auth_schema.users u ON fg.student_id = u.id
            JOIN course_schema.courses c ON fg.course_id = c.id
            JOIN grade_schema.course_grade_rules cgr ON fg.course_id = cgr.course_id
            WHERE fg.course_id = $1 AND fg.student_id = $2`,
            [courseId, studentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "성적 정보를 찾을 수 없습니다."
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching final grades:', error);
        res.status(500).json({
            success: false,
            message: "성적 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 헬퍼 함수: 최종 성적 업데이트
async function updateFinalGrades(client, courseId, studentId) {
    // 출석률 계산
    const attendanceResult = await client.query(
        `SELECT 
            COALESCE(SUM(duration_seconds), 0) as total_attended,
            NULLIF(SUM(total_duration_seconds), 0) as total_required
        FROM grade_schema.attendance_records
        WHERE course_id = $1 AND student_id = $2`,
        [courseId, studentId]
    );

    const { total_attended, total_required } = attendanceResult.rows[0];
    const attendanceRate = total_required ? (total_attended / total_required) * 100 : 0;

    // 과제 점수 계산 (수정된 부분)
    const assignmentResult = await client.query(
        `WITH assignment_weights AS (
            SELECT SUM(weight) as total_weight
            FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1 AND type = 'ASSIGNMENT'
        )
        SELECT 
            COALESCE(
                SUM(
                    (sg.score::float / NULLIF(gi.max_score, 0)) * 
                    (gi.weight::float / NULLIF(aw.total_weight, 0))
                ) * 100,
                0
            ) as weighted_assignment_score
        FROM ${SCHEMAS.GRADE}.grade_items gi
        LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
            ON gi.id = sg.grade_item_id 
            AND sg.student_id = $2
        CROSS JOIN assignment_weights aw
        WHERE gi.course_id = $1 
        AND gi.type = 'ASSIGNMENT'`,
        [courseId, studentId]
    );

    // 시험 점수 계산 (동일한 방식으로 수정)
    const examResult = await client.query(
        `WITH exam_weights AS (
            SELECT SUM(weight) as total_weight
            FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1 AND type = 'EXAM'
        )
        SELECT 
            COALESCE(
                SUM(
                    (sg.score::float / NULLIF(gi.max_score, 0)) * 
                    (gi.weight::float / NULLIF(ew.total_weight, 0))
                ) * 100,
                0
            ) as weighted_exam_score
        FROM ${SCHEMAS.GRADE}.grade_items gi
        LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
            ON gi.id = sg.grade_item_id 
            AND sg.student_id = $2
        CROSS JOIN exam_weights ew
        WHERE gi.course_id = $1 
        AND gi.type = 'EXAM'`,
        [courseId, studentId]
    );

    // 규칙 조회
    const rulesResult = await client.query(
        `SELECT * FROM ${SCHEMAS.GRADE}.course_grade_rules
        WHERE course_id = $1`,
        [courseId]
    );

    const rules = rulesResult.rows[0];
    const assignmentScore = assignmentResult.rows[0].weighted_assignment_score || 0;
    const examScore = examResult.rows[0].weighted_exam_score || 0;

    // 최종 성적 계산 및 업데이트
    const totalScore = (
        (attendanceRate * rules.attendance_weight / 100) +
        (assignmentScore * rules.assignment_weight / 100) +
        (examScore * rules.exam_weight / 100)
    );

    await client.query(
        `INSERT INTO ${SCHEMAS.GRADE}.final_grades
        (student_id, course_id, attendance_score, assignment_score, exam_score, total_score, attendance_rate)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (student_id, course_id)
        DO UPDATE SET
            attendance_score = EXCLUDED.attendance_score,
            assignment_score = EXCLUDED.assignment_score,
            exam_score = EXCLUDED.exam_score,
            total_score = EXCLUDED.total_score,
            attendance_rate = EXCLUDED.attendance_rate,
            updated_at = CURRENT_TIMESTAMP`,
        [studentId, courseId, attendanceRate, assignmentScore, examScore, totalScore, attendanceRate]
    );
}

module.exports = router;
