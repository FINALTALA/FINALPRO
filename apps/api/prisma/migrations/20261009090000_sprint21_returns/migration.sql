-- Sprint 21 (EPIC-RET): returns/refunds for a delivered/picked-up item.
-- All additive. See schema.prisma's own comments on Return,
-- BranchOrderRefund.method/returnId, Vendor.return*, and
-- BranchOrder.pickedUpAt/returnPolicySnapshot* for the full reasoning.

-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('ONLINE_GATEWAY', 'COD_CASH');

-- CreateEnum
CREATE TYPE "ReturnMode" AS ENUM ('NO_RETURN', 'REFUND_ONLY', 'EXCHANGE_ONLY', 'BOTH');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DAMAGED', 'WRONG_ITEM', 'COUNTERFEIT_CLAIM', 'WARRANTY_CLAIM', 'CHANGE_OF_MIND');

-- CreateEnum
CREATE TYPE "ReturnItemCondition" AS ENUM ('RESELLABLE', 'DAMAGED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED_AWAITING_DROPOFF', 'RECEIVED', 'REFUND_PROCESSING', 'REFUNDED', 'REJECTED', 'REJECTED_CLOSED', 'ADMIN_REJECTED', 'ESCALATED', 'EXPIRED', 'CANCELLED_BY_CUSTOMER');

-- AlterEnum
ALTER TYPE "BranchOrderRefundReason" ADD VALUE 'ITEM_RETURNED';

-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE 'RETURN_RESTOCK';

-- AlterTable: vendors - return policy, selected at registration
-- (PDR-030). returnPolicyUpdatedAt stays NULL for every pre-existing
-- row (legacy) - its own first post-migration policy write is never
-- 6-month-gated, see updateReturnPolicy()'s own comment.
ALTER TABLE "vendors" ADD COLUMN     "returnFeeIls" DECIMAL(10,2),
ADD COLUMN     "returnMode" "ReturnMode" NOT NULL DEFAULT 'NO_RETURN',
ADD COLUMN     "returnPolicyUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "returnWindowDays" INTEGER,
ADD COLUMN     "returnsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: branch_orders - pickedUpAt (mirrors deliveredAt for
-- PICKUP) + the full return-policy snapshot, all nullable. Every row
-- confirmed before this migration gets NULL across the board
-- (legacy) - deliberately return-ineligible, never backfilled from
-- the vendor's current policy.
ALTER TABLE "branch_orders" ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "returnPolicySnapshotEnabled" BOOLEAN,
ADD COLUMN     "returnPolicySnapshotFeeIls" DECIMAL(10,2),
ADD COLUMN     "returnPolicySnapshotMode" "ReturnMode",
ADD COLUMN     "returnPolicySnapshotVersion" TIMESTAMP(3),
ADD COLUMN     "returnPolicySnapshotWindowDays" INTEGER;

-- AlterTable: branch_order_refunds - returnId first (nullable, no
-- backfill needed - every pre-existing row is cancellation-driven,
-- correctly NULL).
ALTER TABLE "branch_order_refunds" ADD COLUMN     "returnId" TEXT;

-- method: added nullable FIRST, backfilled, THEN set NOT NULL - never
-- a direct NOT NULL add on a table with existing rows. Verified
-- directly against the code (not assumed): every branchOrderRefund
-- .create() call site in branch-order-cancellation.service.ts is
-- gated by `if (isOnline)` - no exception exists anywhere pre-S21 -
-- so every single existing row is safely ONLINE_GATEWAY.
ALTER TABLE "branch_order_refunds" ADD COLUMN     "method" "RefundMethod";
UPDATE "branch_order_refunds" SET "method" = 'ONLINE_GATEWAY' WHERE "method" IS NULL;
ALTER TABLE "branch_order_refunds" ALTER COLUMN "method" SET NOT NULL;

