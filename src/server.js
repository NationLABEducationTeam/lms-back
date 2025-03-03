const gradesRouter = require('./routes/admin/grades');
app.use('/api/v1/admin/grades', gradesRouter);

// Register routes
app.use(`${API_PREFIX}/courses`, require('./src/routes/admin/courses'));  // admin 라우터를 기본 courses 경로로 이동
// app.use(`${API_PREFIX}/admin/courses`, require('./src/routes/admin/courses'));  // 기존 admin 라우터는 주석 처리 