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
        url: process.env.API_BASE_URL || 'http://localhost:3000',
        description: 'Development server',
      },
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