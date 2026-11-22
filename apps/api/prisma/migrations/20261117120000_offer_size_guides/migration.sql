-- Phase A+ (product-entry wizard): a product's own measurements table.
-- The seller enters the garment's own measurements (cm) for each of the
-- product's sizes; they are stored as a size guide of the new kind OFFER,
-- tied to exactly one offer, so the existing versioning (one PUBLISHED
-- version, earlier ones RETIRED and kept) and the order-line snapshot
-- (branch_order_items.sizeGuideVersionIdSnapshot) apply unchanged: every
-- edit after publishing is a new version and old orders keep theirs.
-- Purely additive: a new enum value, one nullable column, its unique
-- index, its foreign key and one CHECK. No existing row can violate it
-- (every existing guide is STANDARD or PRODUCT with no offer).
--
-- `ALTER TYPE ... ADD VALUE` is committed on its own before anything
-- below compares against it (see 20260919140000's note).

-- AlterEnum
BEGIN;
ALTER TYPE "SizeGuideKind" ADD VALUE 'OFFER';
COMMIT;

-- AlterTable
ALTER TABLE "size_guides" ADD COLUMN "vendorOfferId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "size_guides_vendorOfferId_key" ON "size_guides"("vendorOfferId");

-- AddForeignKey
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_vendorOfferId_fkey" FOREIGN KEY ("vendorOfferId") REFERENCES "vendor_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An OFFER guide belongs to exactly one offer; any other kind to none.
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_kind_offer" CHECK (
  ("kind" = 'OFFER') = ("vendorOfferId" IS NOT NULL)
);
