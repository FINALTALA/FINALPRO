-- Product-entry wizard, brand-request correction (2026-11-16): a brand the
-- seller typed is a request attached to her DRAFT from the moment she asks
-- for it - the product keeps that brand name (never "no brand") and cannot
-- be published until an administrator approves it. Additive: one nullable
-- column, one enum value, one partial unique index, and the decision-shape
-- CHECK widened for WITHDRAWN. Runs after
-- 20261116120000_offer_drafts_brand_requests.

-- Postgres allows ADD VALUE inside the migration's transaction as long as
-- the new value is not used in that same transaction (it is not).
ALTER TYPE "BrandRequestStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';

ALTER TABLE "brand_requests" ADD COLUMN "draftId" TEXT;
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "offer_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- At most one request awaiting a decision per draft.
CREATE UNIQUE INDEX "brand_requests_one_pending_per_draft" ON "brand_requests"("draftId") WHERE "status" = 'PENDING';

-- WITHDRAWN: the seller changed her mind before a decision - nobody decided.
ALTER TABLE "brand_requests" DROP CONSTRAINT "brand_requests_decision_shape";
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_decision_shape" CHECK (
  ("status"::text IN ('PENDING', 'WITHDRAWN') AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL AND "brandId" IS NULL)
  OR ("status"::text = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL AND "brandId" IS NOT NULL)
  OR ("status"::text = 'REJECTED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL AND "rejectionReason" IS NOT NULL)
);
