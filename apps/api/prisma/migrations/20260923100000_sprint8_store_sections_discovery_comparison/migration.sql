-- Sprint 8 (RB-STOREF-002, RB-STOREF-004, RB-COMP-001). Every table here
-- is brand-new - nothing to backfill. vendor_applicable_categories and
-- store_sections/store_section_offers are additive-only extensions of
-- the existing vendors/vendor_offers tables (no column added to either),
-- so no existing Sprint 1-7 row is touched by this migration at all.

-- CreateEnum
CREATE TYPE "StoreApplicableCategory" AS ENUM ('WOMEN', 'MEN', 'KIDS', 'ACCESSORIES');

-- CreateTable
CREATE TABLE "vendor_applicable_categories" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "category" "StoreApplicableCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_applicable_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_applicable_categories_vendorId_category_key" ON "vendor_applicable_categories"("vendorId", "category");

-- AddForeignKey
ALTER TABLE "vendor_applicable_categories" ADD CONSTRAINT "vendor_applicable_categories_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "store_sections" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_sections_vendorId_sortOrder_idx" ON "store_sections"("vendorId", "sortOrder");

-- CreateIndex (backs store_section_offers' own composite FK below - see
-- StoreSection's schema.prisma comment; id alone is already globally
-- unique, this adds no new uniqueness, only a composite-FK target).
CREATE UNIQUE INDEX "store_sections_vendorId_id_key" ON "store_sections"("vendorId", "id");

-- AddForeignKey
ALTER TABLE "store_sections" ADD CONSTRAINT "store_sections_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "store_section_offers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_section_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_section_offers_sectionId_offerId_key" ON "store_section_offers"("sectionId", "offerId");

-- CreateIndex
CREATE INDEX "store_section_offers_vendorId_offerId_idx" ON "store_section_offers"("vendorId", "offerId");

-- AddForeignKey (composite - tenant-safety: a join row's sectionId must
-- belong to the SAME vendorId as the row itself, not merely exist
-- somewhere - see StoreSectionOffer's own schema.prisma comment).
ALTER TABLE "store_section_offers" ADD CONSTRAINT "store_section_offers_vendorId_sectionId_fkey" FOREIGN KEY ("vendorId", "sectionId") REFERENCES "store_sections"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - same reasoning, against vendor_offers' own
-- (vendorId, id) unique index).
ALTER TABLE "store_section_offers" ADD CONSTRAINT "store_section_offers_vendorId_offerId_fkey" FOREIGN KEY ("vendorId", "offerId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
