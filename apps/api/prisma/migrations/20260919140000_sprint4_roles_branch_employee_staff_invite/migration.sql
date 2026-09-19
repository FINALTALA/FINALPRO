-- Sprint 4 (feat/sprint-4-roles, approved-product-decisions-2026-09.md
-- PDR-008/009, post-sprint3-replan-2026-09.md RB-ROLE-001/002). Purely
-- additive: a new enum value on two existing enums, one new nullable
-- column with a CHECK constraint, and one new table. Nothing dropped,
-- nothing narrowed, no existing Sprint 1-3 row can violate anything
-- added here (every VendorUser row that exists today has role=OWNER,
-- branchId=NULL, which the new CHECK constraint explicitly allows).
--
-- Migration safety note: `ALTER TYPE ... ADD VALUE` cannot be used in
-- the same transaction as a statement that *uses* the new value (Postgres
-- raises "unsafe use of new value of enum type") - the CHECK constraint
-- below compares against 'BRANCH_EMPLOYEE', so the two ADD VALUE
-- statements are wrapped in their own BEGIN/COMMIT, committing them
-- before anything later in this file references either new value. Same
-- pattern already used by the SubscriptionStatus enum swap in
-- 20260919120000's migration.

-- CreateEnum
CREATE TYPE "StaffInviteStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- AlterEnum
BEGIN;
ALTER TYPE "OtpPurpose" ADD VALUE 'STAFF_INVITE';
ALTER TYPE "VendorUserRole" ADD VALUE 'BRANCH_EMPLOYEE';
COMMIT;

-- AlterTable
ALTER TABLE "vendor_users" ADD COLUMN "branchId" TEXT;

-- Enforces PDR-008/009's invariant at the data layer, not just in
-- application code: an OWNER has vendor-wide access (branchId null);
-- a BRANCH_EMPLOYEE is scoped to exactly one branch (branchId required).
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_role_branch_check" CHECK (
  ("role" = 'OWNER' AND "branchId" IS NULL) OR
  ("role" = 'BRANCH_EMPLOYEE' AND "branchId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "staff_invites" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "StaffInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_invites_phone_status_idx" ON "staff_invites"("phone", "status");

-- CreateIndex
CREATE INDEX "staff_invites_vendorId_idx" ON "staff_invites"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_users_branchId_idx" ON "vendor_users"("branchId");

-- AddForeignKey
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "store_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "store_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- As with every prior migration here, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in the earlier migrations. Left alone again.
