import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';

// TB-16.4: POST /auth/login answers 429 after 10 sign-ins a minute from one
// address - the production behaviour, unchanged. Only a server started
// with E2E_TEST_SUPPORT=1 (the isolated Playwright API) may raise it with
// AUTH_LOGIN_RATE_LIMIT_PER_MINUTE; anywhere else, and in production even
// with that switch, the variable changes nothing. Each case runs on a
// fresh app (the throttler counts in the app's own memory).
describe('TB-16.4 sign-in rate limit (e2e)', () => {
  const saved = {
    flag: process.env.E2E_TEST_SUPPORT,
    limit: process.env.AUTH_LOGIN_RATE_LIMIT_PER_MINUTE,
    nodeEnv: process.env.NODE_ENV,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore('E2E_TEST_SUPPORT', saved.flag);
    restore('AUTH_LOGIN_RATE_LIMIT_PER_MINUTE', saved.limit);
    restore('NODE_ENV', saved.nodeEnv);
  });

  async function freshApp(): Promise<INestApplication> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    return app;
  }

  /** Sends `n` sign-ins (an unknown account - only the limit matters) and
   * returns their statuses in order. */
  async function signIns(app: INestApplication, n: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone: '+970561234567', password: 'not-the-password' });
      statuses.push(res.status);
    }
    return statuses;
  }
  const firstLimited = (statuses: number[]) => statuses.indexOf(429) + 1;

  /** Runs `n` sign-ins on a fresh app with these variables set only for
   * the requests (the app starts with the test environment as usual). */
  async function withEnv(vars: Record<string, string | undefined>, n: number) {
    const app = await freshApp();
    try {
      for (const [key, value] of Object.entries(vars)) restore(key, value);
      return await signIns(app, n);
    } finally {
      restore('NODE_ENV', saved.nodeEnv);
      await app.close();
    }
  }

  it('production behaviour: the 11th sign-in in a minute is refused with 429 (no variable set)', async () => {
    const statuses = await withEnv(
      {
        E2E_TEST_SUPPORT: undefined,
        AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: undefined,
      },
      11,
    );
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it('the isolated test server may raise it: with E2E_TEST_SUPPORT=1 and a limit of 15, the 11th-15th pass and the 16th is refused', async () => {
    const statuses = await withEnv(
      { E2E_TEST_SUPPORT: '1', AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '15' },
      16,
    );
    expect(statuses.slice(0, 15)).not.toContain(429);
    expect(firstLimited(statuses)).toBe(16);
  });

  it('without E2E_TEST_SUPPORT the variable changes nothing: still refused at the 11th', async () => {
    const statuses = await withEnv(
      { E2E_TEST_SUPPORT: undefined, AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '1000' },
      11,
    );
    expect(firstLimited(statuses)).toBe(11);
  });

  it('in production the variable changes nothing even with E2E_TEST_SUPPORT=1: still refused at the 11th', async () => {
    const statuses = await withEnv(
      {
        E2E_TEST_SUPPORT: '1',
        AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
        NODE_ENV: 'production',
      },
      11,
    );
    expect(firstLimited(statuses)).toBe(11);
  });
});
