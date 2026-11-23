import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  isWindowOpen,
  windowStartInstant,
} from '../checkout/delivery-calendar.util';
import { activeOrderStatusFilter } from '../orders/branch-order-state-machine';

/**
 * «نوافذ التوصيل v1»: the ONE place that decides what a delivery window
 * is on one date. The shopper's slot list, reserve, confirm, reschedule
 * and the branch's 7-day board all read it, so they can never disagree.
 *
 * Priority (the first that applies wins):
 *   PAST            the window has ended
 *   CLOSED          the date is closed for this window, or a planned
 *                   branch closure overlaps the window's time
 *   PAUSED          the weekly window is paused by the owner
 *   BOOKING_STOPPED new bookings are stopped for this date (orders stay)
 *   CUTOFF_PASSED   it started, or is closer than the branch's lead time
 *   FULL            active orders + live holds reach the capacity
 *   OPEN            bookable
 * All times are Palestine time (delivery-calendar.util.ts); a window never
 * crosses midnight (end <= 24:00 of its own day).
 */
export const WINDOW_STATUSES = [
  'PAST',
  'CLOSED',
  'PAUSED',
  'BOOKING_STOPPED',
  'CUTOFF_PASSED',
  'FULL',
  'OPEN',
] as const;
export type WindowStatus = (typeof WINDOW_STATUSES)[number];

/** Why a date is CLOSED / BOOKING_STOPPED for a window. */
export type ClosedSource = 'DATE' | 'BRANCH_CLOSURE';

export interface SlotFacts {
  date: Date; // UTC-midnight of the Palestine calendar day
  window: {
    startMinute: number;
    endMinute: number;
    capacity: number;
    pausedAt: Date | null;
    pausedReason: string | null;
  };
  exception: {
    isClosed: boolean;
    bookingStopped: boolean;
    capacityOverride: number | null;
    reason: string | null;
  } | null;
  /** planned/active branch closures (any; overlap is checked here) */
  closures: { startsAt: Date; endsAt: Date; reason: string | null }[];
  activeOrders: number;
  activeHolds: number;
  leadMinutes: number;
  now: Date;
}

export interface SlotStatusResult {
  status: WindowStatus;
  reason: string | null;
  closedSource: ClosedSource | null;
  capacity: number;
  remaining: number;
  startsAt: Date;
  endsAt: Date;
  /** the last instant a booking is accepted (start - lead time) */
  bookingDeadline: Date;
}

/** Pure: one window on one date. */
export function slotStatus(f: SlotFacts): SlotStatusResult {
  const startsAt = windowStartInstant(f.date, f.window.startMinute);
  const endsAt = windowStartInstant(f.date, f.window.endMinute);
  const bookingDeadline = new Date(
    startsAt.getTime() - Math.max(0, f.leadMinutes) * 60_000,
  );
  const capacity = f.exception?.capacityOverride ?? f.window.capacity;
  const remaining = Math.max(0, capacity - f.activeOrders - f.activeHolds);
  const base = { capacity, remaining, startsAt, endsAt, bookingDeadline };
  const at = (
    status: WindowStatus,
    reason: string | null = null,
    closedSource: ClosedSource | null = null,
  ): SlotStatusResult => ({ status, reason, closedSource, ...base });

  if (endsAt.getTime() <= f.now.getTime()) return at('PAST');
  const closure = f.closures.find(
    (c) =>
      c.startsAt.getTime() < endsAt.getTime() &&
      c.endsAt.getTime() > startsAt.getTime(),
  );
  if (closure) return at('CLOSED', closure.reason, 'BRANCH_CLOSURE');
  if (f.exception?.isClosed) return at('CLOSED', f.exception.reason, 'DATE');
  if (f.window.pausedAt) return at('PAUSED', f.window.pausedReason);
  if (f.exception?.bookingStopped)
    return at('BOOKING_STOPPED', f.exception.reason, 'DATE');
  if (!isWindowOpen(f.date, f.window.startMinute, f.now, f.leadMinutes))
    return at('CUTOFF_PASSED');
  if (remaining <= 0) return at('FULL');
  return at('OPEN');
}

