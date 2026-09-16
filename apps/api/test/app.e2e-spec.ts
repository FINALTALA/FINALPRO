import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns ok and a correlation id', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.headers['x-correlation-id']).toBeDefined();
      });
  });

  it('POST /api/v1/health/echo without Idempotency-Key is rejected (422)', () => {
    return request(app.getHttpServer())
      .post('/api/v1/health/echo')
      .send({ hello: 'world' })
      .expect(422);
  });

  it('POST /api/v1/health/echo replays the same response for a repeated Idempotency-Key', async () => {
    const key = `test-${Date.now()}`;
    const first = await request(app.getHttpServer())
      .post('/api/v1/health/echo')
      .set('Idempotency-Key', key)
      .send({ hello: 'world' })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/health/echo')
      .set('Idempotency-Key', key)
      .send({ hello: 'DIFFERENT' })
      .expect(201);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});
