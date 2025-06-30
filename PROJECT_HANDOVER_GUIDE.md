# Nation's Lab LMS 백엔드 - 프로젝트 인수인계 가이드

**문서 버전: 1.0**
**최종 수정일: 2024-06-27**

---

## 1. 프로젝트 개요

### 1.1. 프로젝트 목적 및 주요 기능

**목적:** Nation's Lab LMS의 핵심 백엔드 시스템으로, 강좌, 학생, 성적, 인증 등 모든 서버 사이드 로직을 처리하고 안정적인 API를 제공합니다.

**주요 기능:**
- **강좌/수강 관리:** 강좌 생성 및 조회, 주차별 강의 자료(S3 연동) 관리, 학생 수강 신청 처리
- **성적/과제 관리:** 과제 제출, 자동/수동 채점, 상세 피드백, 출결 및 성적 종합 산출
- **인증/인가:** AWS Cognito와 연동된 JWT 기반의 안전한 인증 및 역할 기반(학생, 교수, 관리자) 접근 제어
- **VOD 특화 기능:** 동영상 강의의 특정 지점에 메모를 남기는 타임마크 기능 (DynamoDB 연동)

**사용자 타겟:** LMS 플랫폼을 사용하는 학생, 교수, 그리고 시스템을 관리하는 관리자

**비즈니스 가치:** 안정적이고 확장 가능한 백엔드 시스템을 통해 다양한 LMS 기능을 제공하고, 데이터 기반의 학습 관리 및 분석의 기반을 마련합니다.

### 1.2. 프로젝트 규모 및 개발 기간

- **규모:** Express.js 기반의 RESTful API 서버로, 주요 기능별 라우트 파일 약 15개로 구성됩니다.
- **개발 기간:** (프로젝트 시작일) ~ 현재

## 2. 기술 스택 및 환경

### 2.1. 프로그래밍 언어, 프레임워크, 라이브러리

| 구분 | 기술명 | 버전 | 설명 |
| --- | --- | --- | --- |
| **언어** | JavaScript (Node.js) | ~18.x | 서버사이드 런타임 환경 |
| **프레임워크** | Express.js | ~4.21.2| RESTful API 서버 구축을 위한 웹 프레임워크 |
| **데이터베이스**| PostgreSQL | - | 사용자, 강좌, 성적 등 핵심 정형 데이터 저장 (AWS RDS) |
| | DynamoDB | - | 동영상 타임마크 등 비정형 데이터 저장 (AWS DynamoDB) |
| | Redis | - | 세션 및 자주 쓰는 데이터 캐싱 (AWS ElastiCache) |
| **인증** | AWS Cognito, JWT | - | 사용자 인증 및 토큰 발급/검증 |
| | jwks-rsa | ~3.1.0 | Cognito의 공개키를 가져와 JWT 토큰을 안전하게 검증 |
| **AWS SDK** | @aws-sdk/client-s3 등 | ~3.x | S3, DynamoDB 등 AWS 서비스와 상호작용 |
| **DB 드라이버** | pg | ~8.13.1 | Node.js와 PostgreSQL 데이터베이스 연결 |
| **API 문서** | Swagger | ~6.2.8 | JSDoc 주석을 기반으로 API 문서를 자동 생성 |
| **로깅** | Morgan, Winston | ~1.10.0, ~3.11.0| HTTP 요청 로깅 및 애플리케이션 로그 관리 |

### 2.2. 개발/테스트/운영 환경

- **개발 환경:** 개발자 개인 PC(로컬)에서 `npm run dev` 명령어로 실행합니다.
- **테스트 환경:** `npm test`를 통해 `Jest` 기반의 자동화된 테스트를 실행합니다. (현재 테스트 케이스 추가 필요)
- **운영 환경:** AWS ECS Fargate 기반의 서버리스 컨테이너 환경에서 실행됩니다.

## 3. 설치 및 실행 가이드

### 3.1. 로컬 개발 환경 설정

**필수 도구 설치:**
- Node.js (v18.0.0 이상)
- npm (Node.js 설치 시 자동 설치)
- Docker (선택 사항, DB 등을 로컬 컨테이너로 실행 시)

**프로젝트 클론 및 의존성 설치:**
```bash
# 1. 프로젝트 코드를 다운로드합니다.
git clone https://github.com/NationLABEducationTeam/lms-back.git

# 2. 프로젝트 폴더로 이동합니다.
cd lms-back

# 3. 필요한 라이브러리들을 설치합니다.
npm install
```

### 3.2. 환경변수 설정

프로젝트 루트에 `.env.example` 파일을 복사하여 `.env` 파일을 생성하세요. 각 값은 로컬 개발 환경에 맞게 설정해야 합니다.

```dotenv
# .env

# Server Configuration
PORT=3000

# AWS Credentials (로컬 개발 시에만 사용)
# 프로덕션(ECS)에서는 IAM 역할을 사용하므로 절대 사용하지 않습니다.
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY

# Database (PostgreSQL)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_password
DB_NAME=lms_dev_db

# AWS Cognito for JWT Authentication
COGNITO_JWKS_URL=...

# Redis
ELASTICACHE_HOST=localhost
ELASTICACHE_PORT=6379
```

### 3.3. 실행 명령어

