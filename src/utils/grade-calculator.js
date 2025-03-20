/**
 * 성적 관리 시스템 - 성적 계산 유틸리티
 * 2024-05-07
 * 
 * 성적 계산 관련 기능을 모듈화하여 코드 중복을 제거하고 성능을 개선함
 */

const { masterPool, SCHEMAS } = require('../config/database');

/**
 * 학생의 최종 성적을 계산하고 업데이트
 * @param {Object} client - 데이터베이스 클라이언트 객체
 * @param {string} courseId - 강좌 ID
 * @param {string} studentId - 학생 ID
 * @returns {Promise<Object>} 계산된 성적 정보
 */
async function updateFinalGrades(client, courseId, studentId) {
    // 단일 쿼리로 필요한 모든 정보 조회
    const result = await client.query(`
        WITH enrollment_info AS (
            SELECT id 
            FROM ${SCHEMAS.ENROLLMENT}.enrollments
            WHERE course_id = $1 AND student_id = $2
            LIMIT 1
        ),
        attendance_info AS (
            SELECT 
                COALESCE(SUM(duration_seconds), 0) as total_attended,
                NULLIF(COALESCE(SUM(total_duration_seconds), 0), 0) as total_required
            FROM ${SCHEMAS.GRADE}.attendance_records
            WHERE course_id = $1 AND student_id = $2
        ),
        assignment_score AS (
            SELECT COALESCE(AVG(sg.score), 0) as avg_score
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN enrollment_info ei ON true
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id = sg.item_id AND sg.enrollment_id = ei.id
            WHERE gi.course_id = $1 AND gi.item_type = 'ASSIGNMENT'
        ),
        exam_score AS (
            SELECT COALESCE(AVG(sg.score), 0) as avg_score
            FROM ${SCHEMAS.GRADE}.grade_items gi
            JOIN enrollment_info ei ON true
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id = sg.item_id AND sg.enrollment_id = ei.id
            WHERE gi.course_id = $1 AND gi.item_type = 'EXAM'
        ),
        course_info AS (
            SELECT
                attendance_weight,
                assignment_weight,
                exam_weight
            FROM ${SCHEMAS.COURSE}.courses
            WHERE id = $1
        )
        SELECT
            ei.id as enrollment_id,
            c.attendance_weight,
            c.assignment_weight,
            c.exam_weight,
            CASE WHEN a.total_required > 0 
                THEN (a.total_attended::float / a.total_required) * 100 
                ELSE 0 
            END as attendance_rate,
            asg.avg_score as assignment_score,
            exm.avg_score as exam_score
        FROM enrollment_info ei
        CROSS JOIN course_info c
        CROSS JOIN attendance_info a
        CROSS JOIN assignment_score asg
        CROSS JOIN exam_score exm
    `, [courseId, studentId]);

    if (result.rows.length === 0) {
        throw new Error('수강 정보를 찾을 수 없습니다.');
    }

    const gradeInfo = result.rows[0];
    
    // 최종 성적 계산
    const {
        attendance_weight,
        assignment_weight,
        exam_weight,
        attendance_rate,
        assignment_score,
        exam_score
    } = gradeInfo;

    const totalScore = (
        (attendance_rate * attendance_weight / 100) +
        (assignment_score * assignment_weight / 100) +
        (exam_score * exam_weight / 100)
    );

    try {
        // 최종 성적 업데이트 - final_grades 테이블이 있을 경우
        await client.query(`
            INSERT INTO ${SCHEMAS.GRADE}.final_grades
            (student_id, course_id, attendance_score, assignment_score, exam_score, total_score, attendance_rate)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (student_id, course_id)
            DO UPDATE SET
                attendance_score = EXCLUDED.attendance_score,
                assignment_score = EXCLUDED.assignment_score,
                exam_score = EXCLUDED.exam_score,
                total_score = EXCLUDED.total_score,
                attendance_rate = EXCLUDED.attendance_rate,
                updated_at = CURRENT_TIMESTAMP
        `, [studentId, courseId, attendance_rate, assignment_score, exam_score, totalScore, attendance_rate]);
    } catch (error) {
        // final_grades 테이블이 없을 경우 enrollments 테이블만 업데이트
        console.error('Warning: Could not update final_grades table, updating enrollments only:', error.message);
        await client.query(`
            UPDATE ${SCHEMAS.ENROLLMENT}.enrollments
            SET final_grade = $1
            WHERE course_id = $2 AND student_id = $3
        `, [totalScore, courseId, studentId]);
    }
    
    return {
        attendance_rate,
        assignment_score,
        exam_score,
        total_score: totalScore
    };
}

