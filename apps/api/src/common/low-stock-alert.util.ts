import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';

/**
 * The store's existing low-stock alert (Sprint 19, decision 3.4: "leaves
 * only 1-3 stock" -> owner(s) and the branch's active employee(s)), for
 * any writer that takes units away - the same event, recipients and band
 * as CheckoutService's reserve(). Fires only on the CROSSING into the band,
 * never again while it stays low (stateless: «before» is read fresh under
 * the row's lock every time, so a restock-then-redrop fires again).
 *
 * «إدارة مخزون الفرع v1» (2026-11-22): the owner's own safety threshold
 * (BranchStock.safetyStockThreshold) is the source of truth - the alert
 * fires when the available quantity goes from above it to at or below it.
 * Only while no threshold is set (0) does the old 1-3 band apply, as a
 * fallback (more than 3 available before, 1-3 after).
 */
export function crossesIntoLowStock(
  availableBefore: number,
  availableAfter: number,
  threshold = 0,
): boolean {
  if (threshold > 0) {
    return availableBefore > threshold && availableAfter <= threshold;
  }
  return availableBefore > 3 && availableAfter >= 1 && availableAfter <= 3;
}

/** The same rule for a list/badge: is this line low right now (not sold out)? */
export function isLowNow(available: number, threshold = 0): boolean {
  if (available <= 0) return false;
  return threshold > 0 ? available <= threshold : available <= 3;
}

export async function enqueueLowStockAlert(
  tx: Prisma.TransactionClient,
  outbox: OutboxEventService,
  input: {
    vendorId: string;
    branchId: string;
    offerVariantId: string;
    remainingQuantity: number;
  },
): Promise<void> {
  const recipients = await tx.vendorUser.findMany({
    where: {
      vendorId: input.vendorId,
      OR: [
        { role: 'OWNER' },
        { role: 'BRANCH_EMPLOYEE', branchId: input.branchId, status: 'ACTIVE' },
      ],
    },
    select: { userId: true },
  });
  for (const recipient of recipients) {
    await outbox.enqueue(
      {
        eventType: 'checkout.low_stock_after_reserve',
        audience: 'STORE',
        payload: {
          vendor_id: input.vendorId,
          branch_id: input.branchId,
          offer_variant_id: input.offerVariantId,
          remaining_quantity: input.remainingQuantity,
          recipient_user_id: recipient.userId,
        },
      },
      tx,
    );
  }
}
