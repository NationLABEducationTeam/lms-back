# Nation's Lab LMS - Backend

[![Node.js CI](https://github.com/NationLABEducationTeam/lms-back/actions/workflows/deploy.yml/badge.svg)](https://github.com/NationLABEducationTeam/lms-back/actions/workflows/deploy.yml)

Nation's Lab LMS 프로젝트의 백엔드 서버입니다. Express.js 기반으로 구축되었으며, 학생, 강의, 성적, 출결 등 LMS의 핵심 기능을 관리합니다. AWS 서비스를 적극적으로 활용하여 안정적이고 확장 가능한 인프라를 제공합니다.

---

## 목차

- [주요 기능](#-주요-기능)
- [기술 스택](#-기술-스택)
- [시스템 아키텍처](#-시스템-아키텍처)
- [시작하기](#-시작하기)
  - [사전 준비](#사전-준비)
  - [설치 및 실행](#설치-및-실행)
- [환경 변수](#-환경-변수)
- [API 문서 (Swagger)](#-api-문서-swagger)
- [배포](#-배포)
  - [Amazon ECR](#amazon-ecr)
  - [Amazon ECS](#amazon-ecs)
  - [자동 배포](#자동-배포)

---

## ✨ 주요 기능

- **👨‍🎓 사용자 관리:** JWT 기반 인증 및 사용자 정보 관리
- **📚 강좌 관리:** 강좌 생성, 조회, 수정 및 학생 등록 관리
- **📝 과제 관리:** 과제 제출 및 채점, 피드백 기능
- **📈 성적 관리:** 과제, 시험, 출석을 종합한 최종 성적 산출 및 조회
- **⏰ 출결 관리:** VOD 시청 기록 기반 자동 출결 시스템
- **📹 타임마크:** 동영상 강의에 대한 북마크 및 메모 기능
- **🤖 AI 기능:** (기능 설명 추가)

---

## 🛠 기술 스택

| 구분 | 기술 |
| :--- | :--- |
| **Backend** | Express.js, Node.js |
| **Database** | PostgreSQL (RDS), DynamoDB |
| **Cache** | Redis (ElastiCache) |
| **Authentication** | JWT, AWS Cognito |
| **Deployment** | Docker, AWS ECS, AWS Fargate |
| **Storage** | AWS S3 |
| **Logging** | Morgan, Winston |
| **API Docs** | Swagger |

---

## 🏗 시스템 아키텍처

이 프로젝트는 AWS Fargate에서 실행되는 Docker 컨테이너 기반의 백엔드 애플리케이션입니다.

![Architecture Diagram](https://user-images.githubusercontent.com/42625893/189433626-d4468f30-5813-4e4b-84a1-12f5518b456d.png)
*(위 다이어그램은 예시이며, 실제 아키텍처에 맞게 수정이 필요할 수 있습니다.)*

주요 AWS 서비스는 다음과 같습니다.
- **Amazon ECR:** Docker 이미지를 저장하고 관리합니다.
- **Amazon ECS & Fargate:** 컨테이너화된 애플리케이션을 서버리스 환경에서 배포하고 운영합니다.
- **Amazon RDS:** PostgreSQL 데이터베이스를 관리합니다.
- **Amazon S3:** 강의 자료, 과제 제출 파일 등 정적 파일을 저장합니다.
- **Amazon DynamoDB:** 비정형 데이터(예: 타임마크)를 저장합니다.
- **Amazon ElastiCache:** Redis를 통해 세션 및 자주 사용되는 데이터를 캐싱합니다.

---

## 🚀 시작하기

### 사전 준비

- [Node.js](https://nodejs.org/) (v18.x 이상 권장)
- [Docker](https://www.docker.com/)
- [AWS CLI](https://aws.amazon.com/cli/)
- `pnpm` (또는 `npm`, `yarn`)

### 설치 및 실행

1.  **레포지토리 클론:**
    ```bash
    git clone https://github.com/NationLABEducationTeam/lms-back.git
    cd lms-back
    ```

2.  **의존성 설치:**
    ```bash
    pnpm install
    ```

3.  **.env 파일 설정:**
    `.env.example` 파일을 복사하여 `.env` 파일을 생성하고, 환경에 맞게 변수 값을 수정합니다. (아래 [환경 변수](#-환경-변수) 섹션 참고)

4.  **개발 서버 실행:**
    ```bash
    pnpm dev
    ```
    서버는 `http://localhost:3000`에서 실행됩니다.

---

## ⚙️ 환경 변수

애플리케이션을 실행하려면 다음과 같은 환경 변수가 필요합니다. `.env` 파일에 설정해주세요.

```dotenv
# Server
PORT=3000
API_BASE_URL=http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com

# AWS Credentials
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Database (PostgreSQL)
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
DB_NAME=...

# AWS Cognito for JWT Authentication
COGNITO_JWKS_URL=https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_RWIv2Yp2f/.well-known/jwks.json

# Redis (ElastiCache)
ELASTICACHE_HOST=...
ELASTICACHE_PORT=6379
```

---

## 🔗 API 문서 (Swagger)

이 프로젝트의 모든 API는 Swagger를 통해 문서화되어 있습니다. 아래 링크에서 각 엔드포인트의 상세한 명세(요청, 응답, 스키마 등)를 확인하고 직접 테스트해볼 수 있습니다.

- **API 문서 바로가기:** [http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com/api-docs](http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com/api-docs)

### 로컬에서 확인하는 방법
1. 개발 서버를 실행합니다 (`node server.js`).
2. 브라우저에서 [http://localhost:3000/api-docs](http://localhost:3000/api-docs)로 접속합니다.

---

## 🚢 배포

배포는 GitHub Actions를 통해 자동으로 이루어집니다. `main` 브랜치에 코드가 푸시되면 워크플로우가 실행되어 ECR에 새 이미지를 빌드 및 푸시하고, ECS 서비스를 업데이트합니다.

### Amazon ECR

- **리포지토리 URI:** `471112588210.dkr.ecr.ap-northeast-2.amazonaws.com/lms-ecs`
- **리전:** `ap-northeast-2` (Asia Pacific - Seoul)

### Amazon ECS

ECS는 컨테이너 오케스트레이션 서비스로, 애플리케이션의 배포와 운영을 자동화합니다.

- **클러스터 이름:** `lms-ecs-cluster`
- **실행 유형:** AWS Fargate

#### ECS 작업 정의 (Task Definition)
애플리케이션 컨테이너를 어떻게 실행할지에 대한 명세이며, `task-definition.json` 파일에 정의되어 있습니다.
- **Family:** `lms-ecs-task`
- **CPU / Memory:** 0.25 vCPU / 512 MiB
- **네트워크 모드:** `awsvpc`
- **실행 역할 (Execution Role):** ECR에서 이미지를 가져오고 CloudWatch에 로그를 전송하는 권한을 가집니다.
- **작업 역할 (Task Role):** 컨테이너 내 애플리케이션이 S3, DynamoDB 등 다른 AWS 서비스에 접근할 수 있는 권한을 가집니다.

#### ECS 서비스 (Service)
지정된 수의 작업 정의 인스턴스를 클러스터에서 항상 실행하고 유지 관리합니다.
- **서비스 이름:** `lms-service`
- **시작 유형:** Fargate
- **원하는 작업 수 (Desired Tasks):** 로드 및 가용성 요구사항에 따라 설정 (예: 2)
- **배포 전략:** 롤링 업데이트 (무중단 배포)

### 자동 배포
`main` 브랜치에 코드가 푸시되면 GitHub Actions 워크플로우가 자동으로 실행됩니다. 이 파이프라인은 다음 작업을 수행합니다.
1. Docker 이미지 빌드 및 ECR 푸시
2. 새 이미지를 사용하도록 ECS 작업 정의 업데이트
3. ECS 서비스를 업데이트하여 새 버전 배포

### Why ECS Fargate? (vs. EC2)

| 항목 | ECS Fargate의 장점 |
| :--- | :--- |
| **서버 관리 불필요** | OS 패치, 보안 업데이트 등 인프라 관리 부담이 없습니다. |
| **자동 확장** | 트래픽에 따라 컨테이너 수를 자동으로 조절하여 안정성과 비용 효율성을 높입니다. |
| **효율적인 과금** | 사용한 vCPU, 메모리 자원에 대해 초 단위로 과금되어 경제적입니다. |
| **강화된 보안** | 각 Task가 격리된 환경에서 실행되어 강력한 보안을 제공합니다. |
| **리소스 최적화** | 필요한 만큼의 리소스를 정밀하게 할당하여 낭비를 최소화합니다. |