**개발 서버 실행:**
```bash
npm run dev
```
실행 후 `http://localhost:3000` 주소로 서버가 시작되며, `nodemon`에 의해 코드 변경 시 자동으로 재시작됩니다.

**프로덕션 서버 실행:**
```bash
npm start
```

## 4. 프로젝트 구조

```
lms-back/
├── .github/workflows/  # GitHub Actions CI/CD 워크플로우 정의
├── scripts/            # DB 마이그레이션, 테스트 등 보조 스크립트
├── src/
│   ├── config/         # 데이터베이스, S3, Swagger 등 외부 서비스 연결 설정
│   ├── db/             # 데이터베이스 마이그레이션 SQL 스크립트
│   ├── middlewares/    # 인증(auth), 로깅(logger), 에러 처리(error) 등 미들웨어
│   ├── routes/         # API 엔드포인트 정의 및 라우팅 로직
│   │   └── admin/      # 관리자 전용 API 라우트
│   ├── utils/          # S3 핸들러, 성적 계산기 등 재사용 가능한 유틸리티 함수
│   └── server.js       # 애플리케이션의 메인 진입점 (Express 서버 설정)
├── .dockerignore       # Docker 이미지 빌드 시 제외할 파일 목록
├── Dockerfile          # 애플리케이션의 Docker 이미지 생성 명세
├── package.json        # 프로젝트 의존성 및 스크립트 정의
└── task-definition.json # ECS 작업 정의의 기본 템플릿
```

## 5. 배포 및 운영

### 배포 프로세스

- **핵심:** **`main` 브랜치에 코드를 Push하면 배포는 100% 자동으로 진행됩니다.**
- **방법:** `.github/workflows/deploy.yml`에 정의된 GitHub Actions가 실행되어, Docker 이미지를 빌드하고 AWS ECR에 푸시한 뒤, 최종적으로 AWS ECS 서비스를 무중단 업데이트합니다.
- **주의:** 개발자는 배포를 위해 AWS 콘솔에 접근하거나 Access Key를 다룰 필요가 전혀 없습니다.

## 6. 문제 해결 및 긴급상황 대응 가이드

### 자주 발생하는 오류

- **오류: `The AWS Access Key Id you provided does not exist in our records.`**
  - **원인 1 (로컬):** `.env` 파일에 설정된 AWS 키 값이 잘못되었거나, 해당 키에 필요한 IAM 권한이 없는 경우입니다.
  - **원인 2 (운영 서버):** **이 오류가 운영 서버에서 발생하면 99% IAM 역할 문제입니다.** 코드 어딘가에서 불완전한 Access Key 환경 변수(`AWS_SECRET_ACCESS_KEY`만 존재 등)를 읽어서, 정작 사용해야 할 IAM 역할을 사용하지 못하는 경우입니다. `src/utils/s3.js`, `src/utils/dynamodb.js` 상단에 추가된 환경 변수 삭제 로직이 이 문제를 방지합니다.

- **오류: 배포가 10분 이상 멈추거나 실패하는 경우**
  - **원인:** 새로 배포된 컨테이너가 시작 직후 오류로 인해 바로 종료되는 경우입니다.
  - **해결:** AWS ECS 콘솔 > 클러스터 > 서비스 > '작업(Tasks)' 탭에서 **'중지됨(Stopped)'** 상태의 실패한 태스크를 클릭한 뒤, '로그(Logs)' 탭의 에러 메시지를 확인해야 합니다. (예: `ReferenceError: some_variable is not defined`와 같은 문법 오류)

### 긴급상황 대응

- **보안 키 유출 의심 (`.env` 파일, AWS Access Key 등):**
  1. 즉시 AWS IAM 콘솔에 접속하여 유출된 Access Key를 **비활성화**하고, 삭제 후 재발급합니다.
  2. GitHub 리포지토리의 Secrets도 즉시 새로운 키로 교체합니다.
  3. Git 커밋 히스토리에 키가 포함되었다면, 해당 커밋을 되돌리는 것만으로는 부족합니다. BFG Repo-Cleaner나 `git filter-branch`를 사용하여 히스토리에서 키를 완전히 제거해야 합니다.

### 백업 및 복구

- **소스 코드:** 모든 코드는 GitHub에서 버전 관리되므로, `git reset` 또는 `git revert`를 통해 특정 시점으로 쉽게 복구할 수 있습니다.
- **데이터베이스 (RDS):** AWS RDS의 자동 스냅샷 기능을 활용하여 특정 시점으로 복구(Point-in-Time Recovery)가 가능합니다. (정기적인 백업 정책 설정 확인 필요)
- **S3 데이터:** S3 버킷에 버전 관리(Versioning)를 활성화하여, 파일이 실수로 덮어쓰이거나 삭제되었을 때 이전 버전으로 복구할 수 있습니다.

## 7. 관련 문서

- **API 명세:** 서버 실행 후 `http://localhost:3000/api-docs`의 Swagger UI 참조
- **DB 스키마:** `src/db/migrations` 폴더의 SQL 파일들이 실제 데이터베이스의 구조를 정의합니다.
- **요구사항/기획:** (링크 또는 파일 위치)
- **테스트 케이스:** `src/**/*.test.js` (현재 테스트 케이스 추가 필요) 