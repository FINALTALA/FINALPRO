import {
  calendarDates,
  dateOnly,
  daysFromToday,
  isWindowOpen,
  localDateString,
  windowStartInstant,
} from './delivery-calendar.util';

// Palestine is UTC+2 in winter and UTC+3 in summer (DST).
const at = (iso: string) => new Date(iso);

describe('PD-5.1 delivery calendar (Asia/Hebron)', () => {
  it("today is Palestine's date, not UTC's", () => {
    // 23:30 UTC on 28 Oct (summer time, +3) is 02:30 on 29 Oct locally.
    expect(localDateString(at('2026-07-28T23:30:00Z'))).toBe('2026-07-29');
    // 21:59 UTC in winter (+2) is still 23:59 the same day.
    expect(localDateString(at('2026-12-01T21:59:00Z'))).toBe('2026-12-01');
    expect(localDateString(at('2026-12-01T22:00:00Z'))).toBe('2026-12-02');
  });

  it('the bookable calendar starts on the local day', () => {
    const days = calendarDates(at('2026-07-28T23:30:00Z'));
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    expect(
      daysFromToday(dateOnly('2026-07-29'), at('2026-07-28T23:30:00Z')),
    ).toBe(0);
    expect(
      daysFromToday(dateOnly('2026-07-28'), at('2026-07-28T23:30:00Z')),
    ).toBe(-1);
  });

  it('a window starts at its local wall time, through DST', () => {
    // 10:00 local in summer = 07:00 UTC; in winter = 08:00 UTC.
    expect(windowStartInstant(dateOnly('2026-07-29'), 600).toISOString()).toBe(
      '2026-07-29T07:00:00.000Z',
    );
    expect(windowStartInstant(dateOnly('2026-12-02'), 600).toISOString()).toBe(
      '2026-12-02T08:00:00.000Z',
    );
  });

  it('a window that already started is never bookable', () => {
    const now = at('2026-12-02T09:30:00Z'); // 11:30 local
    expect(isWindowOpen(dateOnly('2026-12-02'), 600, now, 0)).toBe(false); // 10:00
    expect(isWindowOpen(dateOnly('2026-12-02'), 690, now, 0)).toBe(false); // 11:30 exactly
    expect(isWindowOpen(dateOnly('2026-12-02'), 720, now, 0)).toBe(true); // 12:00
  });

  it("the branch's preparation time pushes the first bookable window out", () => {
    const now = at('2026-12-02T09:30:00Z'); // 11:30 local
    // 12:00 is 30 minutes away.
    expect(isWindowOpen(dateOnly('2026-12-02'), 720, now, 30)).toBe(true);
    expect(isWindowOpen(dateOnly('2026-12-02'), 720, now, 31)).toBe(false);
    // 2 days of preparation: tomorrow is gone, the day after at 12:00 is
    // 48h30m away.
    expect(isWindowOpen(dateOnly('2026-12-03'), 1380, now, 2880)).toBe(false);
    expect(isWindowOpen(dateOnly('2026-12-04'), 720, now, 2880)).toBe(true);
  });
});
