import { BadRequestException } from '@nestjs/common';

/**
 * VIA phase 4 - the reporting period. Timestamps are stored in UTC; reports
 * are read in local calendar days of Asia/Hebron. A filter `from..to` (both
 * YYYY-MM-DD, inclusive local days) becomes the half-open UTC interval
 * [local midnight of `from`, local midnight of the day after `to`) - DST
 * aware, so a 23- or 25-hour local day is still exactly one day. The
 * comparison period is the equal-length run of local days just before.
 */

export const REPORT_TIME_ZONE = 'Asia/Hebron';
export const MAX_REPORT_DAYS = 366;
export const DEFAULT_REPORT_DAYS = 30;

export interface ReportPeriod {
  from: string;
  to: string;
  days: number;
  start: Date;
  end: Date;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** How far Asia/Hebron is ahead of UTC at this instant, in ms. */
function offsetMs(at: Date): number {
  const p = Object.fromEntries(
    parts.formatToParts(at).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight starting this Asia/Hebron day. */
export function localMidnightUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Two passes settle the offset across a DST change.
  let t = wall - offsetMs(new Date(wall));
  t = wall - offsetMs(new Date(t));
  return new Date(t);
}

/** Today's local date in Asia/Hebron. */
export function localToday(now = new Date()): string {
  const p = Object.fromEntries(
    parts.formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Calendar days from..to inclusive (pure date arithmetic, no time zone). */
function daysBetween(from: string, to: string): number {
  const utc = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000) + 1;
}

function bad(message: string): never {
  throw new BadRequestException({ code: 'INVALID_PERIOD', message });
}

function validDate(ymd: string): boolean {
  if (!YMD.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
}

export function periodOf(from: string, to: string): ReportPeriod {
  return {
    from,
    to,
    days: daysBetween(from, to),
    start: localMidnightUtc(from),
    end: localMidnightUtc(addDays(to, 1)),
  };
}

/** The requested period (default: the last 30 local days to today) and the one before it. */
export function parsePeriod(
  fromRaw?: string,
  toRaw?: string,
  now = new Date(),
): { current: ReportPeriod; previous: ReportPeriod } {
  const to = toRaw?.trim() || localToday(now);
  const from = fromRaw?.trim() || addDays(to, -(DEFAULT_REPORT_DAYS - 1));
  if (!validDate(from)) bad('from must be a date YYYY-MM-DD');
  if (!validDate(to)) bad('to must be a date YYYY-MM-DD');
  const days = daysBetween(from, to);
  if (days < 1) bad('from must not be after to');
  if (days > MAX_REPORT_DAYS)
    bad(`A period is at most ${MAX_REPORT_DAYS} days`);
  return {
    current: periodOf(from, to),
    previous: periodOf(addDays(from, -days), addDays(from, -1)),
  };
}
