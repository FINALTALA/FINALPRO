-- «إدارة مخزون الفرع v1» (2026-11-22). Additive only - no existing row is
-- rewritten, no existing value changes meaning.
--
--  * StockMovementReason: RECEIVE (+, manual), INTERNAL_USE (-, manual),
--    ORDER_SALE (-, an online order's confirm) and ORDER_CANCEL_RESTOCK
--    (+, a cancellation that put the units back) - the last two are log
--    lines written in the SAME transaction as the existing stock writes.
--  * stock_movements.actorId may be null (a system step: a sweep's
--    cancellation); every existing row keeps its actor.
--  * stock_movements.actorRole (the role at that moment, where known),
--    branchOrderId (same-vendor composite FK to branch_orders) and
--    returnId (FK to returns) - all nullable; existing rows stay null.
--  * an index for the per-line log, newest first.

-- AlterEnum (the new values are not used by this migration itself)
ALTER TYPE "StockMovementReason" ADD VALUE 'RECEIVE';
ALTER TYPE "StockMovementReason" ADD VALUE 'INTERNAL_USE';
ALTER TYPE "StockMovementReason" ADD VALUE 'ORDER_SALE';
ALTER TYPE "StockMovementReason" ADD VALUE 'ORDER_CANCEL_RESTOCK';

-- AlterTable
ALTER TABLE "stock_movements" ALTER COLUMN "actorId" DROP NOT NULL,
ADD COLUMN     "actorRole" TEXT,
ADD COLUMN     "branchOrderId" TEXT,
ADD COLUMN     "returnId" TEXT;

-- the role is one of a closed list (or unknown)
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actorRole_check"
  CHECK ("actorRole" IS NULL OR "actorRole" IN ('OWNER', 'BRANCH_EMPLOYEE', 'CUSTOMER', 'PLATFORM_STAFF', 'SYSTEM'));

-- CreateIndex
CREATE INDEX "stock_movements_branchOrderId_idx" ON "stock_movements"("branchOrderId");

-- CreateIndex
CREATE INDEX "stock_movements_returnId_idx" ON "stock_movements"("returnId");

-- CreateIndex
CREATE INDEX "stock_movements_ledger_idx" ON "stock_movements"("branchId", "offerVariantId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendorId_branchOrderId_fkey" FOREIGN KEY ("vendorId", "branchOrderId") REFERENCES "branch_orders"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
