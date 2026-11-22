-- Product-entry wizard (2026-11-16): server-side drafts of new products, and
-- brand requests. Additive only - two new tables and their enums; no
-- existing table, column, row or rule changes. Runs after
-- 20261115120000_tb26_notification_audience.
--
-- A draft is NOT a vendor_offers row, so nothing half-entered can reach
-- shoppers, discovery or search. `revision` is the optimistic-concurrency
-- counter every save must name (two tabs never overwrite each other
-- silently). `uploads` is the ledger of the draft's own upload URLs - the
-- only files the draft clean-up may ever consider.
--
-- Rollback: an older build ignores both tables; dropping them (and the two
-- enums) removes the feature - products already created from drafts are
-- ordinary vendor_offers rows and stay.

CREATE TYPE "OfferDraftStatus" AS ENUM ('OPEN', 'SUBMITTED', 'DISCARDED', 'ABANDONED');
CREATE TYPE "BrandRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "offer_drafts" (
  "id" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "uploads" JSONB NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "OfferDraftStatus" NOT NULL DEFAULT 'OPEN',
  "offerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "offer_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offer_drafts_revision_positive" CHECK ("revision" >= 1),
  -- A created draft always points at its product; nothing else does.
  CONSTRAINT "offer_drafts_offer_iff_submitted" CHECK (("status" = 'SUBMITTED') = ("offerId" IS NOT NULL))
);
CREATE UNIQUE INDEX "offer_drafts_offerId_key" ON "offer_drafts"("offerId");
CREATE INDEX "offer_drafts_vendorId_status_updatedAt_idx" ON "offer_drafts"("vendorId", "status", "updatedAt");
ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "vendor_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "brand_requests" (
  "id" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "offerId" TEXT,
  "status" "BrandRequestStatus" NOT NULL DEFAULT 'PENDING',
  "brandId" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_requests_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  -- Decided exactly when not pending; approved names a brand; rejected says why.
  CONSTRAINT "brand_requests_decision_shape" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL AND "brandId" IS NULL)
    OR ("status" = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL AND "brandId" IS NOT NULL)
    OR ("status" = 'REJECTED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL AND "rejectionReason" IS NOT NULL)
  )
);
CREATE INDEX "brand_requests_status_createdAt_idx" ON "brand_requests"("status", "createdAt");
CREATE INDEX "brand_requests_vendorId_createdAt_idx" ON "brand_requests"("vendorId", "createdAt");
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "vendor_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brand_requests" ADD CONSTRAINT "brand_requests_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
