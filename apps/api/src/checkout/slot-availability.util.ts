import { PrismaService } from '../prisma/prisma.service';
import { loadSlotStates } from '../delivery-windows/window-status';
import { BOOKING_HORIZON_DAYS, calendarDates } from './delivery-calendar.util';

export interface SlotOption {
  deliveryWindowId: string;
  date: string; // 'YYYY-MM-DD'
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  remainingCapacity: number;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * PDR-023: the customer picks an available branch calendar slot. A live,
 * read-only snapshot - NOT a hold (see CheckoutReservationSlot's own
 * comment for where the real atomic hold happens, under a row lock, at
 * actual reserve time).
 * «نوافذ التوصيل v1»: the days are the fixed seven Palestine calendar days
 * (BOOKING_HORIZON_DAYS), and a slot is offered exactly when the shared
 * window state (delivery-windows/window-status.ts) is OPEN - the same
 * state reserve(), confirm(), reschedule and the branch's 7-day board use.
 */
export async function computeAvailableSlots(
  prisma: PrismaService,
  vendorId: string,
  branchId: string,
  now: Date = new Date(),
  days = BOOKING_HORIZON_DAYS,
): Promise<SlotOption[]> {
  const states = await loadSlotStates(prisma, {
    vendorId,
    branchId,
    dates: calendarDates(now, days),
    now,
  });
  return states
    .filter((s) => s.status === 'OPEN')
    .map((s) => ({
      deliveryWindowId: s.windowId,
      date: s.date,
      dayOfWeek: s.dayOfWeek,
      startTime: minutesToTime(s.startMinute),
      endTime: minutesToTime(s.endMinute),
      remainingCapacity: s.remaining,
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
    );
}
