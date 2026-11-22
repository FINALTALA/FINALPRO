import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

// TB-12.1: GET /test-support/database-identity - how the Playwright
// guard learns which database the API it drives is connected to. Test
// servers only: a 404 unless E2E_TEST_SUPPORT=1, and always a 404 when
// NODE_ENV is production. Answers only the database's name, oid and
// whether it carries the disposable-test marker.
describe('TB-12.1 test-support database identity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const saved = {
    flag: process.env.E2E_TEST_SUPPORT,
    nodeEnv: process.env.NODE_ENV,
  };
  const path = '/api/v1/test-support/database-identity';

  beforeAll(async () => {
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
    prisma = app.get(PrismaService);
  });

  afterEach(() => {
    if (saved.flag === undefined) delete process.env.E2E_TEST_SUPPORT;
    else process.env.E2E_TEST_SUPPORT = saved.flag;
    process.env.NODE_ENV = saved.nodeEnv;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is a 404 when test support is off (the default)', async () => {
    delete process.env.E2E_TEST_SUPPORT;
    const res = await request(app.getHttpServer()).get(path).expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/database|disposable/i);
  });

  it.each(['0', 'true', 'yes'])(
    'is a 404 for E2E_TEST_SUPPORT=%s (only "1" turns it on)',
    async (value) => {
      process.env.E2E_TEST_SUPPORT = value;
      await request(app.getHttpServer()).get(path).expect(404);
    },
  );

  it('is a 404 in production even with E2E_TEST_SUPPORT=1', async () => {
    process.env.E2E_TEST_SUPPORT = '1';
    process.env.NODE_ENV = 'production';
    await request(app.getHttpServer()).get(path).expect(404);
  });

  it("on a test server: this connection's database name, oid and marker - nothing else", async () => {
    process.env.E2E_TEST_SUPPORT = '1';
    const res = await request(app.getHttpServer()).get(path).expect(200);
    const [own] = await prisma.$queryRawUnsafe<{ name: string; oid: number }[]>(
      'SELECT datname AS name, oid::int AS oid FROM pg_database WHERE datname = current_database()',
    );
    expect(res.body).toEqual({
      database: own.name,
      database_oid: own.oid,
      // The e2e guard only lets this suite run on a marked database.
      disposable_test: true,
    });
    // No connection details or credentials of any kind (the exact shape
    // above already rules out extra fields; the user name is not
    // checked as a substring - it can legitimately prefix a test
    // database's own name, e.g. finalpro / finalpro_tb12_e2e).
    const raw = JSON.stringify(res.body);
    const url = new URL(process.env.DATABASE_URL!);
    for (const secret of ['postgresql://', '@', url.password, url.host]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('needs no session and changes nothing', async () => {
    process.env.E2E_TEST_SUPPORT = '1';
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer()).get(path).expect(200);
      ids.push(res.headers['x-correlation-id'] as string);
    }
    expect(ids.every(Boolean)).toBe(true);
    // Scoped to these two requests - other files write meanwhile when
    // the suite runs in parallel on one database.
    expect(
      await prisma.auditLog.count({ where: { correlationId: { in: ids } } }),
    ).toBe(0);
  });
});
