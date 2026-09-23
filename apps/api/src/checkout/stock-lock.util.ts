import { Prisma } from '../../generated/prisma/client';

export interface LockedStock {
  id: string;
  quantity: number;
  reservedQuantity: number;
}

export interface StockKey {
  vendorId: string;
  branchId: string;
  offerVariantId: string;
}

export interface WindowDateKey {
  deliveryWindowId: string;
  scheduledDate: Date;
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
 * Codex review round 4 on commit 95a8430: locks a whole SET of
 * CheckoutReservation rows in one sorted pass - the shared primitive
 * every multi-resource lock plan (reserve()'s batch sweep below) uses
 * to take its position-1 locks before touching anything else.
 */
export async function lockReservationRowsSorted(
  tx: Prisma.TransactionClient,
  reservationIds: string[],
): Promise<void> {
  const sorted = [...new Set(reservationIds)].sort();
  for (const id of sorted) {
    await lockReservationRowIfExists(tx, id);
  }
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): a read-only,
 * batched scan across MULTIPLE stock keys at once - finds every
 * distinct reservationId with an expired item on ANY of them, in a
 * single query, so a caller that will touch several stock rows (only
 * reserve() does) can determine its FULL reservation-lock set up front
 * instead of discovering (and locking) reservations one stock row at a
 * time. Discovering and locking incrementally, per row, is exactly
 * what let a global lock-order invariant get violated in round 3: two
 * different resource "batches" could each hold a lock the other one
 * was still waiting for.
 */
export async function findExpiredReservationIdsForStockKeys(
  tx: Prisma.TransactionClient,
  keys: StockKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx.checkoutReservationItem.findMany({
    where: {
      OR: keys.map((k) => ({
        vendorId: k.vendorId,
        branchId: k.branchId,
        offerVariantId: k.offerVariantId,
      })),
      reservation: { expiresAt: { lt: new Date() } },
    },
    select: { reservationId: true },
  });
  return [...new Set(rows.map((r) => r.reservationId))];
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): the same batched,
 * read-only discovery as findExpiredReservationIdsForStockKeys above,
 * but for expired CheckoutReservationSlot rows on the (window, date)
 * pairs a DELIVERY checkout will touch - reserve()'s lock plan must
 * include these too, or a slot-expiry cleanup taken after the window
 * lock (see reserveDeliverySlotAlreadyLocked) could still race an
 * un-locked reservation the same way stock rows could.
 */
export async function findExpiredReservationIdsForWindowKeys(
  tx: Prisma.TransactionClient,
  keys: WindowDateKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx.checkoutReservationSlot.findMany({
    where: {
      OR: keys.map((k) => ({
        deliveryWindowId: k.deliveryWindowId,
        scheduledDate: k.scheduledDate,
      })),
      reservation: { expiresAt: { lt: new Date() } },
    },
    select: { reservationId: true },
  });
  return [...new Set(rows.map((r) => r.reservationId))];
}

/**
 * Codex review round 2 on commit d0ea80d: the ONE place that locks a
 * BranchStock row AND sweeps its expired reservation holds - every
 * writer of `quantity`/`reservedQuantity` (checkout reserve, checkout
 * confirm's real decrement, InventoryController's POS/manual-movement
 * decrement) must call this first, or expiry stays "lazy" in name only
 * for whichever path skips it (the exact bug flagged in review: a
 * hold that nobody re-reserves against never gets swept, so it keeps
 * blocking POS/other reservations indefinitely).
 *
 * Codex review round 4 on commit 95a8430 (fix #1): the row-lock-then-
 * sweep work is now split in two. This function is the STANDALONE
 * entry point - used only by InventoryController's POS/manual-movement
 * path, which only ever touches ONE stock row per call, so discovering
 * and locking its own (small) reservation set right here is still
 * globally safe (reservation-row lock, then this one stock row -
 * nothing else in this transaction needs any other resource type).
 * reserve() - which may touch SEVERAL stock rows in one transaction -
 * must NOT use this; it needs its full reservation-lock set determined
 * and acquired up front, across every stock/window key it will touch,
 * before locking any of them (see
 * lockAndSweepStockRowAssumingReservationsLocked below).
 */
export async function lockAndSweepStockRow(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): Promise<LockedStock | null> {
  const reservationIds = (
    await findExpiredReservationIdsForStockKeys(tx, [
      { vendorId, branchId, offerVariantId },
    ])
  ).sort();
  await lockReservationRowsSorted(tx, reservationIds);
  return lockAndSweepStockRowAssumingReservationsLocked(
    tx,
    vendorId,
    branchId,
    offerVariantId,
    reservationIds,
  );
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): locks and sweeps
 * ONE stock row, but assumes the caller ALREADY holds a lock on every
 * reservation row that might have an expired item on it (passed in as
 * `lockedReservationIds`) - no reservation discovery or locking happens
 * here. This is what reserve() uses, once per stock key in its own
 * canonical order, AFTER it has already locked its FULL, pre-computed
 * reservation-lock set (see reserve()'s own comment for the full lock
 * plan: reservations, then vendors, then stock, then windows).
 */
export async function lockAndSweepStockRowAssumingReservationsLocked(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
  lockedReservationIds: string[],
): Promise<LockedStock | null> {
  const rows = await tx.$queryRaw<LockedStock[]>`
    SELECT id, quantity, "reservedQuantity" FROM branch_stock
    WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
    FOR UPDATE`;
  const stock = rows[0];
  if (!stock) return null;
  if (lockedReservationIds.length === 0) return stock;

  // Re-read now that both the reservation row(s) and this stock row
  // are locked - a concurrent cancelReservation()/confirm() this call
  // just waited behind may have already deleted some (or all) of
  // these items (CheckoutReservationItem cascades away with its
  // CheckoutReservation), in which case they are correctly no longer
  // "expired items to sweep" - already gone, accounted for by
  // whichever side got there first. Only ids we actually hold a lock
  // on are ever considered here.
  const expired = await tx.checkoutReservationItem.findMany({
    where: {
      vendorId,
      branchId,
      offerVariantId,
      reservationId: { in: lockedReservationIds },
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
