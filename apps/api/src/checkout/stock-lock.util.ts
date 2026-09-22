import { Prisma } from '../../generated/prisma/client';

export interface LockedStock {
  id: string;
  quantity: number;
  reservedQuantity: number;
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
 */
export async function lockAndSweepStockRow(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): Promise<LockedStock | null> {
  const rows = await tx.$queryRaw<LockedStock[]>`
    SELECT id, quantity, "reservedQuantity" FROM branch_stock
    WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
    FOR UPDATE`;
  const stock = rows[0];
  if (!stock) return null;

  const expired = await tx.checkoutReservationItem.findMany({
    where: {
      vendorId,
      branchId,
      offerVariantId,
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