/**
 * 강좌의 성적 통계 정보 조회
 * @param {Object} client - 데이터베이스 클라이언트 객체
 * @param {string} courseId - 강좌 ID
 * @returns {Promise<Object>} 성적 통계 정보
 */
async function getGradeStatistics(client, courseId) {
    const result = await client.query(`
        WITH grade_stats AS (
            SELECT
                gi.item_id,
                gi.item_name,
                gi.item_type,
                COUNT(sg.grade_id) as total_students,
                COALESCE(AVG(sg.score), 0) as average_score,
                MIN(sg.score) as min_score,
                MAX(sg.score) as max_score,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sg.score) as median_score,
                COUNT(CASE WHEN sg.is_completed THEN 1 END) as completed_count
            FROM ${SCHEMAS.GRADE}.grade_items gi
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg ON gi.item_id = sg.item_id
            WHERE gi.course_id = $1
            GROUP BY gi.item_id, gi.item_name, gi.item_type
        )
        SELECT
            c.title as course_title,
            c.attendance_weight,
            c.assignment_weight,
            c.exam_weight,
            c.weeks_count,
            c.assignment_count,
            c.exam_count,
            json_agg(
                json_build_object(
                    'id', gs.item_id,
                    'name', gs.item_name,
                    'type', gs.item_type,
                    'totalStudents', gs.total_students,
                    'averageScore', gs.average_score,
                    'minScore', gs.min_score,
                    'maxScore', gs.max_score,
                    'medianScore', gs.median_score,
                    'completedCount', gs.completed_count,
                    'completionRate', CASE WHEN gs.total_students > 0 
                        THEN (gs.completed_count::float / gs.total_students) * 100 
                        ELSE 0 
                    END
                )
            ) as items_statistics
        FROM ${SCHEMAS.COURSE}.courses c
        LEFT JOIN grade_stats gs ON true
        WHERE c.id = $1
        GROUP BY c.id, c.title, c.attendance_weight, c.assignment_weight, c.exam_weight, c.weeks_count, c.assignment_count, c.exam_count
    `, [courseId]);

    return result.rows[0] || null;
}

/**
 * 성적 변경 시 히스토리 기록 (트리거 없이 수동으로 기록)
 * @param {Object} client - 데이터베이스 클라이언트 객체
 * @param {number} gradeId - student_grades 테이블의 grade_id
 * @param {number} previousScore - 이전 점수
 * @param {number} newScore - 새 점수
 * @param {string} modifiedBy - 변경한 사용자 ID
 * @param {string} reason - 변경 사유
 * @returns {Promise<Object>} 생성된 히스토리 레코드
 */
