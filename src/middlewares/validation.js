// 과제 항목 유효성 검사
const validateGradeItem = (req, res, next) => {
    const { courseId, name, description, maxScore, weight, dueDate } = req.body;

    if (!courseId || !name || maxScore === undefined || weight === undefined) {
        return res.status(400).json({
            success: false,
            message: "필수 필드가 누락되었습니다.",
            error: "courseId, name, maxScore, weight는 필수 항목입니다."
        });
    }

    if (maxScore <= 0) {
        return res.status(400).json({
            success: false,
            message: "최대 점수는 0보다 커야 합니다."
        });
    }

    if (weight <= 0 || weight > 100) {
        return res.status(400).json({
            success: false,
            message: "가중치는 0보다 크고 100 이하여야 합니다."
        });
    }

    if (dueDate && isNaN(Date.parse(dueDate))) {
        return res.status(400).json({
            success: false,
            message: "유효하지 않은 마감일입니다."
        });
    }

    next();
};

// 출석 기록 유효성 검사
const validateAttendance = (req, res, next) => {
    const { studentId, courseId, sessionType, sessionId, durationSeconds, totalDurationSeconds, attendanceDate } = req.body;

    if (!studentId || !courseId || !sessionType || !sessionId || !durationSeconds || !totalDurationSeconds || !attendanceDate) {
        return res.status(400).json({
            success: false,
            message: "필수 필드가 누락되었습니다."
        });
    }

    if (!['VOD', 'ZOOM'].includes(sessionType)) {
        return res.status(400).json({
            success: false,
            message: "유효하지 않은 세션 타입입니다. VOD 또는 ZOOM이어야 합니다."
        });
    }

    if (durationSeconds < 0 || totalDurationSeconds < 0) {
        return res.status(400).json({
            success: false,
            message: "시간은 음수일 수 없습니다."
        });
    }

    if (durationSeconds > totalDurationSeconds) {
        return res.status(400).json({
            success: false,
            message: "참여 시간이 전체 시간을 초과할 수 없습니다."
        });
    }

    if (isNaN(Date.parse(attendanceDate))) {
        return res.status(400).json({
            success: false,
            message: "유효하지 않은 날짜입니다."
        });
    }

    next();
};

// 성적 산출 규칙 유효성 검사
const validateGradeRules = (req, res, next) => {
    const { courseId, attendance_weight, assignment_weight, exam_weight, min_attendance_weight } = req.body;

    if (!courseId || attendance_weight === undefined || assignment_weight === undefined || 
        exam_weight === undefined || min_attendance_weight === undefined) {
        return res.status(400).json({
            success: false,
            message: "필수 필드가 누락되었습니다."
        });
    }

    if (attendance_weight < 0 || assignment_weight < 0 || exam_weight < 0) {
        return res.status(400).json({
            success: false,
            message: "가중치는 음수일 수 없습니다."
        });
    }

    if (min_attendance_weight < 0 || min_attendance_weight > 100) {
        return res.status(400).json({
            success: false,
            message: "최소 출석률은 0에서 100 사이여야 합니다."
        });
    }

    const totalWeight = attendance_weight + assignment_weight + exam_weight;
    if (totalWeight !== 100) {
        return res.status(400).json({
            success: false,
            message: "모든 가중치의 합은 100이어야 합니다."
        });
    }

    next();
};

module.exports = {
    // ... existing exports ...
    validateGradeItem,
    validateAttendance,
    validateGradeRules
}; 