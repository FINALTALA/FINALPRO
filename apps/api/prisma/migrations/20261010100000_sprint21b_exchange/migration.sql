-- Sprint 21b (EPIC-RET, PDR §3.5): exchange within a real branch only.
-- No PickupPoint involvement at all - see schema.prisma's own comments
-- on Return.desiredOutcome/replacement* and ExchangeSettlement for the
-- full reasoning. All additive.

-- CreateEnum
CREATE TYPE "ReturnOutcome" AS ENUM ('RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ExchangeSettlementDirection" AS ENUM ('COLLECT_CASH', 'REFUND_CASH', 'NONE');

-- CreateEnum
CREATE TYPE "ExchangeSettlementMethod" AS ENUM ('CASH');

-- AlterEnum
ALTER TYPE "ReturnStatus" ADD VALUE 'EXCHANGED';

-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE 'EXCHANGE_FULFILLED';

-- AlterTable: vendors - a SEPARATE fixed ILS fee from returnFeeIls
-- (PDR-030: "separate fixed ILS return/exchange fees"), required by
-- the DTO only when returnMode is EXCHANGE_ONLY/BOTH.
ALTER TABLE "vendors" ADD COLUMN     "exchangeFeeIls" DECIMAL(10,2);

-- AlterTable: branch_orders - the sixth snapshot field, same
-- convention as the existing five (captured once at confirm(), never
-- re-read live). NULL for every pre-existing order (legacy) and for
-- any order whose snapshotted mode never included exchange.
ALTER TABLE "branch_orders" ADD COLUMN     "returnPolicySnapshotExchangeFeeIls" DECIMAL(10,2);

-- AlterTable: returns - desiredOutcome is a direct NOT NULL DEFAULT
-- add, safe without a nullable-then-backfill phase: every row that
-- exists before this migration genuinely IS a plain return (exchange
-- did not exist yet), so 'RETURN' is the simple, correct value for
-- all of them, not an approximation the way RefundMethod's backfill
-- needed to be. The three replacement* columns stay nullable - see
-- the CHECK constraint below for exactly when they must be set.
ALTER TABLE "returns" ADD COLUMN     "desiredOutcome" "ReturnOutcome" NOT NULL DEFAULT 'RETURN',
ADD COLUMN     "replacementBranchId" TEXT,
ADD COLUMN     "replacementOfferVariantId" TEXT,
ADD COLUMN     "replacementUnitPriceSnapshot" DECIMAL(10,2);

-- CreateTable: exchange_settlements - the EXCHANGE outcome's own
-- immutable ledger, deliberately separate from branch_order_refunds
-- (that table's own CHECK below requires reason='ITEM_RETURNED'
-- whenever returnId is set, which a bidirectional cash settlement -
-- the customer may OWE money, not just receive it - does not fit).
CREATE TABLE "exchange_settlements" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "branchOrderItemId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "originalUnitPriceSnapshot" DECIMAL(10,2) NOT NULL,
    "replacementUnitPriceSnapshot" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "exchangeFeeSnapshot" DECIMAL(10,2) NOT NULL,
    "originalTotal" DECIMAL(10,2) NOT NULL,
    "replacementTotal" DECIMAL(10,2) NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "direction" "ExchangeSettlementDirection" NOT NULL,
    "method" "ExchangeSettlementMethod" NOT NULL DEFAULT 'CASH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_settlements_returnId_key" ON "exchange_settlements"("returnId");

-- CreateIndex
CREATE INDEX "exchange_settlements_vendorId_idx" ON "exchange_settlements"("vendorId");

-- CreateIndex (Prisma-schema-level target for the composite FK below)
CREATE UNIQUE INDEX "exchange_settlements_returnId_branchOrderItemId_key" ON "exchange_settlements"("returnId", "branchOrderItemId");

-- CreateIndex: backs archive()'s own new "does this branch have a
-- live exchange reservation" check, under lockBranchOperationalStatus.
CREATE INDEX "returns_replacementBranchId_status_idx" ON "returns"("replacementBranchId", "status");

-- AddForeignKey: replacement variant - composite, same tenant-safety
-- pattern as every other FK into offer_variants(vendorId, id).
ALTER TABLE "returns" ADD CONSTRAINT "returns_vendorId_replacementOfferVariantId_fkey" FOREIGN KEY ("vendorId", "replacementOfferVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: replacement branch - composite, same pattern as
-- returns.receivingBranchId's own existing FK.
ALTER TABLE "returns" ADD CONSTRAINT "returns_vendorId_replacementBranchId_fkey" FOREIGN KEY ("vendorId", "replacementBranchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_settlements" ADD CONSTRAINT "exchange_settlements_returnId_branchOrderItemId_fkey" FOREIGN KEY ("returnId", "branchOrderItemId") REFERENCES "returns"("id", "branchOrderItemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Review-plan requirement: desiredOutcome='EXCHANGE' must carry all
-- three replacement* fields together; desiredOutcome='RETURN' must
-- carry none of them - not representable in Prisma's schema DSL, same
-- established pattern as branch_order_refunds's own consistency CHECK.
ALTER TABLE "returns" ADD CONSTRAINT "returns_exchange_fields_consistency_check" CHECK (
    (
        "desiredOutcome" = 'EXCHANGE'
        AND "replacementOfferVariantId" IS NOT NULL
        AND "replacementBranchId" IS NOT NULL
        AND "replacementUnitPriceSnapshot" IS NOT NULL
    )
    OR (
        "desiredOutcome" = 'RETURN'
        AND "replacementOfferVariantId" IS NULL
        AND "replacementBranchId" IS NULL
        AND "replacementUnitPriceSnapshot" IS NULL
    )
);
