const { masterPool, SCHEMAS } = require('./src/config/database');

async function debugAssignmentsDetailed() {
  let client;
  try {
    client = await masterPool.connect();
    console.log('🔍 데이터베이스 연결 성공');
    
    // 토큰에서 확인된 학생 ID
    const studentId = 'd4d89d6c-20e1-701d-1344-509883eadda3';
    
    console.log(`\n===== 학생 ID: ${studentId} 정보 확인 =====`);
    
    // 1. 학생 기본 정보 확인
    const studentResult = await client.query(`
      SELECT * FROM ${SCHEMAS.AUTH}.users WHERE cognito_user_id = $1
    `, [studentId]);
    
    console.log('\n👨‍🎓 학생 기본 정보:');
    console.log(JSON.stringify(studentResult.rows, null, 2));
    
    // 2. 학생 수강 등록 정보 확인 - status 확인 필수
    const enrollmentsResult = await client.query(`
      SELECT e.*, c.title AS course_title
      FROM ${SCHEMAS.ENROLLMENT}.enrollments e
      JOIN ${SCHEMAS.COURSE}.courses c ON e.course_id = c.id
      WHERE e.student_id = $1
    `, [studentId]);
    
    console.log('\n📚 수강 등록 정보:');
    console.log(JSON.stringify(enrollmentsResult.rows, null, 2));
    
    if (enrollmentsResult.rows.length === 0) {
      console.log('❌ 수강 등록 정보가 없습니다!');
      return;
    }
    
    const activeEnrollmentsResult = await client.query(`
      SELECT e.*, c.title AS course_title
      FROM ${SCHEMAS.ENROLLMENT}.enrollments e
      JOIN ${SCHEMAS.COURSE}.courses c ON e.course_id = c.id
      WHERE e.student_id = $1 AND e.status = 'ACTIVE'
    `, [studentId]);
    
    console.log('\n📚 활성화된 수강 등록 정보:');
    console.log(JSON.stringify(activeEnrollmentsResult.rows, null, 2));
    
    if (activeEnrollmentsResult.rows.length === 0) {
      console.log('❌ 활성화된 수강 등록 정보가 없습니다! 모든 등록의 status 값을 확인하세요.');
      return;
    }
    
    // 3. 수강 중인 모든 과목의 과제 항목 확인
    for (const enrollment of activeEnrollmentsResult.rows) {
      console.log(`\n===== 과목: ${enrollment.course_title} (${enrollment.course_id}) =====`);
      
      const gradeItemsResult = await client.query(`
        SELECT *
        FROM ${SCHEMAS.GRADE}.grade_items
        WHERE course_id = $1
      `, [enrollment.course_id]);
      
      console.log('\n📝 과제/퀴즈 항목:');
      console.log(JSON.stringify(gradeItemsResult.rows, null, 2));
      
      if (gradeItemsResult.rows.length === 0) {
        console.log(`❌ 과목 ${enrollment.course_id}에 등록된 과제/퀴즈가 없습니다!`);
        continue;
      }
      
      // 4. 학생의 과제 성적 정보 확인
      const gradesResult = await client.query(`
        SELECT sg.*, gi.item_name
        FROM ${SCHEMAS.GRADE}.student_grades sg
        JOIN ${SCHEMAS.GRADE}.grade_items gi ON sg.item_id = gi.item_id
        WHERE sg.enrollment_id = $1
      `, [enrollment.id]);
      
      console.log('\n📊 과제/퀴즈 성적 정보:');
      console.log(JSON.stringify(gradesResult.rows, null, 2));
      
      // 5. 과제 조회 쿼리 테스트 - 각 테이블 조인 순서 확인
      console.log('\n🧪 과제 조회 쿼리 테스트:');
      
      const itemIds = gradeItemsResult.rows.map(item => `'${item.item_id}'`).join(', ');
      
      if (itemIds) {
        // 5.1 테이블 데이터 개별 확인
        console.log(`\n👉 grade_items 테이블 item_id 확인: ${itemIds}`);
        
        // 5.2 수정한 JOIN 순서로 테스트
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
              COALESCE(sg.is_completed, false) AS is_completed
          FROM my_enrollments me
          JOIN ${SCHEMAS.COURSE}.courses c ON me.course_id = c.id
          JOIN ${SCHEMAS.GRADE}.grade_items gi ON me.course_id = gi.course_id
          LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
              ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = me.enrollment_id
          ORDER BY gi.due_date ASC, c.title ASC
        `, [studentId]);
        
        console.log('\n🔧 개선된 조회 쿼리 결과:');
        console.log(JSON.stringify(improvedQueryResult.rows, null, 2));
        
        // 5.3 데이터 타입 불일치 확인
        console.log('\n👉 데이터 타입 확인:');
        const dataTypeResult = await client.query(`
          SELECT 
              gi.item_id, pg_typeof(gi.item_id) as gi_item_id_type,
              sg.item_id, pg_typeof(sg.item_id) as sg_item_id_type,
              sg.enrollment_id, pg_typeof(sg.enrollment_id) as sg_enrollment_id_type,
              e.id, pg_typeof(e.id) as e_id_type
          FROM ${SCHEMAS.GRADE}.grade_items gi
          CROSS JOIN ${SCHEMAS.ENROLLMENT}.enrollments e 
          LEFT JOIN ${SCHEMAS.GRADE}.student_grades sg 
              ON gi.item_id::text = sg.item_id::text AND sg.enrollment_id = e.id
          WHERE gi.course_id = $1 AND e.student_id = $2 AND e.status = 'ACTIVE'
          LIMIT 1
        `, [enrollment.course_id, studentId]);
        
        console.log(JSON.stringify(dataTypeResult.rows, null, 2));
      }
    }
    
  } catch (error) {
    console.error('❌ 에러 발생:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

debugAssignmentsDetailed(); 