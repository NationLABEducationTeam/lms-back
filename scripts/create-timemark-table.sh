#!/bin/bash

# AWS 리전 설정
AWS_REGION="ap-northeast-2"

# DynamoDB 테이블 생성
aws dynamodb create-table \
    --table-name LMSVOD_TimeMarks \
    --attribute-definitions \
        AttributeName=id,AttributeType=S \
        AttributeName=timestamp,AttributeType=S \
    --key-schema \
        AttributeName=id,KeyType=HASH \
        AttributeName=timestamp,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region $AWS_REGION

# 테이블 생성 확인
aws dynamodb describe-table \
    --table-name LMSVOD_TimeMarks \
    --region $AWS_REGION 