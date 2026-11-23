import { Prisma } from '../../generated/prisma/client';
import {
  localDateString,
  windowStartInstant,
} from '../checkout/delivery-calendar.util';

/**
 * «ساعات العمل والإغلاقات v1»: the ONE rule for "is this branch open, until
 * when, and when does it open next". Palestine time (Asia/Hebron, the same
 * calendar the delivery windows use). A temporary closure ALWAYS wins over
 * the weekly template. The hours are informational: they never block buying
 * or choosing pickup - they only tell the shopper when an order would be
 * prepared ("أقرب فتح"). A period never crosses midnight (close <= 24:00),
 * but a period ending 24:00 followed by one starting 00:00 the next day
 * reads as one continuous opening.
 */
export interface HoursRow {
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}
export interface ClosureSpan {
  startsAt: Date;
  endsAt: Date;
}
export interface OpeningState {
  /** null = the owner never set any hours (unknown, not "closed") */
  open_now: boolean | null;
  /** while open: when the current opening ends (a closure may cut it) */
  open_until: string | null;
  /** the next opening start after now (while open: after open_until) */
  next_open_at: string | null;
}

const DAY_MS = 86_400_000;
/** How far ahead "next opening" is searched (a long closure + a short week). */
export const OPENING_SEARCH_DAYS = 21;

type Span = { start: number; end: number };

/** Opening spans (ms) from the weekly template over [today - 1, today + days]. */
function templateSpans(hours: HoursRow[], now: Date, days: number): Span[] {
  const today = new Date(`${localDateString(now)}T00:00:00.000Z`).getTime();
  const spans: Span[] = [];
  for (let k = -1; k <= days; k += 1) {
    const date = new Date(today + k * DAY_MS);
    const dow = date.getUTCDay();
    for (const h of hours) {
      if (h.dayOfWeek !== dow) continue;
      spans.push({
        start: windowStartInstant(date, h.openMinute).getTime(),
        end: windowStartInstant(date, h.closeMinute).getTime(),
      });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  // merge touching / overlapping spans (24:00 then 00:00 the next day)
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** spans minus closures (a closure always wins). */
function subtract(spans: Span[], closures: ClosureSpan[]): Span[] {
  let out = spans;
  for (const c of closures) {
    const cs = c.startsAt.getTime();
    const ce = c.endsAt.getTime();
    const next: Span[] = [];
    for (const s of out) {
      if (ce <= s.start || cs >= s.end) {
        next.push(s);
        continue;
      }
      if (cs > s.start) next.push({ start: s.start, end: cs });
      if (ce < s.end) next.push({ start: ce, end: s.end });
    }
    out = next;
  }
  return out;
}

/** Pure: the opening state of one branch at `now`. */
export function openingState(
  hours: HoursRow[],
  closures: ClosureSpan[],
  now: Date = new Date(),
  days = OPENING_SEARCH_DAYS,
): OpeningState {
  if (hours.length === 0)
    return { open_now: null, open_until: null, next_open_at: null };
  const t = now.getTime();
  const spans = subtract(templateSpans(hours, now, days), closures);
  const current = spans.find((s) => s.start <= t && t < s.end);
  const after = current ? current.end : t;
  const next = spans.find((s) => s.start > after) ?? null;
  return {
    open_now: Boolean(current),
    open_until: current ? new Date(current.end).toISOString() : null,
    next_open_at: next ? new Date(next.start).toISOString() : null,
  };
}

/** Today's periods (Palestine day) of a template, as "HH:MM" pairs. */
export function periodsOn(
  hours: HoursRow[],
  now: Date = new Date(),
): { open: string; close: string }[] {
  const dow = new Date(`${localDateString(now)}T00:00:00.000Z`).getUTCDay();
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return hours
    .filter((h) => h.dayOfWeek === dow)
    .sort((a, b) => a.openMinute - b.openMinute)
    .map((h) => ({ open: hhmm(h.openMinute), close: hhmm(h.closeMinute) }));
}

/** Loads the opening state of several branches (hours + closures that matter). */
export async function loadOpeningStates(
  db: Prisma.TransactionClient,
  branchIds: string[],
  now: Date = new Date(),
): Promise<
  Map<string, OpeningState & { today: { open: string; close: string }[] }>
> {
  const ids = [...new Set(branchIds)];
  const result = new Map<
    string,
    OpeningState & { today: { open: string; close: string }[] }
  >();
  if (ids.length === 0) return result;
  const until = new Date(now.getTime() + (OPENING_SEARCH_DAYS + 2) * DAY_MS);
  const [hours, closures] = await Promise.all([
    db.branchOperatingHours.findMany({
      where: { branchId: { in: ids } },
      select: {
        branchId: true,
        dayOfWeek: true,
        openMinute: true,
        closeMinute: true,
      },
    }),
    db.branchClosure.findMany({
      where: {
        branchId: { in: ids },
        endsAt: { gt: new Date(now.getTime() - DAY_MS) },
        startsAt: { lt: until },
      },
      select: { branchId: true, startsAt: true, endsAt: true },
    }),
  ]);
  for (const id of ids) {
    const h = hours.filter((r) => r.branchId === id);
    const c = closures.filter((r) => r.branchId === id);
    result.set(id, { ...openingState(h, c, now), today: periodsOn(h, now) });
  }
  return result;
}
