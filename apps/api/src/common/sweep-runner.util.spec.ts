import { Logger } from '@nestjs/common';
import { PeriodicTask } from './periodic-task.util';
import {
  logSweepTick,
  runSweepStep,
  SweepBackoff,
  type SweepStepResult,
} from './sweep-runner.util';

// TB-11: the shared guard and the shared sweep runner, without a database.

function quietLogger() {
  const logger = new Logger('test');
  return {
    logger,
    log: jest.spyOn(logger, 'log').mockImplementation(() => undefined),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
}

describe('PeriodicTask (TB-11 overlap guard)', () => {
  it('skips a tick while the previous one still runs, counts it, and says so once when the long tick ends', async () => {
    let release!: () => void;
    let runs = 0;
    const task = new PeriodicTask(
      1000,
      () => {
        runs += 1;
        return new Promise<void>((r) => (release = r));
      },
      () => undefined,
      'GuardTest',
    );
    const warn = jest
      .spyOn((task as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);

    const first = task.tick();
    expect(await task.tick()).toBe('skipped');
    expect(await task.tick()).toBe('skipped');
    expect(runs).toBe(1);
    expect(task.skippedTicks).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    release();
    expect(await first).toBe('ran');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('2 tick(s) skipped');

    // The next tick runs normally and, not overlapped, logs nothing.
    const second = task.tick();
    release();
    expect(await second).toBe('ran');
    expect(runs).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a tick that throws reaches onError and never wedges the guard', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const task = new PeriodicTask(
      1000,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
      },
      (e) => errors.push(e),
    );
    expect(await task.tick()).toBe('ran');
    expect(await task.tick()).toBe('ran');
    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe('SweepBackoff (TB-11)', () => {
  it('defers 1, 2, 4, 8 then at most 10 minutes; success forgets', () => {
    const b = new SweepBackoff();
    const t0 = 1_000_000;
    const delays = [1, 2, 3, 4, 5, 6].map(
      (i) => b.recordFailure('x', t0 + i).delayMs / 60_000,
    );
    expect(delays).toEqual([1, 2, 4, 8, 10, 10]);
    expect(b.recordFailure('y', t0).first).toBe(true);
    expect(b.recordFailure('y', t0).first).toBe(false);
    b.recordSuccess('y');
    expect(b.recordFailure('y', t0).first).toBe(true);
  });

  it('lists only ids still inside their deferral', () => {
    const b = new SweepBackoff();
    b.recordFailure('a', 0); // until 60 s
    b.recordFailure('b', 0);
    b.recordFailure('b', 0); // until 120 s
    expect(b.deferredIds(30_000).sort()).toEqual(['a', 'b']);
    expect(b.deferredIds(90_000)).toEqual(['b']);
    expect(b.deferredIds(150_000)).toEqual([]);
  });

  it('keeps at most maxEntries ids (the least recently failed one goes)', () => {
    const b = new SweepBackoff(60_000, 600_000, 2);
    b.recordFailure('a', 0);
    b.recordFailure('b', 0);
    b.recordFailure('c', 0);
    expect(b.size).toBe(2);
    expect(b.deferredIds(1).sort()).toEqual(['b', 'c']);
  });
});

describe('runSweepStep (TB-11)', () => {
  it('one failing item never stops the others; its id is deferred and logged once, its repeats only counted', async () => {
    const { logger, error } = quietLogger();
    const backoff = new SweepBackoff();
    const seen: string[][] = [];
    const run = () =>
      runSweepStep({
        step: 'demo',
        logger,
        backoff,
        findCandidates: async (excluded) => {
          seen.push(excluded);
          return ['bad', 'ok1', 'ok2'].filter((id) => !excluded.includes(id));
        },
        processItem: async (id) => {
          if (id === 'bad')
            throw Object.assign(new Error('nope 0599000111'), {
              code: 'P2002',
            });
          return true;
        },
      });

    const first = await run();
    expect(first).toMatchObject({
      candidates: 3,
      done: 2,
      failed: 1,
      newFailures: 1,
      deferred: 0,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('item bad failed (Error P2002)');
    // The error message (which could carry data) is not in the log line.
    expect(error.mock.calls[0][0]).not.toContain('0599000111');

    const second = await run();
    expect(seen[1]).toEqual(['bad']);
    expect(second).toMatchObject({
      candidates: 2,
      done: 2,
      failed: 0,
      deferred: 1,
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a lock timeout is counted, not deferred; a failing candidate query fails only its step', async () => {
    const { logger, error } = quietLogger();
    const backoff = new SweepBackoff();
    const lockTimeout = await runSweepStep({
      step: 'locks',
      logger,
      backoff,
      findCandidates: async () => ['held'],
      processItem: async () => {
        throw Object.assign(
          new Error('canceling statement due to lock timeout'),
          { code: '55P03' },
        );
      },
    });
    expect(lockTimeout).toMatchObject({ lockTimeouts: 1, failed: 0 });
    expect(backoff.size).toBe(0);

    const broken = await runSweepStep({
      step: 'broken',
      logger,
      backoff,
      findCandidates: async () => {
        throw new Error('db down');
      },
      processItem: async () => true,
    });
    expect(broken).toMatchObject({ stepFailed: true, candidates: 0 });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('one summary line per tick: LOG normally, WARN only on a new failure or a failed step, nothing when idle', () => {
    const { logger, log, warn } = quietLogger();
    const step = (over: Partial<SweepStepResult>): SweepStepResult => ({
      step: 's',
      candidates: 0,
      done: 0,
      notDone: 0,
      lockTimeouts: 0,
      failed: 0,
      newFailures: 0,
      deferred: 0,
      stepFailed: false,
      ...over,
    });
    logSweepTick(logger, [step({})], Date.now());
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    logSweepTick(
      logger,
      [step({ candidates: 3, done: 2, failed: 1 })],
      Date.now(),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    logSweepTick(
      logger,
      [step({ candidates: 3, failed: 1, newFailures: 1 })],
      Date.now(),
    );
    logSweepTick(logger, [step({ stepFailed: true })], Date.now());
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
