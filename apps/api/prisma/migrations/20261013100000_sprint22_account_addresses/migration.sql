-- Sprint 22 (FR-AUTH-006/008/014, PDR-029/034): account deactivation/
-- reactivation, phone-change OTP purpose already existed (PHONE_CHANGE),
-- and the address management screen (default/edit/delete).

-- AlterEnum
-- Postgres requires this to commit before the new value is usable in
-- the same session - never combined with a statement that reads it in
-- this same migration (same pattern already used for S21b's own
-- StockMovementReason addition).
ALTER TYPE "OtpPurpose" ADD VALUE 'ACCOUNT_REACTIVATION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "deactivatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "addresses"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Hand-written: at most one non-archived default address per customer.
-- Not representable in Prisma's schema DSL (same already-established
-- pattern as this schema's other partial unique indexes, e.g.
-- BranchOrder.pickupCode's). The archivedAt filter is deliberate: an
-- archived row that still carried isDefault=true (should never happen
-- via the application, but this is the DB-level backstop) must never
-- block a new legitimate default from being set.
CREATE UNIQUE INDEX "addresses_customer_default_unique"
  ON "addresses"("customerId")
  WHERE "isDefault" = true AND "archivedAt" IS NULL;
