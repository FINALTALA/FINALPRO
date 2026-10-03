// Sprint 18b (FR-VEND-006/FR-VPORTAL-009, informational only - product
// decision): openMinute/closeMinute/dayOfWeek are interpreted as
// Asia/Jerusalem wall-clock time, DST-aware. No existing column or
// utility in this codebase is timezone-aware (every other DateTime is
// stored and reasoned about as naive/UTC) - this is deliberately the
// first. Node's built-in Intl carries the IANA tz database already,
// so Asia/Jerusalem's own DST transitions are handled correctly with
// no manual offset arithmetic and no new dependency.
//
// Never read by checkout/reserve - this only ever backs a display
// ("open now"/"closed now"); BranchClosure alone gates new orders.

const JERUSALEM_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jerusalem',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY_TO_DAY_OF_WEEK: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Day-of-week (0=Sun..6=Sat) and minute-of-day, both derived from the
 * SAME Asia/Jerusalem-localized instant - never a UTC day-of-week
 * paired with a locally-interpreted minute, which would silently
 * disagree near midnight whenever Jerusalem's offset isn't a whole
 * day away from UTC's own date boundary. */
export function jerusalemDayAndMinute(at: Date): {
  dayOfWeek: number;
  minuteOfDay: number;
} {
  const parts = JERUSALEM_PARTS_FORMAT.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')!.value;
  // Node's Intl, with hour12: false, represents local midnight as hour
  // "24" (not "00") while the weekday part has already correctly
  // rolled over to the next day - `% 24` normalizes that back to 0
  // without which minuteOfDay would read 1440-1499 for the first hour
  // of a day instead of 0-59.
  const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return {
    dayOfWeek: WEEKDAY_TO_DAY_OF_WEEK[weekday],
    minuteOfDay: hour * 60 + minute,
  };
}

export function isOpenNow(
  hours: { dayOfWeek: number; openMinute: number; closeMinute: number }[],
  at: Date = new Date(),
): boolean {
  const { dayOfWeek, minuteOfDay } = jerusalemDayAndMinute(at);
  return hours.some(
    (h) =>
      h.dayOfWeek === dayOfWeek &&
      minuteOfDay >= h.openMinute &&
      minuteOfDay < h.closeMinute,
  );
}
