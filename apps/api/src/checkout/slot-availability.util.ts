import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { calendarDates, isWindowOpen } from './delivery-calendar.util';

export interface SlotOption {
  deliveryWindowId: string;
  date: string; // 'YYYY-MM-DD'
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  remainingCapacity: number;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * PDR-023: "the customer picks an available branch calendar slot in
 * the next three days." A live, read-only snapshot - NOT a hold (see
 * CheckoutReservationSlot's own comment for where the real atomic hold
 * happens, under a row lock, at actual reserve time).
 * PD-5.1: the three days are Palestine calendar days, and a window is
 * listed only while it hasn't started and is at least the branch's
 * deliveryLeadMinutes away (delivery-calendar.util.ts) - the same rule
 * reserve() and reschedule enforce.
 */
export async function computeAvailableSlots(
  prisma: PrismaService,
  vendorId: string,
  branchId: string,
  now: Date = new Date(),
  days = 3,
): Promise<SlotOption[]> {
  const [windows, branch] = await Promise.all([
    prisma.deliveryWindow.findMany({
      where: { vendorId, branchId },
      include: { exceptions: true },
    }),
    prisma.storeBranch.findUnique({
      where: { id: branchId },
      select: { deliveryLeadMinutes: true },
    }),
  ]);
  if (windows.length === 0) return [];
  const leadMinutes = branch?.deliveryLeadMinutes ?? 0;

  const dates = calendarDates(now, days);

  const windowIds = windows.map((w) => w.id);
  const [activeReservationSlots, activeOrders] = await Promise.all([
    prisma.checkoutReservationSlot.findMany({
      where: {
        deliveryWindowId: { in: windowIds },
        scheduledDate: { in: dates },
        reservation: { expiresAt: { gt: now } },
      },
      select: { deliveryWindowId: true, scheduledDate: true },
    }),
    prisma.branchOrder.findMany({
      where: {
        deliveryWindowId: { in: windowIds },
        scheduledDate: { in: dates },
        status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
      },
      select: { deliveryWindowId: true, scheduledDate: true },
    }),
  ]);

  function consumedCount(windowId: string, date: Date): number {
    const dateKey = toDateString(date);
    const reservedCount = activeReservationSlots.filter(
      (s) =>
        s.deliveryWindowId === windowId &&
        toDateString(s.scheduledDate) === dateKey,
    ).length;
    const orderedCount = activeOrders.filter(
      (o) =>
        o.deliveryWindowId === windowId &&
        o.scheduledDate &&
        toDateString(o.scheduledDate) === dateKey,
    ).length;
    return reservedCount + orderedCount;
  }

  const options: SlotOption[] = [];
  for (const date of dates) {
    const dayOfWeek = date.getUTCDay();
    for (const window of windows) {
      if (window.dayOfWeek !== dayOfWeek) continue;
      if (!isWindowOpen(date, window.startMinute, now, leadMinutes)) continue;
      const exception = window.exceptions.find(
        (e) => toDateString(e.exceptionDate) === toDateString(date),
      );
      if (exception?.isClosed) continue;
      const effectiveCapacity = exception?.capacityOverride ?? window.capacity;
      const remaining = effectiveCapacity - consumedCount(window.id, date);
      if (remaining > 0) {
        options.push({
          deliveryWindowId: window.id,
          date: toDateString(date),
          dayOfWeek,
          startTime: minutesToTime(window.startMinute),
          endTime: minutesToTime(window.endMinute),
          remainingCapacity: remaining,
        });
      }
    }
  }

  return options.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );
}
