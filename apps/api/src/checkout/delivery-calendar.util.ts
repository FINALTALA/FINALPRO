/**
 * PD-5.1: the delivery calendar in Palestine time. One rule, shared by
 * the slot list (product page, comparison, cart, checkout quote) and by
 * reserve/reschedule, so nothing can offer a window the other refuses:
 *   - "today" is today in Asia/Hebron, not in UTC (00:00-02:59 local
 *     used to still be yesterday);
 *   - a window is bookable only while its start is in the future AND at
 *     least the branch's own preparation time (deliveryLeadMinutes)
 *     away. A window that already started is never offered.
 * Pure functions - `now` is always passed in, so tests pin the clock.
 */
export const DELIVERY_TIME_ZONE = 'Asia/Hebron';
export const MAX_DELIVERY_LEAD_MINUTES = 2880;

const DAY_MS = 86_400_000;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DELIVERY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function localParts(instant: Date) {
  const p = Object.fromEntries(
    partsFormatter.formatToParts(instant).map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of Palestine time from UTC at that instant, in ms (+2h / +3h). */
function offsetMs(instant: Date): number {
  const p = localParts(instant);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Today's date in Palestine, 'YYYY-MM-DD'. */
export function localDateString(now: Date): string {
  const p = localParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' as the UTC-midnight Date a @db.Date column stores. */
export function dateOnly(dateString: string): Date {
  return new Date(`${dateString}T00:00:00.000Z`);
}

/** The calendar days a customer may book: today (local) and the next days. */
export function calendarDates(now: Date, days = 3): Date[] {
  const first = dateOnly(localDateString(now)).getTime();
  return Array.from({ length: days }, (_, i) => new Date(first + i * DAY_MS));
}

/** Whole days from today (local) to that date; negative = in the past. */
export function daysFromToday(date: Date, now: Date): number {
  return Math.round(
    (date.getTime() - dateOnly(localDateString(now)).getTime()) / DAY_MS,
  );
}

/** The real instant a window starts: local date + minute in Palestine. */
export function windowStartInstant(date: Date, startMinute: number): Date {
  const guess = date.getTime() + startMinute * 60_000;
  // Local wall time -> UTC; re-check the offset at the result for a DST day.
  let utc = guess - offsetMs(new Date(guess));
  utc = guess - offsetMs(new Date(utc));
  return new Date(utc);
}

/**
 * Bookable: the window hasn't started and is at least `leadMinutes`
 * away (0 = only "not started yet").
 */
export function isWindowOpen(
  date: Date,
  startMinute: number,
  now: Date,
  leadMinutes: number,
): boolean {
  const msUntilStart =
    windowStartInstant(date, startMinute).getTime() - now.getTime();
  return msUntilStart > 0 && msUntilStart >= Math.max(0, leadMinutes) * 60_000;
}
