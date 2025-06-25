const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Nation LMS API',
      version: '1.0.0',
      description: 'Learning Management System API Documentation',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
      {
        url: 'http://lms-alb-599601140.ap-northeast-2.elb.amazonaws.com',
        description: 'Production Server (ALB)'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '사용자 고유 ID (UUID)',
              example: 'a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6'
            },
            name: {
              type: 'string',
              description: '사용자 이름',
              example: '홍길동'
            },
            email: {
              type: 'string',
              format: 'email',
              description: '이메일 주소',
              example: 'gildong@example.com'
            },
            role: {
              type: 'string',
              enum: ['STUDENT', 'INSTRUCTOR', 'ADMIN'],
              description: '사용자 역할',
              example: 'STUDENT'
            }
          }
        },
        Course: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '강좌 고유 ID (UUID)',
              example: 'a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6'
            },
            title: {
              type: 'string',
              description: '강좌 제목',
              example: 'Node.js 마스터하기'
            },
            description: {
              type: 'string',
              description: '강좌 설명',
              example: 'Express와 AWS를 활용한 백엔드 개발'
            },
            instructor_name: {
              type: 'string',
              description: '교수자 이름',
              example: '김교수'
            },
            status: {
              type: 'string',
              enum: ['DRAFT', 'PUBLISHED'],
              description: '강좌 상태',
              example: 'PUBLISHED'
            }
          }
        },
        ReviewQuestion: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '질문 ID'
            },
            text: {
              type: 'string',
              description: '질문 내용'
            },
            type: {
              type: 'string',
              enum: ['TEXT', 'TEXTAREA', 'MULTIPLE_CHOICE'],
              description: '질문 타입'
            },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string'
                  }
                }
              },
              description: '객관식 옵션 (MULTIPLE_CHOICE일 때만)'
            }
          },
          required: ['text', 'type']
        },
        ReviewTemplate: {
          type: 'object',
          properties: {
            id: {
              type: 'string'
            },
            title: {
              type: 'string'
            },
            courseId: {
              type: 'string',
              description: '과목 ID'
            },
            targetRespondents: {
              type: 'integer',
              description: '목표 응답자 수'
            },
            questions: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/ReviewQuestion'
              }
            },
            createdAt: {
              type: 'string',
              format: 'date-time'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time'
            }
          }
        },
        ReviewResponse: {
          type: 'object',
          properties: {
            id: {
              type: 'string'
            },
            reviewTemplateId: {
              type: 'string'
            },
            answers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  questionId: {
                    type: 'string'
                  },
                  answer: {
                    type: 'string'
                  }
                }
              }
            },
            submittedAt: {
              type: 'string',
              format: 'date-time'
            }
          }
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ]
  },
  apis: ['./src/routes/**/*.js'], // API 문서가 있는 파일 경로
};

const specs = swaggerJSDoc(options);

module.exports = {
  swaggerUi,
  specs
}; 