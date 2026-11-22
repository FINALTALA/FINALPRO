/**
 * TB-16.4: the POST /auth/login rate limit - 10 a minute per address
 * (FR-AUTH-011's stricter-than-global limit), always, in every normal run,
 * finalpro and production included.
 *
 * The one exception is the isolated Playwright API: a whole browser suite
 * signs in from one address, so a few sign-in-heavy files in a row exceed
 * 10 a minute. That server is started with E2E_TEST_SUPPORT=1 (the same
 * switch the test-support routes need) and may then set
 * AUTH_LOGIN_RATE_LIMIT_PER_MINUTE. Without E2E_TEST_SUPPORT=1 - or with
 * NODE_ENV=production even when it is set - the variable is ignored and
 * the limit stays 10. Read per request: nothing is decided at build or
 * import time.
 */
export const DEFAULT_LOGIN_LIMIT_PER_MINUTE = 10;
const MAX_TEST_LOGIN_LIMIT_PER_MINUTE = 10_000;

export function loginRateLimitPerMinute(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const isolatedTestServer =
    env.E2E_TEST_SUPPORT === '1' && env.NODE_ENV !== 'production';
  if (!isolatedTestServer) return DEFAULT_LOGIN_LIMIT_PER_MINUTE;
  const raw = env.AUTH_LOGIN_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return DEFAULT_LOGIN_LIMIT_PER_MINUTE;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_TEST_LOGIN_LIMIT_PER_MINUTE
    ? limit
    : DEFAULT_LOGIN_LIMIT_PER_MINUTE;
}
