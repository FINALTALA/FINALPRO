import { BadRequestException } from '@nestjs/common';

/**
 * VIA phase 6 - scheduling in Asia/Hebron local time, stored as a UTC
 * instant. A local wall time can map to zero instants (the spring-forward
 * gap: refused) or two (the fall-back repeated hour: the caller must say
 * which - `earlier` or `later` - or it is refused as ambiguous).
 */

export const SCHEDULE_TIME_ZONE = 'Asia/Hebron';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The Asia/Hebron wall clock of a UTC instant, as 'YYYY-MM-DDTHH:MM'. */
export function localWall(at: Date): string {
  const p = Object.fromEntries(
    fmt.formatToParts(at).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function bad(code: string, message: string, details?: unknown): never {
  throw new BadRequestException({
    code,
    message,
    ...(details ? { details } : {}),
  });
}

/** Every UTC instant whose Asia/Hebron wall time is exactly `date time`. */
export function instantsFor(date: string, time: string): Date[] {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const target = `${date}T${time}`;
  const out: Date[] = [];
  // Asia/Hebron is UTC+2 or UTC+3; try both offsets (and keep exact matches).
  for (const offsetH of [3, 2]) {
    const at = new Date(wall - offsetH * 3600_000);
    if (
      localWall(at) === target &&
      !out.some((x) => x.getTime() === at.getTime())
    )
      out.push(at);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export function resolveLocalSchedule(
  date: unknown,
  time: unknown,
  occurrence: unknown,
  now = new Date(),
): { runAt: Date; local: string } {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    bad('SCHEDULE_INVALID', 'local_date must be YYYY-MM-DD');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    bad('SCHEDULE_INVALID', 'local_time must be HH:MM (24 h)');
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  )
    bad('SCHEDULE_INVALID', 'local_date is not a real date');
  const candidates = instantsFor(date, time);
  if (candidates.length === 0) {
    bad(
      'SCHEDULE_TIME_NONEXISTENT',
      `${date} ${time} does not exist in ${SCHEDULE_TIME_ZONE} (the clocks move forward) - choose another time`,
    );
  }
  let runAt = candidates[0];
  if (candidates.length > 1) {
    if (occurrence !== 'earlier' && occurrence !== 'later') {
      bad(
        'SCHEDULE_TIME_AMBIGUOUS',
        `${date} ${time} happens twice in ${SCHEDULE_TIME_ZONE} (the clocks move back) - choose the earlier or later occurrence`,
        candidates.map((c) => ({ utc: c.toISOString() })),
      );
    }
    runAt = occurrence === 'later' ? candidates[1] : candidates[0];
  }
  if (runAt.getTime() <= now.getTime())
    bad('SCHEDULE_IN_PAST', 'The scheduled time must be in the future');
  return { runAt, local: `${date} ${time}` };
}
