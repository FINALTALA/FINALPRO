import { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TB-11: failure isolation for the periodic sweeps (returns, fulfilment
 * exceptions, fulfilment reconciliation, discount activations) - the
 * same rules TB-9 and TB-8 gave their own sweeps, in one place:
 *
 *  - every item in its own transaction AND its own try/catch: one item's
 *    failure rolls back only that item and never stops the rest;
 *  - every step (sub-sweep) in its own try/catch: a failing step never
 *    stops the steps after it;
 *  - `SET LOCAL lock_timeout = '3s'` in each item's transaction: an item
 *    another path holds too long is skipped (retried next tick) instead
 *    of stalling the tick;
 *  - an item that fails is deferred in memory with a growing delay (1,
 *    2, 4, 8 then 10 minutes) and its id is EXCLUDED from the candidate
 *    query while deferred - so failing items, however many and however
 *    old, never fill the batch and keep a newer healthy item out. A
 *    restart forgets the deferrals; the items are simply tried again;
 *  - logs: the first failure of an item is logged once (id and error
 *    code only - never a phone, an address or order content), at most
 *    three such lines per step per tick; repeats and the rest are only
 *    counted; one summary line per tick, WARN only when an item failed
 *    for the first time or a step failed.
 */

export const SWEEP_LOCK_TIMEOUT = '3s';
export const SWEEP_BACKOFF_BASE_MS = 60_000;
export const SWEEP_BACKOFF_MAX_MS = 10 * 60_000;
const SWEEP_BACKOFF_MAX_ENTRIES = 5_000;
/** At most this many individual first-failure lines per step per tick; the rest are counted in the summary. */
export const SWEEP_MAX_FAILURE_LOGS_PER_STEP = 3;

export class SweepBackoff {
  private readonly entries = new Map<
    string,
    { failures: number; until: number }
  >();

  constructor(
    private readonly baseMs = SWEEP_BACKOFF_BASE_MS,
    private readonly maxMs = SWEEP_BACKOFF_MAX_MS,
    private readonly maxEntries = SWEEP_BACKOFF_MAX_ENTRIES,
  ) {}

  /** Ids whose deferral has not run out yet - excluded from the next candidate query. */
  deferredIds(now = Date.now()): string[] {
    const ids: string[] = [];
    for (const [id, e] of this.entries) {
      if (e.until > now) ids.push(id);
      // Forget an item that has not failed again for a long time.
      else if (now - e.until > 2 * this.maxMs) this.entries.delete(id);
    }
    return ids;
  }

  /** Records a failure; `first` is true when the item was not already known as failing. */
  recordFailure(
    id: string,
    now = Date.now(),
  ): { first: boolean; delayMs: number } {
    const prev = this.entries.get(id);
    const failures = (prev?.failures ?? 0) + 1;
    const delayMs = Math.min(this.baseMs * 2 ** (failures - 1), this.maxMs);
    if (!prev && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(id); // re-insert: Map order = least recently failed first
    this.entries.set(id, { failures, until: now + delayMs });
    return { first: !prev, delayMs };
  }

  recordSuccess(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface SweepStepResult {
  step: string;
  candidates: number;
  /** The item's action was carried out. */
  done: number;
  /** Nothing to do any more (state changed, or another instance holds it - SKIP LOCKED). */
  notDone: number;
  /** Its transaction hit the 3 s lock_timeout - retried next tick, not deferred. */
  lockTimeouts: number;
  failed: number;
  /** Failures of items not already known as failing (logged once each). */
  newFailures: number;
  /** Ids left out of this step's candidate query because they are deferred. */
  deferred: number;
  /** The step itself (its candidate query) failed. */
  stepFailed: boolean;
}

/** Postgres 55P03 (lock_not_available) - the transaction's own lock_timeout fired. */
export function isLockTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (v: unknown): boolean => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    const rec = v as Record<string, unknown>;
    for (const key of ['code', 'message']) {
      const s = rec[key];
      if (typeof s === 'string' && (s === '55P03' || /lock timeout/i.test(s))) {
        return true;
      }
    }
    return ['meta', 'cause', 'driverAdapterError', 'originalError'].some((k) =>
      visit(rec[k]),
    );
  };
  return visit(err);
}

/** A short, data-free description of an error for the logs: its name and code only. */
export function errorTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const code = typeof e?.code === 'string' ? ` ${e.code}` : '';
  return `${name}${code}`;
}

/** An item's own transaction, with this sweep's lock_timeout. */
export function sweepTransaction<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL lock_timeout = '${SWEEP_LOCK_TIMEOUT}'`,
    );
    return fn(tx);
  });
}

/**
 * Runs one step: finds its candidates (never the deferred ids), then
 * each item in isolation. Never throws.
 */
export async function runSweepStep(opts: {
  step: string;
  logger: Logger;
  backoff: SweepBackoff;
  findCandidates: (excludedIds: string[]) => Promise<string[]>;
  /** Runs one item in its own transaction; true when its action was carried out. */
  processItem: (id: string) => Promise<boolean>;
}): Promise<SweepStepResult> {
  const result: SweepStepResult = {
    step: opts.step,
    candidates: 0,
    done: 0,
    notDone: 0,
    lockTimeouts: 0,
    failed: 0,
    newFailures: 0,
    deferred: 0,
    stepFailed: false,
  };
  let ids: string[];
  try {
    const excluded = opts.backoff.deferredIds();
    result.deferred = excluded.length;
    ids = await opts.findCandidates(excluded);
  } catch (err) {
    result.stepFailed = true;
    opts.logger.error(
      `${opts.step}: finding candidates failed (${errorTag(err)})`,
      (err as Error)?.stack,
    );
    return result;
  }
  result.candidates = ids.length;
  for (const id of ids) {
    try {
      const done = await opts.processItem(id);
      if (done) result.done += 1;
      else result.notDone += 1;
      opts.backoff.recordSuccess(id);
    } catch (err) {
      if (isLockTimeout(err)) {
        result.lockTimeouts += 1;
        continue;
      }
      result.failed += 1;
      const { first, delayMs } = opts.backoff.recordFailure(id);
      if (first) {
        result.newFailures += 1;
        if (result.newFailures > SWEEP_MAX_FAILURE_LOGS_PER_STEP) continue;
        opts.logger.error(
          `${opts.step}: item ${id} failed (${errorTag(err)}) - rolled back, retried in ${Math.round(delayMs / 1000)} s`,
          (err as Error)?.stack,
        );
      }
    }
  }
  return result;
}

/** One structured summary line per tick - LOG normally, WARN on a new item failure or a failed step. */
export function logSweepTick(
  logger: Logger,
  steps: SweepStepResult[],
  startedAt: number,
): void {
  const busy = steps.some(
    (s) =>
      s.candidates > 0 || s.failed > 0 || s.stepFailed || s.lockTimeouts > 0,
  );
  if (!busy) return;
  const parts = steps.map(
    (s) =>
      `${s.step} ${s.stepFailed ? 'STEP FAILED' : `${s.done}/${s.candidates} done, ${s.failed} failed (${s.newFailures} new), ${s.lockTimeouts} lock timeouts, ${s.notDone} not due/held, ${s.deferred} deferred`}`,
  );
  const line = `tick ${Date.now() - startedAt} ms: ${parts.join('; ')}`;
  if (steps.some((s) => s.newFailures > 0 || s.stepFailed)) logger.warn(line);
  else logger.log(line);
}
