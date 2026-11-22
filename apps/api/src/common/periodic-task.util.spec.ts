import { pausedForIsolatedE2e } from './periodic-task.util';

describe('E2E_PAUSED_TASKS (phase A+: the isolated Playwright API only)', () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  it('pauses a listed task only with E2E_TEST_SUPPORT=1 outside production', () => {
    expect(
      pausedForIsolatedE2e(
        'ReturnSweepService',
        env({ E2E_TEST_SUPPORT: '1', E2E_PAUSED_TASKS: 'ReturnSweepService' }),
      ),
    ).toBe(true);
    expect(
      pausedForIsolatedE2e(
        'ReturnSweepService',
        env({
          E2E_TEST_SUPPORT: '1',
          E2E_PAUSED_TASKS: ' OutboxRelayService , ReturnSweepService ',
        }),
      ),
    ).toBe(true);
  });

  it('ignores the variable everywhere else: without E2E_TEST_SUPPORT, in production, or for a task not listed', () => {
    expect(
      pausedForIsolatedE2e(
        'ReturnSweepService',
        env({ E2E_PAUSED_TASKS: 'ReturnSweepService' }),
      ),
    ).toBe(false);
    expect(
      pausedForIsolatedE2e(
        'ReturnSweepService',
        env({
          E2E_TEST_SUPPORT: '1',
          NODE_ENV: 'production',
          E2E_PAUSED_TASKS: 'ReturnSweepService',
        }),
      ),
    ).toBe(false);
    expect(
      pausedForIsolatedE2e(
        'OutboxRelayService',
        env({ E2E_TEST_SUPPORT: '1', E2E_PAUSED_TASKS: 'ReturnSweepService' }),
      ),
    ).toBe(false);
    expect(
      pausedForIsolatedE2e(
        'ReturnSweepService',
        env({ E2E_TEST_SUPPORT: '1' }),
      ),
    ).toBe(false);
  });
});
