## This is a Backend Repository for the Nation's LAB LMS

## AWS Infrastructure Overview

이 프로젝트는 AWS Fargate에서 실행되는 Docker 컨테이너 기반의 백엔드 애플리케이션입니다. 배포 파이프라인은 다음과 같은 AWS 서비스를 사용합니다.

- **Amazon ECR (Elastic Container Registry):** Docker 이미지를 저장하고 관리하는 데 사용됩니다.
- **Amazon ECS (Elastic Container Service):** 컨테이너화된 애플리케이션을 배포, 관리 및 확장하는 데 사용됩니다. AWS Fargate를 시작 유형으로 사용하여 서버를 직접 관리할 필요 없이 컨테이너를 실행합니다.

### 1. Amazon ECR (Elastic Container Registry)

ECR은 Docker 이미지를 위한 프라이빗 리포지토리입니다. 백엔드 애플리케이션의 Docker 이미지는 이 리포지토리에 저장됩니다.

- **리포지토리 URI:** `471112588210.dkr.ecr.ap-northeast-2.amazonaws.com/lms-ecs`
- **리전:** `ap-northeast-2` (Asia Pacific - Seoul)
- **이미지 태그:** 배포 버전에 따라 `latest` 또는 특정 버전 태그를 사용합니다. (예: `v1.0.0`)

### 2. Amazon ECS (Elastic Container Service)

ECS는 컨테이너 오케스트레이션 서비스로, 애플리케이션의 배포와 운영을 자동화합니다.

#### 2.1. ECS 클러스터

컨테이너가 실행되는 논리적인 그룹입니다.

- **클러스터 이름:** `lms-ecs` (추정, CloudWatch 로그 그룹 경로 기반)
- **실행 유형:** AWS Fargate

#### 2.2. ECS 작업 정의 (Task Definition)

애플리케이션 컨테이너를 어떻게 실행할지에 대한 명세입니다. `task-definition.json` 파일에 정의되어 있습니다.

- **Family:** `lms-ecs-task`
- **네트워크 모드:** `awsvpc`
- **필요한 호환성:** `FARGATE`
- **CPU:** 256 units (0.25 vCPU)
- **메모리:** 512 MiB
- **실행 역할 (Execution Role):** `arn:aws:iam::471112588210:role/ecsTaskExecutionRole` - ECR에서 이미지를 가져오고 CloudWatch에 로그를 보낼 권한을 가집니다.
- **작업 역할 (Task Role):** `arn:aws:iam::471112588210:role/ecsTaskRole` - 컨테이너 내 애플리케이션이 다른 AWS 서비스(예: S3, DynamoDB)에 접근할 수 있는 권한을 가집니다.

#### 2.3. ECS 서비스

ECS 클러스터에서 지정된 수의 작업 정의 인스턴스를 동시에 실행하고 유지 관리합니다.

- **서비스 이름:** (AWS 콘솔에서 확인 필요, 예: `lms-ecs-service`)
- **시작 유형:** Fargate
- **작업 정의:** `lms-ecs-task`
- **원하는 작업 수 (Desired tasks):** (로드 및 가용성 요구사항에 따라 설정, 예: 2)
- **배포 유형:** 롤링 업데이트 (Rolling update)

### 3. 배포 프로세스

1.  **로컬에서 코드 변경:** 새로운 기능을 추가하거나 버그를 수정합니다.
2.  **Docker 이미지 빌드:** 프로젝트 루트의 `Dockerfile`을 사용하여 새로운 Docker 이미지를 빌드합니다.
    ```bash
    docker build -t 471112588210.dkr.ecr.ap-northeast-2.amazonaws.com/lms-ecs:latest .
    ```
3.  **ECR 로그인:** AWS CLI를 사용하여 ECR에 로그인합니다.
    ```bash
    aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin 471112588210.dkr.ecr.ap-northeast-2.amazonaws.com
    ```
4.  **ECR에 이미지 푸시:** 빌드한 이미지를 ECR 리포지토리에 푸시합니다.
    ```bash
    docker push 471112588210.dkr.ecr.ap-northeast-2.amazonaws.com/lms-ecs:latest
    ```
5.  **ECS 서비스 업데이트:** 새로운 Docker 이미지를 사용하도록 ECS 서비스를 업데이트하여 새 버전을 배포합니다. 이는 AWS 콘솔에서 수동으로 수행하거나, AWS CLI 또는 CI/CD 파이프라인을 통해 자동화할 수 있습니다.
    ```bash
    # AWS CLI를 사용하는 경우 예시
    aws ecs update-service --cluster lms-ecs --service lms-ecs-service --force-new-deployment
    ```

### 4. 로깅 및 모니터링

- **로그 드라이버:** `awslogs`
- **CloudWatch 로그 그룹:** `/ecs/lms-ecs`
- **리전:** `ap-northeast-2`

애플리케이션 로그는 Amazon CloudWatch Logs로 전송되어 중앙에서 모니터링하고 분석할 수 있습니다.

### 5. Why ECS Fargate? (vs. EC2)

EC2 인스턴스를 직접 사용하는 대신 ECS Fargate를 선택한 이유는 다음과 같습니다. Fargate는 서버리스 컨테이너 엔진으로, 인프라 관리 부담을 줄이고 운영 효율성을 극대화합니다.

| 항목 | ECS Fargate의 장점 |
| :--- | :--- |
| **서버 관리 불필요** | EC2 인스턴스의 생성, OS 패치, 보안 업데이트, 용량 모니터링 등의 작업이 필요 없습니다. AWS가 인프라를 관리하므로 개발자는 애플리케이션에만 집중할 수 있습니다. |
| **자동 확장 (Auto Scaling)** | 트래픽 변화에 따라 컨테이너(Task) 수를 자동으로 조절하여 안정적인 서비스를 유지하고 비용을 최적화합니다. |
| **효율적인 과금 방식** | 컨테이너가 실행되는 동안 사용한 vCPU와 메모리 자원에 대해 초 단위로 과금되어, 트래픽이 유동적이거나 적은 애플리케이션에 특히 경제적입니다. |
| **강화된 보안 격리** | 각 Task는 자체적인 커널, CPU, 메모리, 네트워크 인터페이스를 갖는 격리된 환경에서 실행되어 강력한 보안을 제공합니다. |
| **간단한 배포 및 통합** | Docker 컨테이너 기반으로 표준화된 배포가 가능하며, CodePipeline, GitHub Actions 등과 쉽게 연동하여 CI/CD 파이프라인을 구축할 수 있습니다. |
| **리소스 최적화** | 애플리케이션에 필요한 만큼의 리소스(예: 0.25 vCPU, 0.5 GB RAM)를 정밀하게 할당하여 낭비를 최소화할 수 있습니다. |
| **인프라 종속성 없음** | EC2 실행 유형처럼 ECS 클러스터의 EC2 인스턴스 용량이나 타입을 미리 계획하고 걱정할 필요가 없습니다. |
