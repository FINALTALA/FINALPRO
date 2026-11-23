import { apiFetch, newIdempotencyKey } from "./api";
import "./branchHoursText";

/**
 * «ساعات العمل والإغلاقات v1»: the branch's weekly opening hours (several
 * periods a day, 15-minute steps, never crossing midnight - 24:00 only as an
 * end) and its temporary closures. Palestine time (Asia/Hebron) everywhere.
 * Informational: hours never block buying or choosing pickup. The "open now /
 * until / next opening" state is always the SERVER's (one rule, closures
 * included) - this file only carries it and formats it.
 */

export const STEP = 15;
export const TZ = "Asia/Hebron";

export interface Period {
  open: number; // minute of day, 0..1425
  close: number; // minute of day, 15..1440
}
/** Sunday (0) .. Saturday (6) -> periods, sorted. */
export type Week = Period[][];

export interface OpeningState {
  open_now: boolean | null;
  open_until: string | null;
  next_open_at: string | null;
}
export interface Closure {
  id: string;
  branch_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}
interface HoursRow {
  day_of_week: number;
  open_minute: number;
  close_minute: number;
}

const base = (vendorId: string, branchId: string) => `/vendors/${vendorId}/branches/${branchId}`;

export const emptyWeek = (): Week => [[], [], [], [], [], [], []];

export function toWeek(rows: HoursRow[]): Week {
  const week = emptyWeek();
  for (const r of rows) week[r.day_of_week]?.push({ open: r.open_minute, close: r.close_minute });
  return week.map(sortPeriods);
}
export const sortPeriods = (ps: Period[]) => [...ps].sort((a, b) => a.open - b.open);

export function toRows(week: Week): HoursRow[] {
  return week.flatMap((ps, day) => ps.map((p) => ({ day_of_week: day, open_minute: p.open, close_minute: p.close })));
}

export const sameWeek = (a: Week, b: Week) => JSON.stringify(a.map(sortPeriods)) === JSON.stringify(b.map(sortPeriods));

export async function fetchHours(vendorId: string, branchId: string): Promise<{ week: Week; opening: OpeningState }> {
  const res = await apiFetch<{ hours: HoursRow[]; opening: OpeningState }>(`${base(vendorId, branchId)}/operating-hours`);
  return { week: toWeek(res.hours), opening: res.opening };
}

/** PUT replaces the whole week (the existing audited endpoint). */
export async function saveWeek(vendorId: string, branchId: string, week: Week): Promise<Week> {
  const res = await apiFetch<{ hours: HoursRow[] }>(`${base(vendorId, branchId)}/operating-hours`, {
    method: "PUT",
    body: { hours: toRows(week) },
  });
  return toWeek(res.hours);
}

export async function fetchClosures(vendorId: string, branchId: string): Promise<Closure[]> {
  const all: Closure[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const q: string = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : "?limit=50";
    const res: { items: Closure[]; next_cursor: string | null } = await apiFetch(`${base(vendorId, branchId)}/closures${q}`);
    all.push(...res.items);
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return all.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function createClosure(vendorId: string, branchId: string, startsAt: Date, endsAt: Date, reason: string) {
  return apiFetch<Closure>(`${base(vendorId, branchId)}/closures`, {
    method: "POST",
    body: { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    idempotencyKey: newIdempotencyKey("closure-add"),
  });
}
export function cancelClosure(vendorId: string, branchId: string, id: string, reason: string) {
  return apiFetch<Closure>(`${base(vendorId, branchId)}/closures/${id}/cancel`, { method: "POST", body: { reason } });
}
export function shortenClosure(vendorId: string, branchId: string, id: string, endsAt: Date, reason: string) {
  return apiFetch<Closure>(`${base(vendorId, branchId)}/closures/${id}/shorten`, {
    method: "POST",
    body: { ends_at: endsAt.toISOString(), reason },
  });
}

// ---- time helpers (Palestine wall clock)

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** A time range inside running text: isolated left-to-right, so "09:00–14:00" never flips in Arabic. */
export const isoRange = (p: Period) => `⁦${hhmm(p.open)}–${hhmm(p.close)}⁩`;
export const STARTS = Array.from({ length: 96 }, (_, i) => i * STEP);
export const ENDS = Array.from({ length: 96 }, (_, i) => (i + 1) * STEP);

/** A draft check before it is saved (the server re-checks; the DB is the guarantee). */
export function periodError(ps: Period[], p: Period, ignore = -1): "range" | "overlap" | null {
  if (p.open >= p.close) return "range";
  if (ps.some((q, i) => i !== ignore && p.open < q.close && q.open < p.close)) return "overlap";
  return null;
}

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Palestine wall clock of an instant. */
export function palestineParts(at: Date): { date: string; minute: number; dow: number } {
  const p = Object.fromEntries(PARTS.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, minute: hour * 60 + Number(p.minute), dow: WD[p.weekday] };
}

/** The instant of a Palestine wall-clock date + minute (minute may be 1440 = next midnight). */
export function palestineInstant(date: string, minute: number): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d) + minute * 60_000;
  let guess = wall - 2 * 3_600_000;
  for (let i = 0; i < 3; i += 1) {
    const p = palestineParts(new Date(guess));
    const [py, pm, pd] = p.date.split("-").map(Number);
    const seen = Date.UTC(py, pm - 1, pd) + p.minute * 60_000;
    guess += wall - seen;
  }
  return new Date(guess);
}

export const todayInPalestine = () => palestineParts(new Date()).date;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
