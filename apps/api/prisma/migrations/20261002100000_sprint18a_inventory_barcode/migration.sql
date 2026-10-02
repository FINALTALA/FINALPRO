-- Sprint 18a (RB-INV-004/006/007, PDR-020): actual-sale stock
-- movements, a per-(branch, variant) safety-stock threshold, and an
-- explicit "last physically counted" timestamp, independent of
-- quantity/updatedAt changes a reservation or an online sale can also
-- cause with no human ever near the shelf.

-- ============================================================
-- 1. SALE: a new StockMovementReason value, not a new table - it is a
--    plain stock movement (RB-INV-004/PDR-020's manual/POS-sale path),
--    never a checkout/payment flow of its own. See
--    CreateStockMovementDto's own comment for why it does not get the
--    PDR-021 owner-notification Outbox event the other three reasons
--    do.
-- ============================================================

ALTER TYPE "StockMovementReason" ADD VALUE 'SALE';

-- ============================================================
-- 2. safetyStockThreshold: 0 (the default, and every pre-existing
--    row's value) means "no alert" - deliberately not "alert at
--    zero", which the application's own `threshold > 0 AND available
--    <= threshold` check (never a bare `<=`) relies on.
-- ============================================================

ALTER TABLE "branch_stock" ADD COLUMN "safetyStockThreshold" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_safety_stock_threshold_non_negative" CHECK ("safetyStockThreshold" >= 0);

-- ============================================================
-- 3. lastPhysicalCountAt: NULL for every pre-existing row - no
--    backfill. A backfilled value (e.g. createdAt) would claim a real
--    physical count happened at that moment, which this migration has
--    no evidence for and will not invent. NULL is itself a real,
--    honest state ("never physically confirmed"), surfaced by the
--    application as stale-by-definition until a human actually
--    confirms it (the new confirm-count endpoint) or a
--    COUNT_CORRECTION movement does. SALE/DAMAGE/LOSS never touch this
--    column - see this column's own schema.prisma comment for why.
-- ============================================================

ALTER TABLE "branch_stock" ADD COLUMN "lastPhysicalCountAt" TIMESTAMP(3);
