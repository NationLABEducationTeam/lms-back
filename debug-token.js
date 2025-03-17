const jwt = require('jsonwebtoken');

// JWT 토큰 디코딩 함수 (verify 없이)
function decodeToken(token) {
  try {
    // JWT verify 없이 토큰 내용만 확인 (signature 검증 안함)
    const decoded = jwt.decode(token, { complete: true });
    return decoded;
  } catch (error) {
    console.error('토큰 디코딩 에러:', error);
    return null;
  }
}

// 샘플 토큰
const token = 'eyJraWQiOiJxUUhCbDlUVEVGR005dmg2dFBrYmlnTmU3bTBRb1dVN1FkQ1RmTXk0V2xvPSIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiJkNGQ4OWQ2Yy0yMGUxLTcwMWQtMTM0NC01MDk4ODNlYWRkYTMiLCJjb2duaXRvOmdyb3VwcyI6WyJTVFVERU5UIl0sImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJpc3MiOiJodHRwczpcL1wvY29nbml0by1pZHAuYXAtbm9ydGhlYXN0LTIuYW1hem9uYXdzLmNvbVwvYXAtbm9ydGhlYXN0LTJfUldJdjJZcDJmIiwiY29nbml0bzp1c2VybmFtZSI6ImRvbmdpazIwIiwiZ2l2ZW5fbmFtZSI6IuuvvO2VmeyDnSIsIm9yaWdpbl9qdGkiOiI3YTI5NmRlNy02M2JmLTRiZWItODI2ZS1lYmY5YzU0MmVkYzciLCJjb2duaXRvOnJvbGVzIjpbImFybjphd3M6aWFtOjo0NzExMTI1ODgyMTA6cm9sZVwvQUlOX05BVElPTlNMQUJfTE1TX1dlYnNpdGVfU3R1ZGVudFJvbGUiXSwiYXVkIjoiNDVmNmFlZTNxN3ZnczdjajMzMmk1OTg5N28iLCJldmVudF9pZCI6IjQ1ZmY0YzBlLWM1NzUtNGY3ZC05MWQ4LWFlMmNhMGJjZDIzZCIsInRva2VuX3VzZSI6ImlkIiwiYXV0aF90aW1lIjoxNzQyMTY2OTAwLCJuYW1lIjoiZG9uZ2lrMjAiLCJleHAiOjE3NDIxODM2MTMsImN1c3RvbTpyb2xlIjoiU1RVREVOVCIsImlhdCI6MTc0MjE4MDAxMywianRpIjoiOTJhODNhMjEtODc0OS00YTc1LWJkMmEtNTFiNjUyNjBmMmFmIiwiZW1haWwiOiJkb25naWsyMEBuYXZlci5jb20ifQ.H2_rlIuLHtYN3tCZg3GD98boC0vpNdQogbNa3Ol9jpUVkYJoocLvU0jYq45Pp_O2LPw1mkmn5XWDNf12evKL_iUVa4_Seggz2kkdlTiROn7qTDT2b2hKOVfjOunsaEb-_tvLvKpQjVV1Fp4XuYpz2nzBO-Jqub6Oj9V6AfefWmDm2enE7NwU3qqAhay71SD02VDx6nVHKDMv1RJ1l7MASQ6x7XG1vlid0FjAbmmqRPbTo2uax2O3Q-YCQzrgThZYWwqDERVPox-ixpTsSFvbklR_FzQO1W890lA8Sp3A7Lyrxzb16-PU2W2yUCpsOBTkYewA7OEJ7vwNFxFY8a4opg';

// 토큰 디코딩 실행
const decodedToken = decodeToken(token);
console.log('디코딩된 토큰:');
console.log(JSON.stringify(decodedToken, null, 2));

// 다양한 필드 확인
if (decodedToken && decodedToken.payload) {
  console.log('\n=== 중요 필드 확인 ===');
  console.log('sub: ', decodedToken.payload.sub);
  console.log('cognito:username: ', decodedToken.payload['cognito:username']);
  console.log('custom:role: ', decodedToken.payload['custom:role']);
  console.log('id 필드 :', decodedToken.payload.id || '없음');
  console.log('userId 필드 :', decodedToken.payload.userId || '없음');
  console.log('cognito:groups: ', decodedToken.payload['cognito:groups']);
}

console.log('\n현재 코드에서 req.user.id 값:', decodedToken.payload.id || undefined);
console.log('올바른 사용자 ID 값:', decodedToken.payload.sub); 