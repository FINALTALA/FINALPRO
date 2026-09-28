-- Sprint 17 (owner catalog: PDR-036 templates, brand sentinel, pricing/
-- discounts + PriceHistory, media type + limits, ImportBatch). Entirely
-- additive except the two deterministic, honest backfills below
-- (offer_variant_media.mediaType -> IMAGE for every pre-existing row,
-- and price_history's one-time MIGRATED_BASELINE snapshot per
-- pre-existing OfferVariant) - no existing row's own columns are
-- altered or dropped.

-- ============================================================
-- 1. Brand sentinel ("No brand" / "بدون علامة تجارية", D3)
-- ============================================================

ALTER TABLE "brands" ADD COLUMN "isNoBrandSentinel" BOOLEAN NOT NULL DEFAULT false;

-- Partial unique index: at most one sentinel row, ever, structurally.
CREATE UNIQUE INDEX "brands_no_brand_sentinel_key" ON "brands"("isNoBrandSentinel") WHERE "isNoBrandSentinel" = true;

-- Fixed, documented id - application code references the sentinel by
-- this exact id (common/no-brand-sentinel.ts), not by name lookup at
-- runtime. Explicit, intentional conflict handling (not a silent
-- rewrite, not a raw constraint-violation crash): if a Brand row with
-- this exact normalizedName already exists (e.g. a platform admin
-- created one by hand before this migration ran) and it is not already
-- the sentinel, the migration stops with a human-readable message
-- instead of either quietly repurposing that row or failing with an
-- opaque unique-constraint error.
DO $$
DECLARE
  existing_id TEXT;
BEGIN
  SELECT "id" INTO existing_id FROM "brands" WHERE "normalizedName" = 'no-brand';
  IF existing_id IS NOT NULL AND existing_id <> 'a0000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'Sprint 17 migration: a Brand row (id=%) already exists with normalizedName ''no-brand'' and is not the platform''s "No brand" sentinel. Rename that row''s normalizedName manually first, then re-run this migration.', existing_id;
  END IF;
END $$;

INSERT INTO "brands" ("id", "name", "normalizedName", "isNoBrandSentinel", "createdAt")
VALUES ('a0000000-0000-4000-8000-000000000001', 'بدون علامة تجارية', 'no-brand', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- ============================================================
-- 2. VendorOffer: PDR-036 category template, brand, archive
-- ============================================================

-- CreateEnum
CREATE TYPE "ClothingCategoryTemplate" AS ENUM ('DRESSES', 'TOPS_SHIRTS', 'BOTTOMS', 'COATS_JACKETS', 'SETS_PYJAMAS', 'KIDS_CLOTHING', 'SHOES', 'BAGS', 'JEWELLERY_WATCHES', 'OTHER_ACCESSORIES');

-- AlterEnum (additive; safe - no code anywhere branches on
-- status !== 'DRAFT' or any other inverse check against OfferStatus,
-- confirmed by search before adding this value)
ALTER TYPE "OfferStatus" ADD VALUE 'ARCHIVED';

ALTER TABLE "vendor_offers" ADD COLUMN "brandId" TEXT;
ALTER TABLE "vendor_offers" ADD COLUMN "categoryTemplate" "ClothingCategoryTemplate";
ALTER TABLE "vendor_offers" ADD COLUMN "templateAttributes" JSONB;
ALTER TABLE "vendor_offers" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "vendor_offers" ADD CONSTRAINT "vendor_offers_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "vendor_offers_brandId_idx" ON "vendor_offers"("brandId");

-- templateAttributes is only ever meaningful alongside categoryTemplate
-- - both null or both set (never one without the other). Validated
-- structurally, not just in application code.
ALTER TABLE "vendor_offers" ADD CONSTRAINT "vendor_offers_template_pair_check" CHECK (
  ("categoryTemplate" IS NULL AND "templateAttributes" IS NULL)
  OR
  ("categoryTemplate" IS NOT NULL AND "templateAttributes" IS NOT NULL)
);

-- ============================================================
-- 3. OfferVariant: colour/size, scheduled discount, price rules
-- ============================================================

ALTER TABLE "offer_variants" ADD COLUMN "colour" TEXT;
ALTER TABLE "offer_variants" ADD COLUMN "size" TEXT;
ALTER TABLE "offer_variants" ADD COLUMN "discountPercent" DECIMAL(5,2);
ALTER TABLE "offer_variants" ADD COLUMN "discountStartAt" TIMESTAMP(3);
ALTER TABLE "offer_variants" ADD COLUMN "discountEndAt" TIMESTAMP(3);

-- basePrice positive (was previously enforced only by CreateOfferVariantDto's
-- @IsPositive() - now also structural).
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_base_price_positive_check" CHECK ("basePrice" > 0);

-- Manual salePrice: positive and strictly less than basePrice (a
-- "sale" that is not actually cheaper is not a sale).
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_sale_price_check" CHECK ("salePrice" IS NULL OR ("salePrice" > 0 AND "salePrice" < "basePrice"));

-- Scheduled discount: 0 < percent < 100 exclusive.
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_discount_percent_check" CHECK ("discountPercent" IS NULL OR ("discountPercent" > 0 AND "discountPercent" < 100));

-- All three scheduled-discount columns are NULL together, or all set
-- together with a real interval (start < end) - explicit AND/OR form,
-- not chained equality.
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_discount_window_check" CHECK (
  ("discountPercent" IS NULL AND "discountStartAt" IS NULL AND "discountEndAt" IS NULL)
  OR
  ("discountPercent" IS NOT NULL AND "discountStartAt" IS NOT NULL AND "discountEndAt" IS NOT NULL AND "discountStartAt" < "discountEndAt")
);

