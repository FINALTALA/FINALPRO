/**
 * TB-13: unique `+999` test phones for API e2e specs that insert users
 * directly (no OTP, so no lane in e2e-phone-lanes.ts - those lanes are full).
 *
 * Format: +999 WW SSSSS CCCCC  (15 digits, the E.164 maximum)
 *   WW    - JEST_WORKER_ID, 2 digits ("00" when not under Jest: one process)
 *   SSSSS - this worker process's start second, mod 100000
 *   CCCCC - a counter shared by every spec file the worker runs
 * +999 is not an assigned country code, so these are never real numbers.
 *
 * Within one run, two numbers can never be equal - by construction, not by
 * chance: different workers differ in WW, and inside a worker the counter
 * only ever increases. Jest gives each spec file a fresh module registry,
 * so a module-level counter would restart in every file; the counter lives
 * instead on Node's `os` module object, which Jest does not re-create per
 * file, so it is one counter per worker process.
 * SSSSS only keeps re-runs against a reused (still disposable) database
 * apart; the official runner uses a new database for every run anyway.
 */
import * as os from 'os';

const STORE_KEY = Symbol.for('finalpro.test-phone.worker-state');
const COUNTER_LIMIT = 100_000;

export interface TestPhoneState {
  worker: string;
  stamp: string;
  next: number;
}

/** The pure part: fixed-width fields, so different inputs can never produce the same string. */
export function formatTestPhone(
  worker: string,
  stamp: string,
  n: number,
): string {
  if (!/^\d{2}$/.test(worker))
    throw new Error(`test-phone: worker "${worker}" must be 2 digits`);
  if (!/^\d{5}$/.test(stamp))
    throw new Error(`test-phone: stamp "${stamp}" must be 5 digits`);
  if (!Number.isInteger(n) || n < 1 || n >= COUNTER_LIMIT) {
    throw new Error(
      `test-phone: counter ${n} is outside 1..${COUNTER_LIMIT - 1} - this worker ran out of numbers`,
    );
  }
  return `+999${worker}${stamp}${String(n).padStart(5, '0')}`;
}

/** "00" outside Jest (a single process); otherwise the Jest worker id, 2 digits. */
export function workerField(jestWorkerId: string | undefined): string {
  if (jestWorkerId === undefined || jestWorkerId === '') return '00';
  if (
    !/^\d+$/.test(jestWorkerId) ||
    Number(jestWorkerId) < 1 ||
    Number(jestWorkerId) > 99
  ) {
    throw new Error(
      `test-phone: JEST_WORKER_ID "${jestWorkerId}" is not 1..99`,
    );
  }
  return jestWorkerId.padStart(2, '0');
}

export function newTestPhoneState(
  jestWorkerId: string | undefined,
  nowMs: number,
): TestPhoneState {
  return {
    worker: workerField(jestWorkerId),
    stamp: String(Math.floor(nowMs / 1000) % 100_000).padStart(5, '0'),
    next: 1,
  };
}

export function nextTestPhone(state: TestPhoneState): string {
  const phone = formatTestPhone(state.worker, state.stamp, state.next);
  state.next += 1;
  return phone;
}

/** The worker-wide state (created on first use in this worker process). */
export function workerTestPhoneState(): TestPhoneState {
  const holder = os as unknown as Record<symbol, TestPhoneState | undefined>;
  let state = holder[STORE_KEY];
  if (!state) {
    state = newTestPhoneState(process.env.JEST_WORKER_ID, Date.now());
    Object.defineProperty(holder, STORE_KEY, {
      value: state,
      enumerable: false,
    });
  }
  return state;
}

/** A test phone unique within this run across all workers and spec files. */
export function uniqueTestPhone(): string {
  return nextTestPhone(workerTestPhoneState());
}
