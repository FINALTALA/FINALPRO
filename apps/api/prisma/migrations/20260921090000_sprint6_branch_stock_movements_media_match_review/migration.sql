-- Sprint 6 (RB-INV-002/003/005, RB-MATCH-001/002). Every table here is
-- brand-new and empty - nothing to backfill, nothing in Sprint 1-5's
-- data can violate any of these new constraints. Two invariants are
-- hand-written (not representable in Prisma's schema DSL), the same
-- already-established pattern as VendorUser's role/branchId CHECK and
-- StaffInvite's partial pending-invite index:
--   1. branch_stock.quantity can never go negative at the database
--      layer, not just in application code (RB-INV-005).
--   2. offer_variant_media allows at most one PRIMARY row per offer
--      variant (RB-MATCH-001) - a partial unique index, not a plain
--      one, so any number of ADDITIONAL rows stay unrestricted.

-- CreateEnum
CREATE TYPE "StockMovementReason" AS ENUM ('DAMAGE', 'LOSS', 'COUNT_CORRECTION');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PRIMARY', 'ADDITIONAL');

-- CreateEnum
CREATE TYPE "MatchReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "branch_stock" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_stock_pkey" PRIMARY KEY ("id")
);

-- RB-INV-005: the real safety net against negative stock is the
-- atomic conditional UPDATE in InventoryController (an UPDATE/INSERT
-- ... ON CONFLICT statement whose WHERE clause never even attempts a
-- write that would go negative) - this CHECK is the DB-level guarantee
-- that holds even against a direct write bypassing that endpoint.
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_quantity_non_negative" CHECK ("quantity" >= 0);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "resultingQuantity" INTEGER NOT NULL,
    "reason" "StockMovementReason" NOT NULL,
    "reasonNote" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_variant_media" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL DEFAULT 'ADDITIONAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_variant_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_review_candidates" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "canonicalVariantId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "status" "MatchReviewStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "match_review_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_stock_vendorId_idx" ON "branch_stock"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_stock_branchId_offerVariantId_key" ON "branch_stock"("branchId", "offerVariantId");

-- CreateIndex
CREATE INDEX "stock_movements_vendorId_branchId_offerVariantId_idx" ON "stock_movements"("vendorId", "branchId", "offerVariantId");

-- CreateIndex
CREATE INDEX "stock_movements_createdAt_idx" ON "stock_movements"("createdAt");

-- CreateIndex
CREATE INDEX "offer_variant_media_offerVariantId_idx" ON "offer_variant_media"("offerVariantId");

-- RB-MATCH-001: at most one PRIMARY image per offer variant. Partial
-- unique index (WHERE "kind" = 'PRIMARY') so any number of ADDITIONAL
-- rows for the same variant remain unrestricted - only representable
-- by hand-written SQL, documented on OfferVariantMedia in schema.prisma
-- for human readers only (invisible to `prisma migrate diff`, same as
-- every other partial index this project already has).
CREATE UNIQUE INDEX "offer_variant_media_primary_per_variant_key" ON "offer_variant_media"("offerVariantId") WHERE "kind" = 'PRIMARY';

-- CreateIndex
CREATE INDEX "match_review_candidates_vendorId_status_idx" ON "match_review_candidates"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "match_review_candidates_offerVariantId_canonicalVariantId_key" ON "match_review_candidates"("offerVariantId", "canonicalVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_variants_vendorId_id_key" ON "offer_variants"("vendorId", "id");

-- AddForeignKey
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_variant_media" ADD CONSTRAINT "offer_variant_media_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_variant_media" ADD CONSTRAINT "offer_variant_media_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_review_candidates" ADD CONSTRAINT "match_review_candidates_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_review_candidates" ADD CONSTRAINT "match_review_candidates_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_review_candidates" ADD CONSTRAINT "match_review_candidates_canonicalVariantId_fkey" FOREIGN KEY ("canonicalVariantId") REFERENCES "canonical_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