-- Mutual exclusivity (blocker 1): manual salePrice and the scheduled
-- relative discount never coexist - setting one clears the other
-- (application code); this is the structural backstop.
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_price_mode_exclusive_check" CHECK ("salePrice" IS NULL OR "discountPercent" IS NULL);

-- ============================================================
-- 4. PriceHistory (FR-PRICE-002) + honest MIGRATED_BASELINE backfill
-- ============================================================

CREATE TYPE "PriceChangeReason" AS ENUM ('MANUAL_EDIT', 'IMPORT', 'MIGRATED_BASELINE');

CREATE TABLE "price_history" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "salePrice" DECIMAL(10,2),
    "discountPercent" DECIMAL(5,2),
    "discountStartAt" TIMESTAMP(3),
    "discountEndAt" TIMESTAMP(3),
    "effectivePriceAtChange" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "reason" "PriceChangeReason" NOT NULL,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- Structural, not just a default a future write could override.
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_currency_ils_check" CHECK ("currency" = 'ILS');
-- Same "no real actor for the migration baseline" invariant as reason
-- itself - a non-baseline row must always name a real actor.
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_changed_by_check" CHECK (("reason" = 'MIGRATED_BASELINE') OR ("changedBy" IS NOT NULL));

CREATE INDEX "price_history_vendorId_offerVariantId_changedAt_idx" ON "price_history"("vendorId", "offerVariantId", "changedAt");

ALTER TABLE "price_history" ADD CONSTRAINT "price_history_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Baseline backfill: one row per pre-existing OfferVariant. No
-- scheduled discount existed before this migration (the columns did
-- not exist), so effectivePriceAtChange is exactly the old
-- "salePrice if set, else basePrice" rule - the same rule every
-- consumer already applied. changedAt uses the variant's own
-- createdAt (an honest, real past moment), never NOW(), and changedBy
-- is NULL (reason = MIGRATED_BASELINE, never attributed to a real
-- owner who did not make this change).
INSERT INTO "price_history" ("id", "vendorId", "offerVariantId", "basePrice", "salePrice", "effectivePriceAtChange", "reason", "changedBy", "changedAt")
SELECT gen_random_uuid(), v."vendorId", v."id", v."basePrice", v."salePrice", COALESCE(v."salePrice", v."basePrice"), 'MIGRATED_BASELINE', NULL, v."createdAt"
FROM "offer_variants" v;

-- ============================================================
-- 5. OfferVariantMedia: media type, alt text, ordering, limits
-- ============================================================

CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- Every pre-existing row is IMAGE by construction (no video kind ever
-- existed before this migration) - a certainty, not an approximation.
ALTER TABLE "offer_variant_media" ADD COLUMN "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "offer_variant_media" ADD COLUMN "altTextAr" TEXT;
ALTER TABLE "offer_variant_media" ADD COLUMN "altTextEn" TEXT;
ALTER TABLE "offer_variant_media" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- PRIMARY may only ever be an IMAGE - structural backstop alongside
-- the same rule enforced in the controller before insert.
ALTER TABLE "offer_variant_media" ADD CONSTRAINT "offer_variant_media_primary_image_only_check" CHECK (NOT ("kind" = 'PRIMARY' AND "mediaType" = 'VIDEO'));

DROP INDEX IF EXISTS "offer_variant_media_offerVariantId_idx";
CREATE INDEX "offer_variant_media_offerVariantId_sortOrder_idx" ON "offer_variant_media"("offerVariantId", "sortOrder");

-- ============================================================
-- 6. ImportBatch (D6, FR-IMPORT-004 partial - summary only)
-- ============================================================

CREATE TYPE "ImportBatchStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "totalRows" INTEGER NOT NULL,
    "importedCount" INTEGER,
    "skippedCount" INTEGER,
    "invalidCount" INTEGER,
    "conflictCount" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_batches_vendorId_createdAt_idx" ON "import_batches"("vendorId", "createdAt");

ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
