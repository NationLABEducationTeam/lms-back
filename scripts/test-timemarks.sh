#!/bin/bash

# 환경 변수 설정
API_URL="http://localhost:3000/api/v1"
AUTH_TOKEN="YOUR_JWT_TOKEN"  # 실제 토큰으로 교체 필요
COURSE_ID="COURSE_ID"        # 실제 강의 ID로 교체 필요
VIDEO_ID="VIDEO_ID"          # 실제 비디오 ID로 교체 필요

# 색상 설정
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# 결과 출력 함수
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ $2 성공${NC}"
    else
        echo -e "${RED}✗ $2 실패${NC}"
        echo "응답: $3"
    fi
}

echo "🚀 타임마크 API 테스트 시작"

# 1. 타임마크 생성 테스트
echo -e "\n1️⃣  타임마크 생성 테스트"
CREATE_RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -d "{\"courseId\":\"$COURSE_ID\",\"videoId\":\"$VIDEO_ID\",\"timestamp\":120,\"content\":\"테스트 타임마크\"}" \
    "$API_URL/timemarks")

TIMEMARK_ID=$(echo $CREATE_RESPONSE | jq -r '.data.id')
TIMESTAMP=$(echo $CREATE_RESPONSE | jq -r '.data.timestamp')

print_result $? "타임마크 생성" "$CREATE_RESPONSE"

# 2. 타임마크 목록 조회 테스트
echo -e "\n2️⃣  타임마크 목록 조회 테스트"
LIST_RESPONSE=$(curl -s -X GET \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    "$API_URL/timemarks/$COURSE_ID/$VIDEO_ID")

print_result $? "타임마크 목록 조회" "$LIST_RESPONSE"

# 3. 타임마크 수정 테스트
echo -e "\n3️⃣  타임마크 수정 테스트"
UPDATE_RESPONSE=$(curl -s -X PUT \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -d "{\"content\":\"수정된 타임마크\",\"timestamp\":\"$TIMESTAMP\"}" \
    "$API_URL/timemarks/$TIMEMARK_ID")

print_result $? "타임마크 수정" "$UPDATE_RESPONSE"

# 4. 타임마크 삭제 테스트
echo -e "\n4️⃣  타임마크 삭제 테스트"
DELETE_RESPONSE=$(curl -s -X DELETE \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    "$API_URL/timemarks/$TIMEMARK_ID?timestamp=$TIMESTAMP")

print_result $? "타임마크 삭제" "$DELETE_RESPONSE"

echo -e "\n🏁 테스트 완료" 