#!/bin/bash

# 환경 변수 로드
source .env

# OAuth 토큰 발급
echo "OAuth 토큰 발급 중..."
AUTH_HEADER=$(echo -n "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" | base64)
TOKEN_RESPONSE=$(curl -s -X POST https://zoom.us/oauth/token \
  -H "Authorization: Basic $AUTH_HEADER" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID")

# 토큰 추출
ACCESS_TOKEN=$(echo $TOKEN_RESPONSE | grep -o '"access_token":"[^"]*' | sed 's/"access_token":"//')

if [ -z "$ACCESS_TOKEN" ]; then
  echo "토큰 발급 실패: $TOKEN_RESPONSE"
  exit 1
fi

echo "토큰 발급 성공!"

# 15분짜리 미팅 생성
echo "15분짜리 미팅 생성 중..."
MEETING_DATA='{
  "topic": "15분 테스트 미팅",
  "type": 2,
  "start_time": "'"$(date +"%Y-%m-%dT%H:%M:%S")"'",
  "duration": 15,
  "timezone": "Asia/Seoul",
  "settings": {
    "host_video": true,
    "participant_video": true,
    "join_before_host": true
  }
}'

MEETING_RESPONSE=$(curl -s -X POST https://api.zoom.us/v2/users/me/meetings \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$MEETING_DATA")

# 결과 출력
echo "미팅 생성 결과:"
echo $MEETING_RESPONSE | python -m json.tool

# 미팅 URL 추출 및 출력
JOIN_URL=$(echo $MEETING_RESPONSE | grep -o '"join_url":"[^"]*' | sed 's/"join_url":"//')
echo -e "\n미팅 참여 URL: $JOIN_URL" 