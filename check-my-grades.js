const { masterPool } = require('./src/config/database');
const { getStudentGrades } = require('./src/utils/grade-calculator');

async function checkMyGrades() {
  let client;
  try {
    client = await masterPool.connect();
    console.log('🔍 데이터베이스 연결 성공');
    
    const courseId = '585f59d5-a341-4853-b74c-c6cfcf608ba5';
    const studentId = 'd4d89d6c-20e1-701d-1344-509883eadda3';
    
    // 직접 SQL 쿼리로 데이터 확인
    console.log('\n📊 SQL 직접 실행 결과:');
    const directResult = await client.query(`
      SELECT gi.*, sg.score, sg.is_completed, e.id as enrollment_id
      FROM grade_schema.grade_items gi
      JOIN enrollment_schema.enrollments e ON e.course_id = gi.course_id
      LEFT JOIN grade_schema.student_grades sg ON gi.item_id = sg.item_id AND sg.enrollment_id = e.id
      WHERE gi.course_id = $1 AND e.student_id = $2
      AND gi.item_type = 'ASSIGNMENT'
    `, [courseId, studentId]);
    
    console.log(JSON.stringify(directResult.rows, null, 2));
    
    // getStudentGrades 함수 호출하여 결과 확인
    console.log('\n📝 성적 계산 함수 호출 결과:');
    const gradesResult = await getStudentGrades(client, courseId, studentId);
    console.log(JSON.stringify(gradesResult, null, 2));
    
    // 가장 중요한 부분: assignments 배열 구조 확인
    if (gradesResult && gradesResult.grades && gradesResult.grades.assignments) {
      console.log('\n📚 과제 목록 타입 확인:');
      console.log('assignments 타입:', typeof gradesResult.grades.assignments);
      console.log('assignments 배열 여부:', Array.isArray(gradesResult.grades.assignments));
      console.log('assignments 길이:', 
                 Array.isArray(gradesResult.grades.assignments) ? 
                 gradesResult.grades.assignments.length : 
                 '배열이 아님');
    }
    
  } catch (error) {
    console.error('❌ 에러 발생:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

checkMyGrades(); 