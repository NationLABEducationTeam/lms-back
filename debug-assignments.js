const { masterPool, SCHEMAS } = require('./src/config/database');

async function debugAssignments() {
  let client;
  try {
    client = await masterPool.connect();
    console.log('🔍 데이터베이스 연결 성공');
    
    // 테스트할 학생 ID
    const studentId = 'd4d89d6c-20e1-701d-1344-509883eadda3';
    
    console.log(`\n📚 학생 ID ${studentId}의 수강 등록 정보 확인:`);
    const enrollmentsResult = await client.query(`
      SELECT e.id AS enrollment_id, e.course_id, c.title AS course_title, e.status
      FROM ${SCHEMAS.ENROLLMENT}.enrollments e
      JOIN ${SCHEMAS.COURSE}.courses c ON e.course_id = c.id
      WHERE e.student_id = $1
    `, [studentId]);
    
    console.log(JSON.stringify(enrollmentsResult.rows, null, 2));
    
    if (enrollmentsResult.rows.length > 0) {
      // 수강 중인 첫 번째 과목의 과제 아이템 확인
      const courseId = enrollmentsResult.rows[0].course_id;
      console.log(`\n📝 과목 ID ${courseId}의 과제 아이템 확인:`);
      
      const assignmentsResult = await client.query(`
        SELECT *
        FROM ${SCHEMAS.GRADE}.grade_items
        WHERE course_id = $1
      `, [courseId]);
      
      console.log(JSON.stringify(assignmentsResult.rows, null, 2));
      
      // student_grades 테이블 확인
      console.log(`\n📊 과목 ID ${courseId}의 학생 성적 정보 확인:`);
      const enrollmentId = enrollmentsResult.rows[0].enrollment_id;
      
      const gradesResult = await client.query(`
        SELECT sg.* 
        FROM ${SCHEMAS.GRADE}.student_grades sg
        JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id = gi.item_id
        WHERE sg.enrollment_id = $1 AND gi.course_id = $2
      `, [enrollmentId, courseId]);
      
      console.log(JSON.stringify(gradesResult.rows, null, 2));
      
      // 원래 쿼리 테스트
      console.log(`\n🧪 원래 쿼리 테스트 결과:`);
      const originalQueryResult = await client.query(`
        WITH my_enrollments AS (
            SELECT e.id AS enrollment_id, e.course_id
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            WHERE e.student_id = $1 AND e.status = 'ACTIVE'
        )
        SELECT 
            gi.item_id,
            gi.item_type,
            gi.item_name AS title,
            gi.due_date,
            c.id AS course_id,
            c.title AS course_title,
            c.thumbnail_url,
            COALESCE(sg.score, 0) AS score,
            COALESCE(sg.is_completed, false) AS is_completed,
            CASE 
                WHEN gi.due_date < NOW() THEN '마감됨'
                WHEN sg.is_completed THEN '제출완료' 
                ELSE '진행중' 
            END AS status
        FROM ${SCHEMAS.GRADE}.grade_items gi
        JOIN my_enrollments me ON gi.course_id = me.course_id
        JOIN ${SCHEMAS.COURSE}.courses c ON gi.course_id = c.id
        LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
            ON gi.item_id = sg.item_id AND sg.enrollment_id = me.enrollment_id
        ORDER BY gi.due_date ASC, c.title ASC
      `, [studentId]);
      
      console.log(JSON.stringify(originalQueryResult.rows, null, 2));
      
      // 개선된 쿼리 테스트
      console.log(`\n🔧 개선된 쿼리 테스트 결과:`);
      const improvedQueryResult = await client.query(`
        WITH my_enrollments AS (
            SELECT e.id AS enrollment_id, e.course_id
            FROM ${SCHEMAS.ENROLLMENT}.enrollments e
            WHERE e.student_id = $1 AND e.status = 'ACTIVE'
        )
        SELECT 
            gi.item_id,
            gi.item_type,
            gi.item_name AS title,
            gi.due_date,
            c.id AS course_id,
            c.title AS course_title,
            c.thumbnail_url,
            COALESCE(sg.score, 0) AS score,
            COALESCE(sg.is_completed, false) AS is_completed,
            CASE 
                WHEN gi.due_date < NOW() THEN '마감됨'
                WHEN COALESCE(sg.is_completed, false) THEN '제출완료' 
                ELSE '진행중' 
            END AS status
        FROM my_enrollments me
        JOIN ${SCHEMAS.COURSE}.courses c ON me.course_id = c.id
        JOIN ${SCHEMAS.GRADE}.grade_items gi ON me.course_id = gi.course_id
        LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
            ON gi.item_id = sg.item_id AND sg.enrollment_id = me.enrollment_id
        ORDER BY gi.due_date ASC, c.title ASC
      `, [studentId]);
      
      console.log(JSON.stringify(improvedQueryResult.rows, null, 2));
    }
    
  } catch (error) {
    console.error('❌ 에러 발생:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

debugAssignments(); 