-- CreateTable: returns
CREATE TABLE "returns" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchOrderItemId" TEXT NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "reasonNote" TEXT,
    "photoUrls" TEXT[],
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "code" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "vendorReviewDueAt" TIMESTAMP(3) NOT NULL,
    "vendorReminderSentAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "disputeDeadlineAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "escalationResolvedAt" TIMESTAMP(3),
    "escalationResolvedByUserId" TEXT,
    "receivingBranchId" TEXT,
    "receivedByUserId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "itemCondition" "ReturnItemCondition",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "returns_branchOrderItemId_idx" ON "returns"("branchOrderItemId");

-- CreateIndex
CREATE INDEX "returns_vendorId_code_idx" ON "returns"("vendorId", "code");

-- CreateIndex (Prisma-schema-level target for BranchOrderRefund's own composite FK)
CREATE UNIQUE INDEX "returns_id_branchOrderItemId_key" ON "returns"("id", "branchOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_order_items_vendorId_id_key" ON "branch_order_items"("vendorId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_order_refunds_returnId_key" ON "branch_order_refunds"("returnId");

-- CreateIndex (Prisma-schema-level target - see the hand-written composite FK below)
CREATE UNIQUE INDEX "branch_order_refunds_returnId_branchOrderItemId_key" ON "branch_order_refunds"("returnId", "branchOrderItemId");

-- AddForeignKey
ALTER TABLE "branch_order_refunds" ADD CONSTRAINT "branch_order_refunds_returnId_branchOrderItemId_fkey" FOREIGN KEY ("returnId", "branchOrderItemId") REFERENCES "returns"("id", "branchOrderItemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_vendorId_branchOrderItemId_fkey" FOREIGN KEY ("vendorId", "branchOrderItemId") REFERENCES "branch_order_items"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_vendorId_receivingBranchId_fkey" FOREIGN KEY ("vendorId", "receivingBranchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Review-round requirement: a composite FK is skipped entirely by
-- Postgres whenever ANY of its columns is NULL - "if returnId is set,
-- branchOrderItemId must match" does NOT by itself forbid a row with
-- returnId set and branchOrderItemId NULL (the FK simply never fires
-- on that row). This CHECK closes that gap explicitly, and additionally
-- pins down that a return-driven refund is always ITEM_RETURNED with a
-- real method - never representable in Prisma's schema DSL.
ALTER TABLE "branch_order_refunds" ADD CONSTRAINT "branch_order_refunds_return_consistency_check" CHECK (
    "returnId" IS NULL
    OR (
        "branchOrderItemId" IS NOT NULL
        AND "reason" = 'ITEM_RETURNED'
        AND "method" IS NOT NULL
    )
);

-- Review-round requirement: "no concurrently open/already-resolved
-- return for the same item" - NOT "no return ever again" after a
-- rejection/cancellation/expiry. Every status EXCEPT the three that
-- genuinely allow a brand-new independent attempt (REJECTED_CLOSED,
-- EXPIRED, CANCELLED_BY_CUSTOMER) blocks a second row for the same
-- item - this deliberately includes REFUNDED and ADMIN_REJECTED,
-- which must never be resubmitted (a prior review round caught an
-- earlier draft of this index that let both slip through). Not
-- representable in Prisma's schema DSL (same already-established
-- pattern as e.g. BranchOrder.pickupCode's own partial unique index).
CREATE UNIQUE INDEX "returns_open_branch_order_item_id_key" ON "returns"("branchOrderItemId")
    WHERE "status" NOT IN ('REJECTED_CLOSED', 'EXPIRED', 'CANCELLED_BY_CUSTOMER');

-- Review-round requirement: the approval code must be unique only
-- while it is actually redeemable - once consumed/expired/superseded,
-- its digits are free to be reused by a later, unrelated Return. Scoped
-- to (vendorId, code), not globally, since redemption is vendor-wide
-- (PDR-031: any branch of the vendor accepts the drop-off) - the
-- redeem endpoint's own lookup is always `WHERE "vendorId" = $1 AND
-- "code" = $2 AND status = 'APPROVED_AWAITING_DROPOFF'`, never by code
-- alone, so this index is also what makes that lookup O(1).
CREATE UNIQUE INDEX "returns_active_code_key" ON "returns"("vendorId", "code")
    WHERE "status" = 'APPROVED_AWAITING_DROPOFF';
