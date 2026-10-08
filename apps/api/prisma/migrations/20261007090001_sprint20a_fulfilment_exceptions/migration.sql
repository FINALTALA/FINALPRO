-- Sprint 20a: BranchOrder/BranchOrderItem new columns and the new
-- BranchOrderRefund table. The 4 lines of pre-existing, already-known
-- Prisma/Postgres constraint-name drift (branch_orders_
-- paymentTransactionId_fkey, checkout_reservation_slots' renamed FK,
-- and the two renamed indexes) are deliberately NOT included here -
-- they are unrelated harmless drift every prior sprint's clean-room
-- verification already treats as the expected baseline; folding them
-- into this migration would just move where that same drift shows up
-- again on the next `prisma migrate diff`, not actually remove it.

-- AlterTable
ALTER TABLE "branch_order_items" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledReason" TEXT;

-- AlterTable
ALTER TABLE "branch_orders" ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "codCollectedAmount" DECIMAL(10,2),
ADD COLUMN     "codCollectedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryFailedAt" TIMESTAMP(3),
ADD COLUMN     "prepReminderSentForDate" DATE,
ADD COLUMN     "prepReminderSentForWindowId" TEXT,
ADD COLUMN     "slotMissedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "branch_order_refunds" (
    "id" TEXT NOT NULL,
    "branchOrderId" TEXT NOT NULL,
    "branchOrderItemId" TEXT,
    "paymentTransactionId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" "BranchOrderRefundReason" NOT NULL,
    "initiatedBy" "BranchOrderRefundInitiator" NOT NULL,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_order_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: plain unique on a nullable column - standard Postgres
-- NULL semantics allow unlimited NULL rows (the delivery-fee/whole-
-- order rows) while still preventing the SAME non-null
-- branchOrderItemId from ever appearing twice (the per-item refund
-- guarantee).
CREATE UNIQUE INDEX "branch_order_refunds_branchOrderItemId_key" ON "branch_order_refunds"("branchOrderItemId");

-- CreateIndex
CREATE INDEX "branch_order_refunds_branchOrderId_idx" ON "branch_order_refunds"("branchOrderId");

-- CreateIndex
CREATE INDEX "branch_order_refunds_paymentTransactionId_idx" ON "branch_order_refunds"("paymentTransactionId");

-- AddForeignKey
ALTER TABLE "branch_order_refunds" ADD CONSTRAINT "branch_order_refunds_branchOrderId_fkey" FOREIGN KEY ("branchOrderId") REFERENCES "branch_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_order_refunds" ADD CONSTRAINT "branch_order_refunds_branchOrderItemId_fkey" FOREIGN KEY ("branchOrderItemId") REFERENCES "branch_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_order_refunds" ADD CONSTRAINT "branch_order_refunds_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
