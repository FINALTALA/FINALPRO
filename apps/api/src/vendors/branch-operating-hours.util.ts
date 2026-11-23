import { openingState, type HoursRow } from '../common/branch-opening.util';

// «ساعات العمل والإغلاقات v1»: the weekly hours are Palestine wall-clock
// minutes (Asia/Hebron - the SAME calendar the delivery windows use; the
// earlier Asia/Jerusalem reading could disagree for a few days a year when
// the two zones change clocks on different dates). A day may have several
// periods. Informational only: never read by checkout/reserve to refuse
// anything - see common/branch-opening.util.ts ("open now", "open until",
// "next opening", a temporary closure always winning).

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Hebron',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Day-of-week (0=Sun..6=Sat) and minute-of-day of one instant, in Palestine time. */
export function palestineDayAndMinute(at: Date): {
  dayOfWeek: number;
  minuteOfDay: number;
} {
  const parts = PARTS.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')!.value;
  // Intl may render local midnight as hour "24" while the weekday has
  // already rolled over - % 24 brings it back to 0.
  const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return { dayOfWeek: WEEKDAY[weekday], minuteOfDay: hour * 60 + minute };
}

/** Open at `at` by the weekly template alone (no closures). */
export function isOpenNow(hours: HoursRow[], at: Date = new Date()): boolean {
  return openingState(hours, [], at).open_now === true;
}
