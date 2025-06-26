# Nation's Lab LMS - Backend

[![Node.js CI](https://github.com/NationLABEducationTeam/lms-back/actions/workflows/deploy.yml/badge.svg)](https://github.com/NationLABEducationTeam/lms-back/actions/workflows/deploy.yml)
[![Express.js](https://img.shields.io/badge/Express.js-4.x-orange.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14-blue.svg)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-20.10-blue.svg?logo=docker)](https://www.docker.com/)
[![AWS ECS](https://img.shields.io/badge/AWS-ECS-orange.svg?logo=amazon-aws)](https://aws.amazon.com/ecs/)

Nation's Lab LMS 프로젝트의 백엔드 서버입니다. Express.js를 기반으로 구축되었으며, AWS의 강력한 클라우드 서비스를 활용하여 안정적이고 확장 가능한 학습 관리 시스템의 핵심 기능을 제공합니다.

---

## 📚 목차

1.  [**주요 기능**](#-주요-기능)
2.  [**기술 스택**](#-기술-스택)
3.  [**시스템 아키텍처**](#-시스템-아키텍처)
4.  [**시작하기**](#-시작하기)
    - [사전 준비](#사전-준비)
    - [설치 및 실행](#설치-및-실행)
5.  [**환경 변수**](#-환경-변수)
6.  [**API 문서 (Swagger)**](#-api-문서-swagger)
7.  [**배포 (CI/CD)**](#-배포-cicd)
    - [개발자 워크플로우 가이드](#-개발자-워크플로우-가이드)
    - [배포 파이프라인](#배포-파이프라인)
    - [AWS 인프라 구성](#aws-인프라-구성)

---

## ✨ 주요 기능

-   **👨‍🎓 사용자 관리**: JWT 및 AWS Cognito 기반의 안전한 인증 및 사용자 정보 관리
-   **📚 강좌 관리**: 강좌 생성, 조회, 수정 및 학생 등록 처리
-   **📝 과제 관리**: 과제 제출, 채점, 상세 피드백 기능
-   **📈 성적 관리**: 과제, 시험, 출석을 종합한 최종 성적 자동 산출 및 조회
-   **⏰ 출결 관리**: VOD 시청 기록을 기반으로 한 자동 출결 시스템
-   **📹 타임마크**: 동영상 강의의 특정 지점에 북마크와 메모를 남기는 기능
-   **🤖 AI 기능**: (추후 기능 추가 시 설명)

---

## 🛠 기술 스택

| 구분             | 기술                               | 설명                                                                   |
| :--------------- | :--------------------------------- | :--------------------------------------------------------------------- |
| **Backend**      | `Express.js`, `Node.js`            | RESTful API 서버 구축                                                  |
| **Database**     | `PostgreSQL (RDS)`, `DynamoDB`     | 정형 데이터(사용자, 강좌)와 비정형 데이터(타임마크) 저장                 |
| **Cache**        | `Redis (ElastiCache)`              | 자주 사용되는 데이터 캐싱을 통한 성능 향상                               |
| **Authentication** | `JWT`, `AWS Cognito`             | 사용자 인증 및 권한 부여                                               |
| **Deployment**   | `Docker`, `AWS ECS`, `AWS Fargate` | 컨테이너 기반의 서버리스 배포 및 운영                                  |
| **Storage**      | `AWS S3`                           | 강의 자료, 과제 제출 파일 등 정적 에셋 저장                            |
| **Logging**      | `Morgan`, `Winston`                | 요청 로깅 및 에러 추적                                                 |
| **API Docs**     | `Swagger`                          | API 명세 자동 생성 및 테스트 UI 제공                                   |

---

## 🏗 시스템 아키텍처

본 프로젝트는 AWS Fargate에서 실행되는 Docker 컨테이너 기반의 서버리스 백엔드 애플리케이션입니다.

![Architecture Diagram](https://user-images.githubusercontent.com/42625893/189433626-d4468f30-5813-4e4b-84a1-12f5518b456d.png)
*(위 다이어그램은 예시이며, 실제 아키텍처에 맞게 수정이 필요할 수 있습니다.)*

#### 주요 서비스 역할:

-   **Amazon ECR (Elastic Container Registry)**: 빌드된 Docker 이미지를 안전하게 저장하고 관리하는 프라이빗 레지스트리입니다.
-   **Amazon ECS (Elastic Container Service) & Fargate**: 컨테이너화된 애플리케이션을 서버리스 환경에서 배포하고 운영합니다. Fargate를 통해 서버 인프라를 직접 관리할 필요 없이 컨테이너 실행에만 집중할 수 있습니다.
-   **Amazon RDS (Relational Database Service)**: PostgreSQL 데이터베이스를 안정적으로 운영 및 관리합니다.
-   **Amazon S3 (Simple Storage Service)**: 강의 자료, 과제 제출 파일, 이미지 등 모든 정적 파일을 저장하는 확장 가능한 스토리지입니다.
-   **Amazon DynamoDB**: 빠른 응답 속도가 필요한 비정형 데이터(예: 타임마크, 로그)를 저장하는 NoSQL 데이터베이스입니다.
-   **Amazon ElastiCache**: Redis를 호스팅하여 세션 정보나 자주 조회되는 데이터를 캐싱하여 API 응답 시간을 단축합니다.

---

## 🚀 시작하기

### 사전 준비

-   [Node.js](https://nodejs.org/) (v18.x 이상 권장)
-   [pnpm](https://pnpm.io/installation) (프로젝트의 패키지 매니저)
-   [Docker](https://www.docker.com/)
-   [AWS CLI](https://aws.amazon.com/cli/) (선택 사항, 로컬에서 AWS 리소스와 상호작용 시 필요)

### 설치 및 실행

1.  **레포지토리 복제:**
    ```bash
    git clone https://github.com/NationLABEducationTeam/lms-back.git
    cd lms-back
    ```

2.  **의존성 설치:**
    ```bash
    pnpm install
    ```

3.  **.env 파일 설정:**
    `.env.example` 파일을 복사하여 `.env` 파일을 생성하고, 로컬 개발 환경에 맞게 변수 값을 수정합니다. ([환경 변수](#-환경-변수) 섹션 참고)

4.  **개발 서버 실행:**
    ```bash
    pnpm dev
    ```
    서버는 `http://localhost:3000`에서 실행되며, 파일 변경 시 자동으로 재시작됩니다.

---

## ⚙️ 환경 변수

애플리케이션 실행에 필요한 환경 변수입니다. `.env` 파일에 설정해주세요.

```dotenv
# Server Configuration
PORT=3000
API_BASE_URL=http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com # 배포된 서버의 기본 URL

# AWS Credentials (로컬 개발 시 필요)
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Database (PostgreSQL - Amazon RDS)
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
DB_NAME=lms_db

# AWS Cognito for JWT Authentication
COGNITO_JWKS_URL=https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_RWIv2Yp2f/.well-known/jwks.json

# Redis (Amazon ElastiCache)
ELASTICACHE_HOST=...
ELASTICACHE_PORT=6379
```

---

## 🔗 API 문서 (Swagger)

모든 API는 Swagger를 통해 문서화되어 있습니다. 각 엔드포인트의 상세 명세(요청, 응답, 스키마 등)를 확인하고 직접 테스트할 수 있습니다.

-   **운영 서버 API 문서:** [http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com/api-docs](http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com/api-docs)
-   **로컬 서버 API 문서:** 개발 서버 실행 후 [http://localhost:3000/api-docs](http://localhost:3000/api-docs)로 접속

---

## 🚢 배포 (CI/CD)

### 개발자 워크플로우 가이드

> **✅ 핵심: Git 브랜치에 Push하면 배포는 자동입니다.**
>
> 이 프로젝트는 GitHub Flow를 기반으로 한 완전 자동화된 CI/CD 파이프라인이 구축되어 있습니다. 개발자는 배포 과정 자체에 개입할 필요 없이, Git 브랜치 전략에 따라 작업하기만 하면 됩니다. **배포를 위해 GitHub Actions 워크플로우(`.github/workflows/*.yml`)를 수정하거나, AWS 자격 증명을 별도로 설정할 필요가 없습니다.**
>
> 1.  **브랜치 생성**: 새로운 기능 개발이나 버그 수정 시, `main` 브랜치에서 새로운 브랜치를 생성합니다. (예: `feature/new-api`, `fix/login-bug`)
> 2.  **개발 및 Push**: 코드를 수정한 후, 자신의 브랜치에 커밋하고 Push합니다.
> 3.  **테스트 서버 배포 (선택 사항)**: 특정 브랜치(예: `develop` 또는 `feature/*`)에 Push하면, 코드가 자동으로 **테스트 서버**에 배포될 수 있습니다. 이를 통해 `main` 브랜치에 병합하기 전에 변경사항을 안전하게 검증할 수 있습니다.
> 4.  **Pull Request**: 개발이 완료되면 `main` 브랜치로 Pull Request(PR)를 생성합니다.
> 5.  **프로덕션 배포**: PR이 승인되고 `main` 브랜치에 병합(Merge)되면, 변경사항은 자동으로 **프로덕션 서버**에 배포됩니다.

### 배포 파이프라인

1.  **Trigger**: `main` 또는 `develop` 등의 주요 브랜치에 Push 또는 Pull Request Merge 발생
2.  **Build**: 소스코드를 기반으로 Docker 이미지를 빌드합니다.
3.  **Push to ECR**: 빌드된 이미지를 AWS ECR(Elastic Container Registry)에 푸시합니다.
4.  **Update ECS Task Definition**: ECR에 푸시된 새 이미지 정보를 담아 ECS 작업 정의(Task Definition)의 새 버전을 생성합니다.
5.  **Deploy to ECS**: 업데이트된 작업 정의를 사용하여 해당 환경(테스트/프로덕션)의 ECS 서비스(Service)를 롤링 업데이트 방식으로 배포합니다. 이 과정에서 무중단 배포가 이루어집니다.

### AWS 인프라 구성

#### Amazon ECR (Elastic Container Registry)

-   **역할**: Docker 이미지를 저장, 관리, 배포하는 완전 관리형 컨테이너 레지스트리입니다.
-   **리포지토리 URI**: `471112588210.dkr.ecr.ap-northeast-2.amazonaws.com/lms-ecs`

#### Amazon ECS (Elastic Container Service)

ECS는 컨테이너 오케스트레이션 서비스로, 애플리케이션의 배포와 운영을 자동화합니다.

-   **클러스터**: `lms-ecs-cluster`
-   **실행 유형**: **AWS Fargate**를 사용하여 서버 관리가 필요 없는 서버리스 환경에서 컨테이너를 실행합니다.

##### ECS 작업 정의 (Task Definition)

애플리케이션 컨테이너를 어떻게 실행할지에 대한 명세서입니다. (`task-definition.json` 파일 참조)

-   **Family**: `lms-ecs-task`
-   **CPU / Memory**: 0.25 vCPU / 512 MiB
-   **네트워크 모드**: `awsvpc`
-   **실행 역할 (Execution Role)**: ECR에서 이미지를 가져오고 CloudWatch에 로그를 전송하는 권한을 가집니다.
-   **작업 역할 (Task Role)**: 컨테이너 내 애플리케이션이 S3, DynamoDB 등 다른 AWS 서비스에 접근할 수 있는 권한을 가집니다.

##### ECS 서비스 (Service)

지정된 수의 작업(컨테이너) 인스턴스를 클러스터에서 항상 실행하고 유지 관리합니다.

-   **서비스 이름**: `lms-service` (환경별로 접미사가 붙을 수 있음. 예: `lms-service-prod`, `lms-service-dev`)
-   **원하는 작업 수 (Desired Tasks)**: 2 (가용성을 위해 2개 이상 유지)
-   **배포 전략**: 롤링 업데이트 (무중단 배포)

##### Fargate를 사용하는 이유

| 항목              | ECS Fargate의 장점                                                     |
| :---------------- | :--------------------------------------------------------------------- |
| **서버 관리 불필요**  | OS 패치, 보안 업데이트 등 인프라 관리 부담이 없습니다.                 |
| **자동 확장**       | 트래픽에 따라 컨테이너 수를 자동으로 조절하여 안정성과 비용 효율을 높입니다. |
| **효율적인 과금**   | 사용한 vCPU, 메모리 자원에 대해서만 초 단위로 과금되어 경제적입니다.     |
| **강화된 보안**     | 각 Task가 격리된 환경에서 실행되어 강력한 보안을 제공합니다.           |
| **리소스 최적화**   | 필요한 만큼의 리소스를 정밀하게 할당하여 낭비를 최소화합니다.          |
