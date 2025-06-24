const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../../middlewares/auth');
const { masterPool, SCHEMAS } = require('../../config/database');
const { validateGradeItem, validateAttendance, validateGradeRules } = require('../../middlewares/validation');
const { v4: uuidv4 } = require('uuid');
const { generateUploadUrls, listAssignmentFiles } = require('../../utils/s3');
const { 
    updateFinalGrades, 
    recordGradeHistory,
    getGradeStatistics,
    exportGradeData
} = require('../../utils/grade-calculator');

// 평가 항목 추가 (과제 또는 시험)
router.post('/items', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        await client.query('BEGIN');
        const { courseId, type, title, due_date, files } = req.body;

        // 평가 항목 유효성 검사
        if (!['ASSIGNMENT', 'EXAM'].includes(type)) {
            throw new Error('평가 항목 유형은 ASSIGNMENT 또는 EXAM이어야 합니다.');
        }

        // 과목 존재 여부 및 설정 확인
        const courseQuery = `
            SELECT id, assignment_count, exam_count 
            FROM ${SCHEMAS.COURSE}.courses
            WHERE id = $1
        `;
        
        const courseResult = await client.query(courseQuery, [courseId]);
        
        if (courseResult.rows.length === 0) {
            throw new Error('과목을 찾을 수 없습니다.');
        }

        // 현재 등록된 항목 수 확인
        const currentCount = await client.query(
            `SELECT COUNT(*) as count FROM ${SCHEMAS.GRADE}.grade_items 
             WHERE course_id = $1 AND item_type = $2`,
            [courseId, type]
        );
        
        // 유형별 제한 확인
        const limit = type === 'ASSIGNMENT' 
            ? courseResult.rows[0].assignment_count 
            : courseResult.rows[0].exam_count;
            
        if (currentCount.rows[0].count >= limit) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `${type === 'ASSIGNMENT' ? '과제' : '시험'} 항목은 최대 ${limit}개까지 등록 가능합니다.`
            });
        }

        // 현재 항목 순서 조회 (서브쿼리를 분리하여 매개변수 타입 불일치 문제 해결)
        const orderResult = await client.query(
            `SELECT COALESCE(MAX(item_order), 0) + 1 as next_order 
             FROM ${SCHEMAS.GRADE}.grade_items 
             WHERE course_id = $1 AND item_type = $2`,
            [courseId, type]
        );
        
        const nextOrder = orderResult.rows[0].next_order;

        // 새 평가 항목 추가 (트리거가 자동으로 학생 기록 생성)
        const insertResult = await client.query(
            `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
            (course_id, item_type, item_name, item_order, due_date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
            [courseId, type, title, nextOrder, due_date]
        );

        const itemId = insertResult.rows[0].item_id;

        // 학생 수 확인을 위한 로그
        const studentCount = await client.query(
            `SELECT COUNT(*) FROM ${SCHEMAS.GRADE}.student_grades WHERE item_id = $1`,
            [itemId]
        );
        
        console.log(`평가 항목 ${itemId} 생성 완료, 학생 레코드 ${studentCount.rows[0].count}개 자동 생성됨`);

        await client.query('COMMIT');
        
        // 파일 업로드를 위한 presigned URL 생성
        let presignedUrls = [];
        if (files && files.length > 0) {
            try {
                // 과제/퀴즈 파일은 'assignments/{itemId}/' 경로에 저장
                const folderPrefix = `assignments/${itemId}`;
                
                // 파일 정보에 폴더 경로 추가
                const filesWithPrefix = files.map(file => ({
                    ...file,
                    prefix: folderPrefix
                }));
                
                // presigned URL 생성
                presignedUrls = await generateUploadUrls(courseId, 'assignments', filesWithPrefix);
                
                console.log('Generated presigned URLs for assignment files:', {
                    itemId,
                    urlCount: presignedUrls.length
                });
            } catch (uploadError) {
                console.error('Error generating upload URLs for assignment files:', uploadError);
                // URL 생성 실패해도 평가 항목 생성은 성공으로 처리
            }
        }
        
        res.json({
            success: true,
            message: "평가 항목이 추가되었습니다.",
            data: {
                ...insertResult.rows[0],
                uploadUrls: presignedUrls
            }
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
            WHERE item_id = $1`,
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
                ORDER BY item_order ASC`,
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
        // 요청 본문에 데이터가 있는 경우 새 항목 추가로 처리
        if (req.body && Object.keys(req.body).length > 0) {
            const { title, type, deadline } = req.body;
            
            if (title && type) {
                const client = await masterPool.connect();
                try {
                    await client.query('BEGIN');
                    
                    // 과목 존재 여부 확인
                    const courseQuery = `
                        SELECT id FROM ${SCHEMAS.COURSE}.courses
                        WHERE id = $1
                    `;
                    
                    const courseResult = await client.query(courseQuery, [itemId]);
                    
                    if (courseResult.rows.length === 0) {
                        return res.status(404).json({
                            success: false,
                            message: "과목을 찾을 수 없습니다."
                        });
                    }
                    
                    // 새 평가 항목 추가
                    const insertResult = await client.query(
                        `INSERT INTO ${SCHEMAS.GRADE}.grade_items 
                        (course_id, item_type, item_name, item_order, due_date)
                        VALUES ($1, $2, $3, (SELECT COALESCE(MAX(item_order), 0) + 1 FROM ${SCHEMAS.GRADE}.grade_items WHERE course_id = $1), $4)
                        RETURNING *`,
                        [itemId, type, title, deadline]
                    );
                    
                    // 수강 중인 모든 학생들의 점수 초기화
                    await client.query(
                        `INSERT INTO ${SCHEMAS.GRADE}.student_grades 
                        (enrollment_id, item_id, score, is_completed, submission_date)
                        SELECT 
                            e.id,
                            $1,
                            0,
                            false,
                            NULL
                        FROM ${SCHEMAS.ENROLLMENT}.enrollments e
                        WHERE e.course_id = $2 AND e.status = 'ACTIVE'`,
                        [insertResult.rows[0].item_id, itemId]
                    );
                    
                    await client.query('COMMIT');
                    
                    return res.json({
                        success: true,
                        message: "평가 항목이 추가되었습니다.",
                        data: insertResult.rows[0]
                    });
                } catch (error) {
                    await client.query('ROLLBACK');
                    console.error('Error adding grade item:', error);
                    return res.status(500).json({
                        success: false,
                        message: "평가 항목 추가 중 오류가 발생했습니다.",
                        error: error.message
                    });
                } finally {
                    client.release();
                }
            }
        }
        
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
                ORDER BY item_order ASC`,
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
        const { title, due_date, type } = req.body;

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
            WHERE item_id = $1`,
            [itemId]
        );

        if (itemCheckResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "평가 항목을 찾을 수 없습니다."
            });
        }

        // 평가 항목 업데이트
        const updateResult = await client.query(
            `UPDATE ${SCHEMAS.GRADE}.grade_items
            SET 
                item_name = $1,
                item_type = $2,
                due_date = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE item_id = $4
            RETURNING *`,
            [title, type, due_date, itemId]
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
            WHERE item_id = $1`,
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
            WHERE item_id = $1`,
            [itemId]
        );

        // 평가 항목 삭제
        await client.query(
            `DELETE FROM ${SCHEMAS.GRADE}.grade_items
            WHERE item_id = $1`,
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
            ORDER BY item_order ASC`,
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

        const { gradeItemId, scores, reason } = req.body;
        // scores 형식: [{ enrollmentId: 'xxx', score: 85 }, ...]
        const modifiedBy = req.user.id;

        // 평가 항목 존재 확인 및 정보 조회
        const gradeItemResult = await client.query(
            `SELECT gi.*, c.id as course_id
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
            WHERE gi.item_id = $1`,
            [gradeItemId]
        );

        if (gradeItemResult.rows.length === 0) {
            throw new Error('평가 항목을 찾을 수 없습니다.');
        }

        const courseId = gradeItemResult.rows[0].course_id;
        const updatedStudents = [];

        // 점수 유효성 검사 및 업데이트
        for (const { enrollmentId, score } of scores) {
            if (score < 0 || score > 100) {
                throw new Error(`학생 ${enrollmentId}의 점수가 유효하지 않습니다. (0-100)`);
            }

            // 기존 점수 조회
            const currentScoreResult = await client.query(
                `SELECT grade_id, score, e.student_id
                FROM ${SCHEMAS.GRADE}.student_grades sg
                JOIN ${SCHEMAS.ENROLLMENT}.enrollments e ON sg.enrollment_id = e.id
                WHERE sg.item_id = $1 AND sg.enrollment_id = $2`,
                [gradeItemId, enrollmentId]
            );

            if (currentScoreResult.rows.length === 0) {
                throw new Error(`학생 등록 정보를 찾을 수 없습니다.`);
            }

            const { grade_id, score: previousScore, student_id } = currentScoreResult.rows[0];

            // 점수가 변경된 경우에만 업데이트 및 히스토리 기록
            if (previousScore !== score) {
                // 점수 업데이트
                await client.query(
                    `UPDATE ${SCHEMAS.GRADE}.student_grades
                    SET 
                        score = $1, 
                        updated_at = CURRENT_TIMESTAMP
                    WHERE grade_id = $2`,
                    [score, grade_id]
                );

                // 히스토리 기록
                await recordGradeHistory(
                    client,
                    grade_id,
                    previousScore,
                    score,
                    modifiedBy,
                    reason || '관리자에 의한 점수 수정'
                );

                updatedStudents.push(student_id);
            }
        }

        // 성적이 변경된 학생들의 최종 성적 업데이트
        for (const studentId of updatedStudents) {
            await updateFinalGrades(client, courseId, studentId);
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: "점수가 업데이트되었습니다.",
            updated_count: updatedStudents.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating scores:', error);
        res.status(500).json({
            success: false,
            message: "점수 업데이트 중 오류가 발 생 했습니다",
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

        // 수강 정보 조회
        const enrollmentResult = await client.query(
            `SELECT id FROM ${SCHEMAS.ENROLLMENT}.enrollments
            WHERE course_id = $1 AND student_id = $2`,
            [courseId, studentId]
        );

        if (enrollmentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "수강 정보를 찾을 수 없습니다."
            });
        }

        const enrollmentId = enrollmentResult.rows[0].id;

        // 성적 정보 조회
        const result = await client.query(
            `WITH grade_summary AS (
                SELECT 
                    gi.item_type,
                    gi.item_name,
                    gi.due_date,
                    sg.score,
                    sg.is_completed
                FROM ${SCHEMAS.GRADE}.grade_items gi
                LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                    ON gi.item_id = sg.item_id 
                    AND sg.enrollment_id = $1
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
                        WHERE gs.item_type = 'ASSIGNMENT'
                    ),
                    'EXAM', (
                        SELECT json_agg(row_to_json(gs))
                        FROM grade_summary gs
                        WHERE gs.item_type = 'EXAM'
                    )
                ) as grade_items,
                COALESCE(
                    AVG(CASE WHEN item_type = 'ASSIGNMENT' THEN score ELSE NULL END),
                    0
                ) as total_assignment_score,
                COALESCE(
                    AVG(CASE WHEN item_type = 'EXAM' THEN score ELSE NULL END),
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
            [enrollmentId, courseId]
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
        await client.query('BEGIN');
        
        const { studentId, courseId, sessionType, sessionId, durationSeconds, totalDurationSeconds, attendanceDate } = req.body;

        // 기존 참여 기록 확인
        const existingRecord = await client.query(
            `SELECT * FROM ${SCHEMAS.GRADE}.attendance_records
            WHERE student_id = $1 AND course_id = $2 AND session_id = $3`,
            [studentId, courseId, sessionId]
        );

        let result;
        if (existingRecord.rows.length > 0) {
            // 기존 기록 업데이트
            result = await client.query(
                `UPDATE ${SCHEMAS.GRADE}.attendance_records
                SET duration_seconds = LEAST($4, $5),
                    updated_at = CURRENT_TIMESTAMP
                WHERE student_id = $1 AND course_id = $2 AND session_id = $3
                RETURNING *`,
                [studentId, courseId, sessionId, durationSeconds, totalDurationSeconds]
            );
        } else {
            // 새 기록 생성
            result = await client.query(
                `INSERT INTO ${SCHEMAS.GRADE}.attendance_records
                (student_id, course_id, session_type, session_id, duration_seconds, total_duration_seconds, attendance_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [studentId, courseId, sessionType, sessionId, durationSeconds, totalDurationSeconds, attendanceDate]
            );
        }

        // 출석률 계산 및 최종 성적 업데이트 - 최적화된 함수 사용
        await updateFinalGrades(client, courseId, studentId);
        
        await client.query('COMMIT');

        res.json({
            success: true,
            message: "수업 참여가 기록되었습니다.",
            data: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
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
                u.given_name as student_name,
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

// 성적 통계 조회 API 추가
router.get('/statistics/:courseId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;
        
        const statistics = await getGradeStatistics(client, courseId);
        
        if (!statistics) {
            return res.status(404).json({
                success: false,
                message: "과목 정보를 찾을 수 없습니다."
            });
        }
        
        res.json({
            success: true,
            data: statistics
        });
    } catch (error) {
        console.error('Error fetching grade statistics:', error);
        res.status(500).json({
            success: false,
            message: "성적 통계 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 성적 엑셀 내보내기 API 추가
router.get('/export/:courseId', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    const client = await masterPool.connect();
    try {
        const { courseId } = req.params;
        
        // 과목 존재 여부 확인
        const courseCheck = await client.query(
            `SELECT title FROM ${SCHEMAS.COURSE}.courses WHERE id = $1`,
            [courseId]
        );
        
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "과목을 찾을 수 없습니다."
            });
        }
        
        const courseTitle = courseCheck.rows[0].title;
        const gradeData = await exportGradeData(client, courseId);
        
        res.json({
            success: true,
            data: {
                courseTitle,
                students: gradeData
            }
        });
    } catch (error) {
        console.error('Error exporting grades:', error);
        res.status(500).json({
            success: false,
            message: "성적 내보내기 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 평가 항목 파일 목록 조회
router.get('/items/:itemId/files', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR', 'STUDENT']), async (req, res) => {
    try {
        const { itemId } = req.params;
        
        // 평가 항목 존재 여부 확인
        const client = await masterPool.connect();
        try {
            const itemQuery = `
                SELECT * FROM ${SCHEMAS.GRADE}.grade_items
                WHERE item_id = $1
            `;
            
            const itemResult = await client.query(itemQuery, [itemId]);
            
            if (itemResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "평가 항목을 찾을 수 없습니다."
                });
            }
            
            // 학생인 경우 해당 과목을 수강 중인지 확인
            if (req.user.role === 'STUDENT') {
                const enrollmentQuery = `
                    SELECT * FROM ${SCHEMAS.ENROLLMENT}.enrollments
                    WHERE student_id = $1 AND course_id = $2 AND status = 'ACTIVE'
                `;
                
                const enrollmentResult = await client.query(enrollmentQuery, [
                    req.user.sub,
                    itemResult.rows[0].course_id
                ]);
                
                if (enrollmentResult.rows.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: "해당 과목을 수강 중이 아닙니다."
                    });
                }
            }
        } finally {
            client.release();
        }
        
        // S3에서 파일 목록 조회
        const files = await listAssignmentFiles(itemId);
        
        res.json({
            success: true,
            data: {
                files
            }
        });
    } catch (error) {
        console.error('Error fetching assignment files:', error);
        res.status(500).json({
            success: false,
            message: "파일 목록 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

// 평가 항목 파일 업로드를 위한 URL 생성
router.post('/items/:itemId/upload-urls', verifyToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
    try {
        const { itemId } = req.params;
        const { files } = req.body;
        
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: "업로드할 파일 정보가 필요합니다."
            });
        }
        
        // 평가 항목 존재 여부 확인
        const client = await masterPool.connect();
        let courseId;
        
        try {
            const itemQuery = `
                SELECT * FROM ${SCHEMAS.GRADE}.grade_items
                WHERE item_id = $1
            `;
            
            const itemResult = await client.query(itemQuery, [itemId]);
            
            if (itemResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "평가 항목을 찾을 수 없습니다."
                });
            }
            
            courseId = itemResult.rows[0].course_id;
        } finally {
            client.release();
        }
        
        // 과제/퀴즈 파일은 'assignments/{itemId}/' 경로에 저장
        const folderPrefix = `assignments/${itemId}`;
        
        // 파일 정보에 폴더 경로 추가
        const filesWithPrefix = files.map(file => ({
            ...file,
            prefix: folderPrefix
        }));
        
        // presigned URL 생성
        const presignedUrls = await generateUploadUrls(courseId, 'assignments', filesWithPrefix);
        
        res.json({
            success: true,
            message: "업로드 URL이 생성되었습니다.",
            data: {
                urls: presignedUrls
            }
        });
    } catch (error) {
        console.error('Error generating upload URLs for assignment files:', error);
        res.status(500).json({
            success: false,
            message: "업로드 URL 생성 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

module.exports = router;
