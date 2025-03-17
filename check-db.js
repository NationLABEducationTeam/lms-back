const { masterPool } = require('./src/config/database');

async function checkGradeItems() {
  let client;
  try {
    client = await masterPool.connect();
    console.log('🔍 데이터베이스 연결 성공');
    
    // 과제 항목 조회
    const assignmentResult = await client.query(`
      SELECT * FROM grade_schema.grade_items 
      WHERE course_id = '585f59d5-a341-4853-b74c-c6cfcf608ba5' 
      AND item_type = 'ASSIGNMENT'`);
    
    console.log('\n📚 과제 항목:');
    console.log(JSON.stringify(assignmentResult.rows, null, 2));
    
    // 학생 등록 정보 확인
    const enrollmentResult = await client.query(`
      SELECT * FROM enrollment_schema.enrollments
      WHERE course_id = '585f59d5-a341-4853-b74c-c6cfcf608ba5'
      LIMIT 10`);
    
    console.log('\n👨‍🎓 학생 등록 정보:');
    console.log(JSON.stringify(enrollmentResult.rows, null, 2));
    
    // student_grades 테이블에 해당 과제에 대한 점수가 있는지 확인
    if (assignmentResult.rows.length > 0) {
      const itemIds = assignmentResult.rows.map(item => item.item_id).join(',');
      
      const gradesResult = await client.query(`
        SELECT sg.*, e.student_id
        FROM grade_schema.student_grades sg
        JOIN enrollment_schema.enrollments e ON sg.enrollment_id = e.id
        WHERE sg.item_id IN (${itemIds})
        LIMIT 10`);
      
      console.log('\n📝 학생 점수:');
      console.log(JSON.stringify(gradesResult.rows, null, 2));
    }
    
  } catch (error) {
    console.error('❌ 에러 발생:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

checkGradeItems(); 