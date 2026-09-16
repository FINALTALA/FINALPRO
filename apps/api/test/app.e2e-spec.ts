import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

describe('Foundation conventions (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('health', () => {
    it('GET /api/v1/health returns ok and a correlation id', () => {
      return request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.headers['x-correlation-id']).toBeDefined();
        });
    });
  });

  describe('Part 4, H.1 error-response format', () => {
    it('a 404 on an unknown route uses the {error:{code,message,details,correlation_id}} shape', () => {
      return request(app.getHttpServer())
        .get('/api/v1/this-route-does-not-exist')
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toEqual(
            expect.objectContaining({
              code: 'NOT_FOUND',
              message: expect.any(String),
              details: expect.any(Array),
              correlation_id: expect.any(String),
            }),
          );
          // the body's correlation_id must be the same one echoed in the header
          expect(res.body.error.correlation_id).toBe(
            res.headers['x-correlation-id'],
          );
        });
    });

    it('a thrown business exception (422, missing Idempotency-Key) also uses the shared error shape', () => {
      return request(app.getHttpServer())
        .post('/api/v1/health/echo')
        .send({ hello: 'world' })
        .expect(422)
        .expect((res) => {
          expect(res.body.error).toEqual(
            expect.objectContaining({
              code: 'UNPROCESSABLE_ENTITY',
              correlation_id: expect.any(String),
            }),
          );
        });
    });
  });

  describe('rate limiting', () => {
    it('the strict demo route (3/min) returns 429 once its limit is exceeded', async () => {
      const agent = request(app.getHttpServer());
      for (let i = 0; i < 3; i++) {
        await agent.get('/api/v1/health/rate-limit-demo').expect(200);
      }
      const limited = await agent
        .get('/api/v1/health/rate-limit-demo')
        .expect(429);
      expect(limited.body.error).toBeDefined();
    });
  });

  describe('idempotency (Part 4, H.1)', () => {
    it('replays the exact original response for a repeated key with the same payload', async () => {
      const key = `test-replay-${Date.now()}`;
      const first = await request(app.getHttpServer())
        .post('/api/v1/health/echo')
        .set('Idempotency-Key', key)
        .send({ hello: 'world' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/health/echo')
        .set('Idempotency-Key', key)
        .send({ hello: 'world' })
        .expect(201);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
    });

    it('returns 409 when the same key is reused with a different payload', async () => {
      const key = `test-conflict-${Date.now()}`;
      await request(app.getHttpServer())
        .post('/api/v1/health/echo')
        .set('Idempotency-Key', key)
        .send({ hello: 'world' })
        .expect(201);

      const conflict = await request(app.getHttpServer())
        .post('/api/v1/health/echo')
        .set('Idempotency-Key', key)
        .send({ hello: 'DIFFERENT' })
        .expect(409);

      expect(conflict.body.error.correlation_id).toBeDefined();
    });

    it('under true concurrency (same key, different payload, fired in parallel), exactly one request succeeds and the other is rejected with 409 - never both processed', async () => {
      const key = `test-race-${Date.now()}`;
      const agent = request(app.getHttpServer());

      const [a, b] = await Promise.all([
        agent
          .post('/api/v1/health/echo')
          .set('Idempotency-Key', key)
          .send({ who: 'A' }),
        agent
          .post('/api/v1/health/echo')
          .set('Idempotency-Key', key)
          .send({ who: 'B' }),
      ]);

      const statuses = [a.status, b.status].sort();
      // Exactly one 201 (whoever the database's unique constraint let
      // win the claim) and one 409 (the loser - either "already being
      // processed" if it arrived before the winner finished, or
      // "different payload" if it arrived after). Never 201+201.
      expect(statuses).toEqual([201, 409]);
    });

    // `scope` isolation (two different authenticated users reusing the
    // same client-chosen key must never collide) is covered at the unit
    // level (idempotency.interceptor.spec.ts), since exercising it here
    // would need a real second authenticated identity - not available
    // until EPIC-AUTH (Sprint 2) provides req.user for real.

    it('under two concurrent requests racing to take over the same stale IN_PROGRESS claim, the handler runs exactly once - never twice', async () => {
      const prisma = app.get(PrismaService);
      const key = `test-stale-takeover-${Date.now()}`;
      const requestPath = '/api/v1/health/echo';
      // A payload unique to this test run, so the audit-log assertion
      // below can't be confused by another test's echo call.
      const body = { probe: `stale-takeover-${key}` };
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ method: 'POST', path: requestPath, body }))
        .digest('hex');

      // Simulate a claim abandoned by a crashed request: IN_PROGRESS,
      // created well past the 30s staleness threshold, matching payload.
      await prisma.idempotencyKey.create({
        data: {
          key,
          scope: 'anonymous',
          requestPath,
          requestHash,
          status: 'IN_PROGRESS',
          createdAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const agent = request(app.getHttpServer());
      const [a, b] = await Promise.all([
        agent
          .post('/api/v1/health/echo')
          .set('Idempotency-Key', key)
          .send(body),
        agent
          .post('/api/v1/health/echo')
          .set('Idempotency-Key', key)
          .send(body),
      ]);

      // Whoever wins the compare-and-swap takeover reruns the handler
      // (201). The loser sees one of two *legitimate* outcomes,
      // depending only on how far the winner had gotten by the time the
      // loser re-checks: still IN_PROGRESS -> 409 "already being
      // processed"; already COMPLETED -> replay of the winner's own
      // response (also 201). Both are correct - the handler still only
      // ran once either way. What must never happen is the handler
      // running twice, or a status this endpoint cannot produce.
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);

      // Prove "ran at most once" directly, rather than inferring it
      // from status codes alone: the handler writes one AuditLog row
      // per actual execution, so a race that ran it twice would leave
      // two rows for this distinctive payload instead of one.
      const auditRows = await prisma.auditLog.findMany({
        where: { action: 'health.echo', afterState: { equals: body } },
      });
      expect(auditRows).toHaveLength(1);
    });
  });
});
