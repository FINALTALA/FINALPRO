import { Logger } from '@nestjs/common';

/**
 * Sprint 19: the one place every background interval loop in this
 * codebase (OutboxRelayService, FulfilmentSweepService,
 * DiscountActivationSweepService) starts/stops itself and decides
 * whether to run its real timer at all - the first such loops this
 * project has (no BullMQ, no @nestjs/schedule, no prior scheduler of
 * any kind - see each service's own comment for why a plain
 * `setInterval` was chosen over a new dependency).
 *
 * Deliberately NOT started when `NODE_ENV === 'test'` - Jest sets this
 * automatically for every run (unit and e2e), with nothing in this
 * codebase ever overriding it. A real timer ticking in the background
 * during an e2e run would be pure nondeterminism: tests assert exact
 * counts/states by calling a service's own `*Once()` method directly
 * (mirroring FulfilmentReconciliationService.reconcileOne(), already
 * exposed and tested the same way before this sprint), never by
 * waiting on a timer.
 *
 * TB-11: one tick at a time per task in this process. `setInterval`
 * does not wait for the previous tick, so a slow tick (a slow database,
 * a lock wait) used to overlap the next one - double the load on the
 * shared connection pool, and the same candidates worked twice. Now a
 * tick that comes due while the previous one still runs is skipped and
 * counted; when the long tick ends, one WARN says how long it ran and
 * how many ticks it skipped. Across several API instances the tasks
 * rely on row locks (`FOR UPDATE SKIP LOCKED`, re-checked) instead.
 */
/**
 * Phase A+ (Playwright determinism): the isolated Playwright API - and only
 * it - may pause named periodic tasks with E2E_PAUSED_TASKS (a comma list
 * of task names, e.g. `ReturnSweepService`), the same switch pattern as
 * AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: honoured only with E2E_TEST_SUPPORT=1
 * and never with NODE_ENV=production. A paused task's timer is simply not
 * started (exactly what NODE_ENV=test already does for every task); its
 * own logic is untouched. Every other environment ignores the variable.
 */
export function pausedForIsolatedE2e(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.E2E_TEST_SUPPORT !== '1' || env.NODE_ENV === 'production')
    return false;
  return (env.E2E_PAUSED_TASKS ?? '')
    .split(',')
    .map((x) => x.trim())
    .includes(name);
}

export class PeriodicTask {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private skippedThisRun = 0;
  /** Ticks skipped because the previous one was still running, since start. */
  skippedTicks = 0;
  private readonly logger: Logger;

  constructor(
    private readonly intervalMs: number,
    private readonly runOnce: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
    private readonly name = 'PeriodicTask',
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (pausedForIsolatedE2e(this.name)) {
      this.logger.warn(
        'not started: paused in the isolated Playwright API (E2E_PAUSED_TASKS)',
      );
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** One guarded tick - what the timer calls; public so the guard itself can be unit-tested. */
  async tick(): Promise<'ran' | 'skipped'> {
    if (this.running) {
      this.skippedTicks += 1;
      this.skippedThisRun += 1;
      return 'skipped';
    }
    this.running = true;
    this.skippedThisRun = 0;
    const started = Date.now();
    try {
      await this.runOnce();
    } catch (err) {
      this.onError(err);
    } finally {
      const tookMs = Date.now() - started;
      if (this.skippedThisRun > 0) {
        this.logger.warn(
          `tick ran ${tookMs} ms (interval ${this.intervalMs} ms); ${this.skippedThisRun} tick(s) skipped while it ran`,
        );
      }
      this.running = false;
    }
    return 'ran';
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
