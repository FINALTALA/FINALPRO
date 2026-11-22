import {
  DEFAULT_LOGIN_LIMIT_PER_MINUTE,
  loginRateLimitPerMinute,
} from './login-rate-limit';

// TB-16.4: the sign-in limit is 10 a minute in every normal run; only the
// isolated Playwright API (E2E_TEST_SUPPORT=1, not production) may set
// AUTH_LOGIN_RATE_LIMIT_PER_MINUTE.
describe('loginRateLimitPerMinute', () => {
  it('is 10 by default', () => {
    expect(DEFAULT_LOGIN_LIMIT_PER_MINUTE).toBe(10);
    expect(loginRateLimitPerMinute({})).toBe(10);
  });

  it('takes the override on the isolated test server (E2E_TEST_SUPPORT=1)', () => {
    expect(
      loginRateLimitPerMinute({
        E2E_TEST_SUPPORT: '1',
        AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
      }),
    ).toBe(1000);
    expect(
      loginRateLimitPerMinute({
        E2E_TEST_SUPPORT: '1',
        NODE_ENV: 'test',
        AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '15',
      }),
    ).toBe(15);
  });

  it('ignores the variable without E2E_TEST_SUPPORT=1 - set by mistake in a normal run, it changes nothing', () => {
    for (const flag of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(
        loginRateLimitPerMinute({
          ...(flag === undefined ? {} : { E2E_TEST_SUPPORT: flag }),
          AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
        }),
      ).toBe(10);
    }
  });

  it('ignores it in production even with E2E_TEST_SUPPORT=1', () => {
    expect(
      loginRateLimitPerMinute({
        NODE_ENV: 'production',
        E2E_TEST_SUPPORT: '1',
        AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
      }),
    ).toBe(10);
  });

  it('a missing or unusable value on the test server keeps 10', () => {
    for (const value of [
      undefined,
      '',
      'abc',
      '0',
      '-5',
      '1e3',
      '12.5',
      '99999',
    ]) {
      expect(
        loginRateLimitPerMinute({
          E2E_TEST_SUPPORT: '1',
          ...(value === undefined
            ? {}
            : { AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: value }),
        }),
      ).toBe(10);
    }
  });
});
