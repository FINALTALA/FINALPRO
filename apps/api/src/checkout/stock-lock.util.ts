import { Prisma } from '../../generated/prisma/client';

export interface LockedStock {
  id: string;
  quantity: number;
  reservedQuantity: number;
}

/**
 * Codex review round 3 on commit 3d81c9b (fix #3): locks a single
 * CheckoutReservation row by id, existence-tolerant (a reservation a
 * concurrent cancel()/confirm() already fully deleted simply matches
 * zero rows - not an error, just nothing left to lock or act on).
 * Exported so every caller that needs to hold this lock (the sweep
 * below, cancelReservation(), confirm()) takes it the exact same way.
 */
export async function lockReservationRowIfExists(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM checkout_reservations WHERE id = ${reservationId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Codex review round 2 on commit d0ea80d: the ONE place that locks a
 * BranchStock row AND sweeps its expired reservation holds - every
 * writer of `quantity`/`reservedQuantity` (checkout reserve, checkout
 * confirm's real decrement, InventoryController's POS/manual-movement
 * decrement) must call this first, or expiry stays "lazy" in name only
 * for whichever path skips it (the exact bug flagged in review: a
 * hold that nobody re-reserves against never gets swept, so it keeps
 * blocking POS/other reservations indefinitely). Caller must already
 * be inside a transaction; this both locks (FOR UPDATE) and returns
 * the POST-sweep row state in one call.
 *
 * Codex review round 3 on commit 3d81c9b (fix #3): a plain "read
 * expired items, delete them, decrement reservedQuantity" here could
 * double-release against a concurrent cancelReservation() or confirm()
 * expiry-path racing on the SAME reservation - both would independently
 * decide "this reservation is expired, release its holds," and without
 * serializing on the reservation itself, both could decrement the same
 * quantity. Fixed with a strict, codebase-wide lock order: every
 * CheckoutReservation row a sweep might touch is locked FIRST (sorted,
 * so two concurrent sweeps touching the same set of reservations never
 * deadlock against each other), THEN this stock row - the same order
 * cancelReservation()/confirm() now use (reservation row, then any
 * stock rows), so the two can never lock in opposite directions. Only
 * reservations actually locked here are ever swept; one that crosses
 * the expiry boundary in the narrow gap between the first (unlocked)
 * read below and actually acquiring these locks is simply left for a
 * later sweep - never acted on without holding its lock first.
 */
export async function lockAndSweepStockRow(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): Promise<LockedStock | null> {
  const candidates = await tx.checkoutReservationItem.findMany({
    where: {
      vendorId,
      branchId,
      offerVariantId,
      reservation: { expiresAt: { lt: new Date() } },
    },
    select: { reservationId: true },
  });
  const reservationIds = [
    ...new Set(candidates.map((c) => c.reservationId)),
  ].sort();
  for (const reservationId of reservationIds) {
    await lockReservationRowIfExists(tx, reservationId);
  }

  const rows = await tx.$queryRaw<LockedStock[]>`
    SELECT id, quantity, "reservedQuantity" FROM branch_stock
    WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
    FOR UPDATE`;
  const stock = rows[0];
  if (!stock) return null;
  if (reservationIds.length === 0) return stock;

  // Re-read now that both the reservation row(s) above and this stock
  // row are locked - a concurrent cancelReservation()/confirm() this
  // call just waited behind may have already deleted some (or all) of
  // these items (CheckoutReservationItem cascades away with its
  // CheckoutReservation), in which case they are correctly no longer
  // "expired items to sweep" - they are already gone, accounted for by
  // whichever side got there first.
  const expired = await tx.checkoutReservationItem.findMany({
    where: {
      vendorId,
      branchId,
      offerVariantId,
      reservationId: { in: reservationIds },
      reservation: { expiresAt: { lt: new Date() } },
    },
  });
  if (expired.length === 0) return stock;

  const releasedQty = expired.reduce((sum, e) => sum + e.quantity, 0);
  await tx.checkoutReservationItem.deleteMany({
    where: { id: { in: expired.map((e) => e.id) } },
  });
  await tx.branchStock.update({
    where: { id: stock.id },
    data: { reservedQuantity: { decrement: releasedQty } },
  });
  return { ...stock, reservedQuantity: stock.reservedQuantity - releasedQty };
}