async function recordGradeHistory(client, gradeId, previousScore, newScore, modifiedBy, reason = '') {
    try {
        const result = await client.query(`
            INSERT INTO ${SCHEMAS.GRADE}.grade_history 
            (grade_id, previous_score, new_score, modified_by, reason)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [gradeId, previousScore, newScore, modifiedBy, reason]);
        
        return result.rows[0];
    } catch (error) {
        console.error('Failed to record grade history:', error.message);
        // 히스토리 기록 실패는 전체 트랜잭션을 중단하지 않도록 오류를 throw하지 않음
        return null;
    }
}

/**
 * 성적 조회 - 최적화된 단일 쿼리
 * @param {Object} client - 데이터베이스 클라이언트 객체
 * @param {string} courseId - 강좌 ID
 * @param {string} studentId - 학생 ID
 * @returns {Promise<Object>} 학생 성적 정보
 */
async function getStudentGrades(client, courseId, studentId) {
    const result = await client.query(`
        WITH enrollment_info AS (
            SELECT id
            FROM ${SCHEMAS.ENROLLMENT}.enrollments
            WHERE course_id = $1 AND student_id = $2
            LIMIT 1
        ),
        attendance_rate AS (
            SELECT 
                CASE WHEN SUM(total_duration_seconds) > 0 
                    THEN (SUM(duration_seconds)::float / SUM(total_duration_seconds)) * 100 
                    ELSE 0 
                END as rate,
                COUNT(*) as total_sessions,
                COALESCE(json_agg(
                    json_build_object(
                        'date', attendance_date,
                        'sessionType', session_type,
                        'sessionId', session_id,
                        'durationSeconds', duration_seconds,
                        'totalDurationSeconds', total_duration_seconds,
                        'attendanceRate', CASE WHEN total_duration_seconds > 0 
                            THEN (duration_seconds::float / total_duration_seconds) * 100 
                            ELSE 0 
                        END
                    )
                ) FILTER (WHERE record_id IS NOT NULL), '[]') as sessions_data
            FROM ${SCHEMAS.GRADE}.attendance_records
            WHERE course_id = $1 AND student_id = $2
        ),
        grade_items AS (
            SELECT *
            FROM ${SCHEMAS.GRADE}.grade_items
            WHERE course_id = $1
        ),
        assignments AS (
            SELECT 
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', gi.item_id,
                            'title', gi.item_name,
                            'dueDate', gi.due_date,
                            'score', COALESCE(sg.score, 0),
                            'isCompleted', COALESCE(sg.is_completed, false)
                        )
                    ) FILTER (WHERE gi.item_id IS NOT NULL), 
                    '[]'
                ) as items,
                COALESCE(AVG(CASE WHEN sg.score IS NULL THEN 0 ELSE COALESCE(sg.score::numeric, 0) END), 0) as avg_score
            FROM grade_items gi
            LEFT JOIN enrollment_info ei ON true
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id = sg.item_id AND sg.enrollment_id = ei.id
            WHERE gi.item_type = 'ASSIGNMENT'
        ),
        exams AS (
            SELECT 
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', gi.item_id,
                            'title', gi.item_name,
                            'dueDate', gi.due_date,
                            'score', COALESCE(sg.score, 0),
                            'isCompleted', COALESCE(sg.is_completed, false)
                        )
                    ) FILTER (WHERE gi.item_id IS NOT NULL),
                    '[]'
                ) as items,
                COALESCE(AVG(CASE WHEN sg.score IS NULL THEN 0 ELSE COALESCE(sg.score::numeric, 0) END), 0) as avg_score
            FROM grade_items gi
            LEFT JOIN enrollment_info ei ON true
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id = sg.item_id AND sg.enrollment_id = ei.id
            WHERE gi.item_type = 'EXAM'
        )
        SELECT
            c.title as course_title,
            c.attendance_weight,
            c.assignment_weight,
            c.exam_weight,
            c.weeks_count,
            c.assignment_count,
            c.exam_count,
            ar.rate as attendance_rate,
            ar.total_sessions,
            ar.sessions_data as attendance_sessions,
            a.items as assignments,
            a.avg_score as assignment_score,
            e.items as exams,
            e.avg_score as exam_score,
            (
                (COALESCE(ar.rate, 0) * c.attendance_weight / 100) +
                (COALESCE(a.avg_score, 0) * c.assignment_weight / 100) +
                (COALESCE(e.avg_score, 0) * c.exam_weight / 100)
            ) as total_score
        FROM ${SCHEMAS.COURSE}.courses c
        CROSS JOIN attendance_rate ar
        CROSS JOIN assignments a
        CROSS JOIN exams e
        WHERE c.id = $1
    `, [courseId, studentId]);

    if (result.rows.length === 0) {
        return null;
    }

    const gradeInfo = result.rows[0];
    const attendanceRate = parseFloat((gradeInfo.attendance_rate || 0).toFixed(1));
    
    // 숫자형 확인 및 기본값 처리
    let assignmentScore = typeof gradeInfo.assignment_score === 'number' 
        ? parseFloat(gradeInfo.assignment_score.toFixed(1)) 
        : 0;
        
    let examScore = typeof gradeInfo.exam_score === 'number' 
        ? parseFloat(gradeInfo.exam_score.toFixed(1)) 
        : 0;
        
    let totalScore = typeof gradeInfo.total_score === 'number' 
        ? parseFloat(gradeInfo.total_score.toFixed(1)) 
        : 0;
    
    // assignments와 exams가 문자열로 반환되는 경우 파싱
    let assignments = gradeInfo.assignments;
    let exams = gradeInfo.exams;
    
    if (typeof assignments === 'string') {
        try {
            assignments = JSON.parse(assignments);
        } catch (e) {
            assignments = [];
        }
    }
    
    if (typeof exams === 'string') {
        try {
            exams = JSON.parse(exams);
        } catch (e) {
            exams = [];
        }
    }
    
    // 배열이 아닌 경우 빈 배열로 변환
    assignments = Array.isArray(assignments) ? assignments : [];
    exams = Array.isArray(exams) ? exams : [];
    
    // 점수 처리 개선: 각 항목별 점수가 숫자인지 확인하고 변환
    assignments = assignments.map(item => ({
        ...item,
        score: typeof item.score === 'number' ? item.score : 
               typeof item.score === 'string' && !isNaN(parseFloat(item.score)) ? parseFloat(item.score) : 0
    }));
    
    exams = exams.map(item => ({
        ...item,
        score: typeof item.score === 'number' ? item.score : 
              typeof item.score === 'string' && !isNaN(parseFloat(item.score)) ? parseFloat(item.score) : 0
    }));
    
    // 출석 기록이 문자열인 경우 파싱
    let attendanceSessions = gradeInfo.attendance_sessions;
    if (typeof attendanceSessions === 'string') {
        try {
            attendanceSessions = JSON.parse(attendanceSessions);
        } catch (e) {
            attendanceSessions = [];
        }
    }
    
    // 배열이 아닌 경우 빈 배열로 변환
    attendanceSessions = Array.isArray(attendanceSessions) ? attendanceSessions : [];
    
    // 진행률 및 총점 계산 방식 개선: 모든 항목 만점 대비 현재 점수 비율로 계산
    // 출석 세션 점수 계산 (모든 세션 100점 만점 기준)
    const totalAttendanceSessions = gradeInfo.weeks_count || 16; // 총 출석 세션 수 (주차 수 기준)
    const totalAttendancePoints = totalAttendanceSessions * 100; // 출석 만점 (각 세션 100점 기준)
    const earnedAttendancePoints = attendanceSessions.reduce((sum, session) => {
        // 세션별 출석률을 점수로 환산 (출석률이 80% 이상이면 100점, 그 외는 출석률에 비례)
        const sessionScore = session.attendanceRate >= 80 ? 100 : session.attendanceRate;
        return sum + sessionScore;
    }, 0);

    // 과제 점수 계산 (모든 과제 100점 만점 기준)
    const totalAssignmentCount = gradeInfo.assignment_count || 1; // 총 과제 수
    const totalAssignmentPoints = totalAssignmentCount * 100; // 과제 만점
    const earnedAssignmentPoints = assignments.reduce((sum, item) => {
        return sum + (item.isCompleted ? item.score : 0);
    }, 0);

    // 시험 점수 계산 (모든 시험 100점 만점 기준)
    const totalExamCount = gradeInfo.exam_count || 1; // 총 시험 수
    const totalExamPoints = totalExamCount * 100; // 시험 만점
    const earnedExamPoints = exams.reduce((sum, item) => {
        return sum + (item.isCompleted ? item.score : 0);
    }, 0);

    // 총점 가능 점수 (모든 항목 만점)
    const totalPossiblePoints = totalAttendancePoints + totalAssignmentPoints + totalExamPoints;

    // 획득 점수
    const totalEarnedPoints = earnedAttendancePoints + earnedAssignmentPoints + earnedExamPoints;

    // 완료율 계산
    const attendanceCompletionRate = parseFloat(((earnedAttendancePoints / totalAttendancePoints) * 100).toFixed(1));
    const assignmentCompletionRate = parseFloat(((earnedAssignmentPoints / totalAssignmentPoints) * 100).toFixed(1));
    const examCompletionRate = parseFloat(((earnedExamPoints / totalExamPoints) * 100).toFixed(1));

    // 전체 진행률 (획득 점수 / 가능 점수)
    const progressRate = parseFloat(((totalEarnedPoints / totalPossiblePoints) * 100).toFixed(1));

    // 가중치 적용 총점
    totalScore = parseFloat((
        (earnedAttendancePoints / totalAttendancePoints * 100 * gradeInfo.attendance_weight / 100) +
        (earnedAssignmentPoints / totalAssignmentPoints * 100 * gradeInfo.assignment_weight / 100) +
        (earnedExamPoints / totalExamPoints * 100 * gradeInfo.exam_weight / 100)
    ).toFixed(1));

    console.log('[DEBUG] 출석 점수:', earnedAttendancePoints, '/', totalAttendancePoints);
    console.log('[DEBUG] 과제 점수:', earnedAssignmentPoints, '/', totalAssignmentPoints);
    console.log('[DEBUG] 시험 점수:', earnedExamPoints, '/', totalExamPoints);
    console.log('[DEBUG] 총 획득 점수:', totalEarnedPoints, '/', totalPossiblePoints);
    console.log('[DEBUG] 진행률:', progressRate);
    console.log('[DEBUG] 가중치 적용 총점:', totalScore);
    
    return {
        course: {
            title: gradeInfo.course_title,
            attendance_weight: gradeInfo.attendance_weight,
            assignment_weight: gradeInfo.assignment_weight,
            exam_weight: gradeInfo.exam_weight,
            weeks_count: gradeInfo.weeks_count || 16,
            assignment_count: gradeInfo.assignment_count || 1,
            exam_count: gradeInfo.exam_count || 1
        },
        grades: {
            attendance: {
                rate: attendanceRate,
                score: parseFloat(((attendanceRate * gradeInfo.attendance_weight) / 100).toFixed(1)),
                sessions: attendanceSessions,
                totalSessions: totalAttendanceSessions,
                completionRate: attendanceCompletionRate,
                earnedPoints: earnedAttendancePoints,
                totalPoints: totalAttendancePoints
            },
            assignments: assignments,
            exams: exams,
            assignment_score: assignmentScore,
            exam_score: examScore,
            assignment_completion_rate: assignmentCompletionRate,
            exam_completion_rate: examCompletionRate,
            progress_rate: progressRate,
            total_score: totalScore,
            total_earned_points: totalEarnedPoints,
            total_possible_points: totalPossiblePoints
        }
    };
}

/**
 * 성적 데이터 내보내기 (전체 학생)
 * @param {Object} client - 데이터베이스 클라이언트 객체
 * @param {string} courseId - 강좌 ID
 * @returns {Promise<Array>} 모든 학생의 성적 데이터
 */
async function exportGradeData(client, courseId) {
    const result = await client.query(`
        WITH students AS (
            SELECT 
                e.id as enrollment_id,
                u.cognito_user_id as student_id,
                u.name as student_name,
                u.email
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            JOIN ${SCHEMAS.AUTH}.users u ON e.student_id = u.cognito_user_id
            WHERE e.course_id = $1 AND e.status = 'ACTIVE'
        ),
        attendance_rates AS (
            SELECT 
                s.student_id,
                CASE WHEN SUM(ar.total_duration_seconds) > 0 
                    THEN (SUM(ar.duration_seconds)::float / SUM(ar.total_duration_seconds)) * 100 
                    ELSE 0 
                END as rate
            FROM students s
            LEFT JOIN ${SCHEMAS.GRADE}.attendance_records ar 
                ON s.student_id = ar.student_id AND ar.course_id = $1
            GROUP BY s.student_id
        ),
        grades AS (
            SELECT
                s.student_id,
                gi.item_id,
                gi.item_name,
                gi.item_type,
                COALESCE(sg.score, 0) as score
            FROM students s
            CROSS JOIN ${SCHEMAS.GRADE}.grade_items gi
            LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
                ON gi.item_id = sg.item_id AND sg.enrollment_id = s.enrollment_id
            WHERE gi.course_id = $1
        )
        SELECT
            s.student_id,
            s.student_name,
            s.email,
            ar.rate as attendance_rate,
            c.attendance_weight,
            c.assignment_weight,
            c.exam_weight,
            json_object_agg(g.item_id, g.score) as item_scores,
            COALESCE(AVG(CASE WHEN g.item_type = 'ASSIGNMENT' THEN g.score END), 0) as avg_assignment,
            COALESCE(AVG(CASE WHEN g.item_type = 'EXAM' THEN g.score END), 0) as avg_exam,
            (
                (ar.rate * c.attendance_weight / 100) +
                (COALESCE(AVG(CASE WHEN g.item_type = 'ASSIGNMENT' THEN g.score END), 0) * c.assignment_weight / 100) +
                (COALESCE(AVG(CASE WHEN g.item_type = 'EXAM' THEN g.score END), 0) * c.exam_weight / 100)
            ) as total_score
        FROM students s
        JOIN ${SCHEMAS.COURSE}.courses c ON c.id = $1
        JOIN attendance_rates ar ON s.student_id = ar.student_id
        LEFT JOIN grades g ON s.student_id = g.student_id
        GROUP BY s.student_id, s.student_name, s.email, ar.rate, c.attendance_weight, c.assignment_weight, c.exam_weight
        ORDER BY s.student_name
    `, [courseId]);

    return result.rows;
}

module.exports = {
    updateFinalGrades,
    getGradeStatistics,
    recordGradeHistory,
    getStudentGrades,
    exportGradeData
}; 