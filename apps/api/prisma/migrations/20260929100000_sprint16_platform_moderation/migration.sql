-- Sprint 16 (FR-VEND-003, FR-VEND-009, L-23): platform moderation.
-- Entirely additive: two new columns on store_branches, one new enum,
-- one new table, and three indexes. No existing column, row value
-- (other than the deterministic backfill below), or constraint is
-- dropped or altered.

-- AlterTable
ALTER TABLE "store_branches" ADD COLUMN "evidenceRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "store_branches" ADD COLUMN "evidenceSubmittedAt" TIMESTAMP(3);

-- Backfill (D3). A physical branch that already carries a COMPLETE
-- evidence set (lat + lng + a REAL verificationPhotoUrl), whatever its
-- current verification status, gets revision 1. evidenceSubmittedAt is
-- the latest 'store_branch.evidence_submitted' AuditLog occurredAt for
-- that branch; where no such audit row exists (seeded or directly
-- written evidence) it falls back to the branch's createdAt. That
-- fallback is a documented lower-bound approximation, NOT the true
-- submission time. A branch with no evidence, or only partial evidence
-- (e.g. lat without a photo), or a non-physical branch, keeps
-- revision 0 / NULL and therefore never appears in the reviewer queue.
--
-- "REAL" excludes a photo URL that is NULL or whitespace-only:
-- NULLIF(BTRIM(...), '') IS NOT NULL is NULL for both '' and '   '
-- (BTRIM collapses it to '', NULLIF then turns that into NULL), so a
-- legacy or directly-written row with a blank-but-non-null photo URL is
-- correctly treated as incomplete evidence, same as if the column were
-- NULL outright. Application code applies the identical trim check at
-- read/decide time (see submitEvidence's completeness check and
-- decide()'s BR-022 check in vendor-verification.controller.ts) as a
-- second, defensive line for any row this backfill did not cover.
UPDATE "store_branches" AS b
SET "evidenceRevision" = 1,
    "evidenceSubmittedAt" = COALESCE(
      (SELECT MAX(a."occurredAt")
         FROM "audit_logs" AS a
        WHERE a."entityType" = 'StoreBranch'
          AND a."entityId" = b."id"
          AND a."action" = 'store_branch.evidence_submitted'),
      b."createdAt")
WHERE b."isPhysical" = TRUE
  AND b."lat" IS NOT NULL
  AND b."lng" IS NOT NULL
  AND NULLIF(BTRIM(b."verificationPhotoUrl"), '') IS NOT NULL;

-- CreateIndex
CREATE INDEX "store_branches_verificationStatus_evidenceSubmittedAt_idx" ON "store_branches"("verificationStatus", "evidenceSubmittedAt");

-- CreateIndex
CREATE INDEX "warehouse_verification_evidence_status_submittedAt_idx" ON "warehouse_verification_evidence"("status", "submittedAt");

-- CreateEnum
CREATE TYPE "SuspensionReasonCode" AS ENUM ('POLICY_VIOLATION', 'NON_PAYMENT', 'OTHER');

-- CreateTable
CREATE TABLE "vendor_suspensions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "reasonCode" "SuspensionReasonCode" NOT NULL,
    "reason" TEXT NOT NULL,
    "suspendedBy" TEXT NOT NULL,
    "suspendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reactivatedBy" TEXT,
    "reactivatedAt" TIMESTAMP(3),
    "reactivationReason" TEXT,

    CONSTRAINT "vendor_suspensions_pkey" PRIMARY KEY ("id"),
    -- The three reactivation columns are all NULL (open suspension) or
    -- all set (closed) - never half-closed.
    CONSTRAINT "vendor_suspensions_reactivation_all_or_none_check" CHECK (
      ("reactivatedAt" IS NULL AND "reactivatedBy" IS NULL AND "reactivationReason" IS NULL)
      OR
      ("reactivatedAt" IS NOT NULL AND "reactivatedBy" IS NOT NULL AND "reactivationReason" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "vendor_suspensions_vendorId_suspendedAt_idx" ON "vendor_suspensions"("vendorId", "suspendedAt");

-- CreateIndex (partial - not representable in schema.prisma, see the
-- VendorSuspension model's doc comment): at most ONE open suspension
-- per vendor. The vendor-row lock in application code orders
-- concurrent suspend/reactivate calls; this is the structural backstop.
CREATE UNIQUE INDEX "vendor_suspensions_vendor_open_key" ON "vendor_suspensions"("vendorId") WHERE "reactivatedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "vendor_suspensions" ADD CONSTRAINT "vendor_suspensions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_suspensions" ADD CONSTRAINT "vendor_suspensions_suspendedBy_fkey" FOREIGN KEY ("suspendedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT, not SET NULL: the CHECK above requires
-- reactivatedBy to stay set whenever reactivatedAt is)
ALTER TABLE "vendor_suspensions" ADD CONSTRAINT "vendor_suspensions_reactivatedBy_fkey" FOREIGN KEY ("reactivatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
