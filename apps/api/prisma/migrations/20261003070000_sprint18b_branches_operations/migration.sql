-- Sprint 18b (FR-VEND-006, FR-VPORTAL-009, G-ON-07, G-IN-05, PDR-009):
-- branch archival, weekly operating hours (informational only), a
-- temporary-closure history table, and employee suspension. Every
-- change here is additive - no column dropped, no existing row's
-- meaning changed.

-- ============================================================
-- 1. VendorUserStatus + VendorUser.status: SUSPENDED is meaningful
--    only for role=BRANCH_EMPLOYEE - the CHECK constraint below is
--    the real guarantee, not just application code. Default ACTIVE
--    is honestly true for every pre-existing row (no suspension
--    mechanism existed before this migration).
-- ============================================================
CREATE TYPE "VendorUserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "vendor_users" ADD COLUMN "status" "VendorUserStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_suspended_only_for_branch_employee"
  CHECK ("status" != 'SUSPENDED' OR "role" = 'BRANCH_EMPLOYEE');

-- ============================================================
-- 2. StoreBranch.archivedAt: long-term retirement, never a delete -
--    NULL for every pre-existing row (no backfill - no branch was
--    ever archived before this migration, this is honestly true,
--    not an assumed default).
-- ============================================================
ALTER TABLE "store_branches" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- ============================================================
-- 3. BranchOperatingHours: weekly walk-in hours, informational only -
--    never read by checkout/reserve. At most one row per (branch,
--    day) this version; no overnight-spanning hours without an
--    explicit new decision.
-- ============================================================
CREATE TABLE "branch_operating_hours" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_operating_hours_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "branch_operating_hours" ADD CONSTRAINT "branch_operating_hours_minute_range"
  CHECK ("openMinute" >= 0 AND "openMinute" < "closeMinute" AND "closeMinute" <= 1440);

CREATE UNIQUE INDEX "branch_operating_hours_vendorId_branchId_dayOfWeek_key" ON "branch_operating_hours"("vendorId", "branchId", "dayOfWeek");
CREATE INDEX "branch_operating_hours_vendorId_branchId_idx" ON "branch_operating_hours"("vendorId", "branchId");

ALTER TABLE "branch_operating_hours" ADD CONSTRAINT "branch_operating_hours_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_operating_hours" ADD CONSTRAINT "branch_operating_hours_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 4. BranchClosure: a historical record, never edited/deleted - a
--    correction is a new row. [startsAt, endsAt) is genuinely
--    half-open: two closures that merely touch (one's endsAt equals
--    the next's startsAt) must NOT count as overlapping, which is
--    exactly Postgres's own default range-literal bound type ('[)'),
--    so tstzrange(startsAt, endsAt) with no explicit bound flag
--    already has the right semantics - no BETWEEN anywhere. The
--    EXCLUDE constraint is the real non-overlap guarantee (btree_gist
--    required for an equality column inside a GiST exclusion index),
--    same established philosophy as delivery_windows_no_overlap.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "branch_closures" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_closures_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_starts_before_ends"
  CHECK ("startsAt" < "endsAt");
ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_no_overlap"
  EXCLUDE USING gist ("branchId" WITH =, tstzrange("startsAt", "endsAt") WITH &&);

CREATE INDEX "branch_closures_vendorId_branchId_startsAt_endsAt_idx" ON "branch_closures"("vendorId", "branchId", "startsAt", "endsAt");

ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
