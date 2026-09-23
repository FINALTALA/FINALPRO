import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * Sprint 9/10 shared concurrency primitive: locks one DeliveryWindow
 * row (SELECT ... FOR UPDATE) FIRST, before any active-order/
 * reservation/history check, inside the same transaction that will act
 * on the result. Postgres takes a FOR KEY SHARE lock on the referenced
 * row for any concurrent INSERT that references this window via an FK
 * (a BranchOrder.deliveryWindowId or - Sprint 10 -
 * CheckoutReservationSlot.deliveryWindowId), which conflicts with the
 * FOR UPDATE taken here - so that concurrent insert is forced to wait
 * until this transaction commits or rolls back. Originally
 * DeliveryWindowsController's own private method (Codex review round 3
 * on commit 1febd9a); extracted in Sprint 10 so CheckoutService's own
 * slot-reservation logic can take the exact same lock on the exact
 * same row, rather than a second, independently-reasoned-about lock
 * that could race against this one.
 */
export async function lockDeliveryWindowRow(
  tx: Prisma.TransactionClient,
  windowId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_windows WHERE id = ${windowId} FOR UPDATE`;
  if (!rows[0]) {
    throw new NotFoundException({
      code: 'DELIVERY_WINDOW_NOT_FOUND',
      message: 'Delivery window not found for this branch',
    });
  }
}
