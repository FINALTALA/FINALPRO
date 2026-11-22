// TB-13: the shared +999 test-phone helper never produces the same number
// twice in one run - across workers, across spec files in one worker, and
// across many calls. Pure checks: no database or app needed.
import {
  formatTestPhone,
  newTestPhoneState,
  nextTestPhone,
  uniqueTestPhone,
  workerField,
  workerTestPhoneState,
} from './helpers/test-phone';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const FORMAT = /^\+999\d{12}$/;

describe('TB-13 unique test phone (+999)', () => {
  it('two different workers never produce the same number, even at the same second and counter', () => {
    const a = newTestPhoneState('1', NOW);
    const b = newTestPhoneState('2', NOW);
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      seen.add(nextTestPhone(a));
      seen.add(nextTestPhone(b));
    }
    expect(seen.size).toBe(40_000);
  });

  it('many calls inside one worker never repeat, and running out fails loudly instead of wrapping', () => {
    const s = newTestPhoneState('3', NOW);
    const seen = new Set<string>();
    for (let i = 1; i < 100_000; i += 1) seen.add(nextTestPhone(s));
    expect(seen.size).toBe(99_999);
    expect(() => nextTestPhone(s)).toThrow(/ran out of numbers/);
  });

  it('fixed-width fields: worker 1 / counter 11 and worker 11 / counter 1 are different numbers', () => {
    expect(formatTestPhone('01', '12345', 11)).not.toBe(
      formatTestPhone('11', '12345', 1),
    );
    expect(formatTestPhone('01', '12345', 11)).toBe('+999011234500011');
  });

  it('every number is a short, well-formed +999 number (15 digits, the E.164 maximum)', () => {
    const s = newTestPhoneState('7', NOW);
    for (let i = 0; i < 100; i += 1) expect(nextTestPhone(s)).toMatch(FORMAT);
    expect(uniqueTestPhone()).toMatch(FORMAT);
  });

  it('outside Jest workers the safe fallback is worker "00", which no Jest worker uses', () => {
    expect(workerField(undefined)).toBe('00');
    expect(workerField('')).toBe('00');
    expect(workerField('1')).toBe('01');
    expect(workerField('42')).toBe('42');
    for (const bad of ['0', '100', 'x', '-1'])
      expect(() => workerField(bad)).toThrow(/not 1\.\.99/);
  });

  it('the counter is shared by every spec file in a worker: a fresh module registry continues it', () => {
    const first = uniqueTestPhone();
    let fromOtherFile = '';
    let otherState: unknown;
    // What Jest does between spec files in one worker: a new module registry.
    jest.isolateModules(() => {
      const fresh =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./helpers/test-phone') as typeof import('./helpers/test-phone');
      fromOtherFile = fresh.uniqueTestPhone();
      otherState = fresh.workerTestPhoneState();
    });
    expect(otherState).toBe(workerTestPhoneState());
    expect(fromOtherFile).not.toBe(first);
    expect(Number(fromOtherFile.slice(-5))).toBe(Number(first.slice(-5)) + 1);
    expect(fromOtherFile.slice(4, 6)).toBe(
      workerField(process.env.JEST_WORKER_ID),
    );
  });
});
