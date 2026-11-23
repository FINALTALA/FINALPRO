import { Prisma } from '../../generated/prisma/client';
import { windowStartInstant } from '../checkout/delivery-calendar.util';
import { activeOrderStatusFilter } from '../orders/branch-order-state-machine';

/**
 * «نوافذ التوصيل v1»: shared rules for the owner's date / closure actions.
 *
 * Locking: an action that must not land on top of active orders (closing a
 * day, a planned branch closure) locks the branch's window ROWS, sorted by
 * id - the same row locks reserve() and confirm() take on a slot - before
 * counting orders, so a booking and a closure can never both commit for
 * the same slot. Lock order stays: branch-level lock (if any) -> window rows.
 */
export async function lockBranchWindowRows(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  dayOfWeek?: number,
): Promise<{ id: string }[]> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_windows:' || ${vendorId} || ':' || ${branchId}))`;
  const rows =
    dayOfWeek === undefined
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM delivery_windows
          WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId}
          ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM delivery_windows
          WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId}
            AND "dayOfWeek" = ${dayOfWeek}
          ORDER BY id FOR UPDATE`;
  return rows;
}

export interface ActiveSlotOrder {
  id: string;
  deliveryWindowId: string;
  scheduledDate: string; // YYYY-MM-DD
}

/** Active delivery orders of the branch on one calendar date. */
export async function activeOrdersOnDate(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  date: Date,
): Promise<ActiveSlotOrder[]> {
  const rows = await tx.branchOrder.findMany({
    where: {
      vendorId,
      branchId,
      fulfilmentMethod: 'DELIVERY',
      scheduledDate: date,
      deliveryWindowId: { not: null },
      status: activeOrderStatusFilter(),
    },
    select: { id: true, deliveryWindowId: true, scheduledDate: true },
  });
  return rows.map((r) => ({
    id: r.id,
    deliveryWindowId: r.deliveryWindowId!,
    scheduledDate: r.scheduledDate!.toISOString().slice(0, 10),
  }));
}

/**
 * Active delivery orders of the branch whose slot [start, end) overlaps
 * [from, to) - what a planned branch closure would land on.
 */
export async function activeOrdersInSpan(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  from: Date,
  to: Date,
): Promise<ActiveSlotOrder[]> {
  const DAY = 86_400_000;
  const rows = await tx.branchOrder.findMany({
    where: {
      vendorId,
      branchId,
      fulfilmentMethod: 'DELIVERY',
      deliveryWindowId: { not: null },
      scheduledDate: {
        gte: new Date(from.getTime() - 2 * DAY),
        lte: new Date(to.getTime() + DAY),
      },
      status: activeOrderStatusFilter(),
    },
    select: {
      id: true,
      deliveryWindowId: true,
      scheduledDate: true,
      deliveryWindow: { select: { startMinute: true, endMinute: true } },
    },
  });
  return rows
    .filter((r) => {
      if (!r.scheduledDate || !r.deliveryWindow) return false;
      const start = windowStartInstant(
        r.scheduledDate,
        r.deliveryWindow.startMinute,
      );
      const end = windowStartInstant(
        r.scheduledDate,
        r.deliveryWindow.endMinute,
      );
      return start.getTime() < to.getTime() && end.getTime() > from.getTime();
    })
    .map((r) => ({
      id: r.id,
      deliveryWindowId: r.deliveryWindowId!,
      scheduledDate: r.scheduledDate!.toISOString().slice(0, 10),
    }));
}

/** 409 details for "there are active orders": count, dates, per window. */
export function activeOrdersDetails(orders: ActiveSlotOrder[]) {
  const byWindow = new Map<string, number>();
  for (const o of orders) {
    const k = `${o.scheduledDate}|${o.deliveryWindowId}`;
    byWindow.set(k, (byWindow.get(k) ?? 0) + 1);
  }
  return {
    active_orders: orders.length,
    dates: [...new Set(orders.map((o) => o.scheduledDate))].sort(),
    windows: [...byWindow.entries()].map(([k, n]) => {
      const [date, windowId] = k.split('|');
      return { date, delivery_window_id: windowId, active_orders: n };
    }),
  };
}