export interface SlotState extends SlotStatusResult {
  windowId: string;
  date: string; // 'YYYY-MM-DD'
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  windowCapacity: number;
  paused: boolean;
  activeOrders: number;
  activeHolds: number;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Loads every (window, date) state of one branch for the given dates -
 * paused windows included (callers that offer slots keep OPEN ones only).
 * `excludeReservationId`: confirm() re-checks its own hold's slot without
 * counting that hold twice; `excludeOrderId`: a reschedule never counts
 * the order being moved.
 */
export async function loadSlotStates(
  db: Prisma.TransactionClient,
  args: {
    vendorId: string;
    branchId: string;
    dates: Date[];
    now: Date;
    windowIds?: string[];
    excludeReservationId?: string;
    excludeOrderId?: string;
  },
): Promise<SlotState[]> {
  const { vendorId, branchId, dates, now } = args;
  if (dates.length === 0) return [];
  const windows = await db.deliveryWindow.findMany({
    where: {
      vendorId,
      branchId,
      ...(args.windowIds ? { id: { in: args.windowIds } } : {}),
    },
    include: { exceptions: { where: { exceptionDate: { in: dates } } } },
    orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
  });
  if (windows.length === 0) return [];
  const windowIds = windows.map((w) => w.id);
  const times = dates.map((d) => d.getTime());
  // A window ends by 24:00 of its own day; one day of margin either side
  // covers any Palestine-time offset.
  const rangeStart = new Date(Math.min(...times) - 86_400_000);
  const rangeEnd = new Date(Math.max(...times) + 2 * 86_400_000);
  const [branch, closures, orders, holds] = await Promise.all([
    db.storeBranch.findUnique({
      where: { id: branchId },
      select: { deliveryLeadMinutes: true },
    }),
    db.branchClosure.findMany({
      where: {
        vendorId,
        branchId,
        startsAt: { lt: rangeEnd },
        endsAt: { gt: rangeStart },
      },
      select: { startsAt: true, endsAt: true, reason: true },
    }),
    db.branchOrder.findMany({
      where: {
        vendorId,
        branchId,
        deliveryWindowId: { in: windowIds },
        scheduledDate: { in: dates },
        status: activeOrderStatusFilter(),
        ...(args.excludeOrderId ? { id: { not: args.excludeOrderId } } : {}),
      },
      select: { deliveryWindowId: true, scheduledDate: true },
    }),
    db.checkoutReservationSlot.findMany({
      where: {
        deliveryWindowId: { in: windowIds },
        scheduledDate: { in: dates },
        reservation: { expiresAt: { gt: now } },
        ...(args.excludeReservationId
          ? { reservationId: { not: args.excludeReservationId } }
          : {}),
      },
      select: { deliveryWindowId: true, scheduledDate: true },
    }),
  ]);
  const count = (
    rows: { deliveryWindowId: string | null; scheduledDate: Date | null }[],
  ) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.deliveryWindowId || !r.scheduledDate) continue;
      const k = `${r.deliveryWindowId}|${dateKey(r.scheduledDate)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const orderCounts = count(orders);
  const holdCounts = count(holds);
  const leadMinutes = branch?.deliveryLeadMinutes ?? 0;

  const states: SlotState[] = [];
  for (const date of dates) {
    const dow = date.getUTCDay();
    const key = dateKey(date);
    for (const w of windows) {
      if (w.dayOfWeek !== dow) continue;
      const exception =
        w.exceptions.find((e) => dateKey(e.exceptionDate) === key) ?? null;
      const activeOrders = orderCounts.get(`${w.id}|${key}`) ?? 0;
      const activeHolds = holdCounts.get(`${w.id}|${key}`) ?? 0;
      const result = slotStatus({
        date,
        window: w,
        exception,
        closures,
        activeOrders,
        activeHolds,
        leadMinutes,
        now,
      });
      states.push({
        ...result,
        windowId: w.id,
        date: key,
        dayOfWeek: dow,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
        windowCapacity: w.capacity,
        paused: w.pausedAt !== null,
        activeOrders,
        activeHolds,
      });
    }
  }
  return states;
}

/**
 * Throws the booking error for a slot that is not OPEN - the codes the
 * shopper's checkout already knows (SLOT_NO_LONGER_AVAILABLE, SLOT_CLOSED,
 * SLOT_CAPACITY_EXCEEDED), with the window state in `details`.
 */
export function assertSlotBookable(state: SlotState | undefined): void {
  if (state?.status === 'OPEN') return;
  const details = state
    ? [{ status: state.status, reason: state.reason }]
    : undefined;
  if (!state || state.status === 'PAST' || state.status === 'CUTOFF_PASSED') {
    throw new ConflictException({
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message:
        'This delivery window has started or is too close to prepare for - choose a later one',
      details,
    });
  }
  if (state.status === 'FULL') {
    throw new ConflictException({
      code: 'SLOT_CAPACITY_EXCEEDED',
      message: 'This slot is now fully booked - choose another',
      details,
    });
  }
  throw new ConflictException({
    code: 'SLOT_CLOSED',
    message: 'This delivery window is not taking bookings on this date',
    details,
  });
}
