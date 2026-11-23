import {
  isOpenNow,
  palestineDayAndMinute,
} from './branch-operating-hours.util';
import { openingState } from '../common/branch-opening.util';

// «ساعات العمل والإغلاقات v1»: Palestine time (Asia/Hebron), several
// periods a day, a temporary closure always winning, "open until" and
// "next opening".
describe('branch-operating-hours.util', () => {
  describe('palestineDayAndMinute', () => {
    it('applies the +2 winter offset', () => {
      const at = new Date('2026-01-15T10:00:00Z'); // Thursday 12:00 local
      const { dayOfWeek, minuteOfDay } = palestineDayAndMinute(at);
      expect(minuteOfDay).toBe(12 * 60);
      expect(dayOfWeek).toBe(at.getUTCDay());
    });

    it('applies the +3 summer offset', () => {
      const at = new Date('2026-07-15T10:00:00Z'); // 13:00 local
      expect(palestineDayAndMinute(at).minuteOfDay).toBe(13 * 60);
    });

    it('rolls the day over near a UTC day boundary', () => {
      const at = new Date('2026-01-14T22:30:00Z'); // Thursday 00:30 local
      const { dayOfWeek, minuteOfDay } = palestineDayAndMinute(at);
      expect(dayOfWeek).toBe((at.getUTCDay() + 1) % 7);
      expect(minuteOfDay).toBe(30);
    });
  });

  // Thursday 2026-01-15 (winter, UTC+2): 09:00-14:00 and 16:00-21:00
  const THU = 4;
  const twoPeriods = [
    { dayOfWeek: THU, openMinute: 9 * 60, closeMinute: 14 * 60 },
    { dayOfWeek: THU, openMinute: 16 * 60, closeMinute: 21 * 60 },
  ];
  const local = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00+02:00`);

  describe('isOpenNow', () => {
    it('two periods a day: open in each, closed in the gap, boundaries half-open', () => {
      expect(isOpenNow(twoPeriods, local('09:00'))).toBe(true);
      expect(isOpenNow(twoPeriods, local('13:59'))).toBe(true);
      expect(isOpenNow(twoPeriods, local('14:00'))).toBe(false);
      expect(isOpenNow(twoPeriods, local('15:00'))).toBe(false);
      expect(isOpenNow(twoPeriods, local('16:00'))).toBe(true);
      expect(isOpenNow(twoPeriods, local('21:00'))).toBe(false);
      expect(isOpenNow([], local('12:00'))).toBe(false);
    });
  });

  describe('openingState', () => {
    it('open: until the end of the current period, then opens again at the next one', () => {
      expect(openingState(twoPeriods, [], local('10:00'))).toEqual({
        open_now: true,
        open_until: local('14:00').toISOString(),
        next_open_at: local('16:00').toISOString(),
      });
    });

    it('closed in the gap: the next opening is the afternoon period', () => {
      expect(openingState(twoPeriods, [], local('15:00'))).toMatchObject({
        open_now: false,
        open_until: null,
        next_open_at: local('16:00').toISOString(),
      });
    });

    it('after the last period: the next opening is next week (only Thursday has hours)', () => {
      const s = openingState(twoPeriods, [], local('22:00'));
      expect(s.open_now).toBe(false);
      expect(s.next_open_at).toBe(
        new Date('2026-01-22T09:00:00+02:00').toISOString(),
      );
    });

    it('a temporary closure always wins: it cuts the period and moves the next opening', () => {
      const closure = { startsAt: local('12:00'), endsAt: local('17:00') };
      expect(openingState(twoPeriods, [closure], local('10:00'))).toEqual({
        open_now: true,
        open_until: local('12:00').toISOString(),
        next_open_at: local('17:00').toISOString(),
      });
      expect(openingState(twoPeriods, [closure], local('13:00'))).toMatchObject(
        {
          open_now: false,
          next_open_at: local('17:00').toISOString(),
        },
      );
    });

    it('no hours set: unknown, not "closed"', () => {
      expect(openingState([], [], local('10:00'))).toEqual({
        open_now: null,
        open_until: null,
        next_open_at: null,
      });
    });

    it('24:00 then 00:00 the next day reads as one continuous opening', () => {
      const late = [
        { dayOfWeek: THU, openMinute: 18 * 60, closeMinute: 24 * 60 },
        { dayOfWeek: 5, openMinute: 0, closeMinute: 2 * 60 },
      ];
      expect(openingState(late, [], local('23:00'))).toMatchObject({
        open_now: true,
        open_until: new Date('2026-01-16T02:00:00+02:00').toISOString(),
      });
    });
  });
});
