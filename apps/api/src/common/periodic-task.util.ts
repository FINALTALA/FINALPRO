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
 */
export class PeriodicTask {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly runOnce: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
  ) {}

  start(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(this.onError);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
