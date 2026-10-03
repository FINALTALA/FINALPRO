import {
  isOpenNow,
  jerusalemDayAndMinute,
} from './branch-operating-hours.util';

describe('branch-operating-hours.util', () => {
  describe('jerusalemDayAndMinute', () => {
    it('applies the +2 winter (standard time) offset correctly', () => {
      // 2026-01-15T10:00:00Z - Israel Standard Time is UTC+2 in January,
      // so Jerusalem local time is 12:00.
      const at = new Date('2026-01-15T10:00:00Z');
      const { dayOfWeek, minuteOfDay } = jerusalemDayAndMinute(at);
      expect(minuteOfDay).toBe(12 * 60);
      // 10:00 UTC + 2h never crosses midnight, so the local weekday
      // matches the UTC weekday for this instant.
      expect(dayOfWeek).toBe(at.getUTCDay());
    });

    it('applies the +3 summer (daylight saving) offset correctly - the whole point of using Intl/IANA tz data instead of a fixed offset', () => {
      // 2026-07-15T10:00:00Z - Israel Daylight Time is UTC+3 in July,
      // so Jerusalem local time is 13:00.
      const at = new Date('2026-07-15T10:00:00Z');
      const { dayOfWeek, minuteOfDay } = jerusalemDayAndMinute(at);
      expect(minuteOfDay).toBe(13 * 60);
      expect(dayOfWeek).toBe(at.getUTCDay());
    });

    it('derives day-of-week and minute-of-day from the SAME localized instant near a UTC day boundary', () => {
      // 2026-01-14T22:30:00Z (Wednesday) + 2h winter offset = Thursday
      // 00:30 local - a UTC-day-of-week paired with a locally-
      // interpreted minute would wrongly report Wednesday 22:30 + 120
      // minutes without rolling the day over; this must roll over.
      const at = new Date('2026-01-14T22:30:00Z');
      const { dayOfWeek, minuteOfDay } = jerusalemDayAndMinute(at);
      expect(dayOfWeek).toBe((at.getUTCDay() + 1) % 7);
      expect(minuteOfDay).toBe(30);
    });
  });

  describe('isOpenNow', () => {
    const hours = [{ dayOfWeek: 4, openMinute: 9 * 60, closeMinute: 17 * 60 }];

    it('true at the exact open boundary (inclusive)', () => {
      // Matches the first jerusalemDayAndMinute test's own instant:
      // Thursday 12:00 Jerusalem time - well inside 09:00-17:00.
      expect(isOpenNow(hours, new Date('2026-01-15T10:00:00Z'))).toBe(true);
    });

    it('false just before opening and at/after closing', () => {
      const dayOfWeek = jerusalemDayAndMinute(
        new Date('2026-01-15T10:00:00Z'),
      ).dayOfWeek;
      expect(
        isOpenNow(
          [{ dayOfWeek, openMinute: 9 * 60, closeMinute: 17 * 60 }],
          new Date('2026-01-15T05:00:00Z'), // 07:00 local, winter
        ),
      ).toBe(false);
      expect(
        isOpenNow(
          [{ dayOfWeek, openMinute: 9 * 60, closeMinute: 17 * 60 }],
          new Date('2026-01-15T15:00:00Z'), // 17:00 local exactly, winter
        ),
      ).toBe(false);
    });

    it('false on a day with no matching entry (closed that day)', () => {
      expect(isOpenNow([], new Date('2026-01-15T10:00:00Z'))).toBe(false);
    });
  });
});
