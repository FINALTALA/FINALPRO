-- Sprint 3 (EPIC-CAT / EPIC-MATCH / EPIC-VEND subset): BL-CAT-001,
-- BL-CAT-004b, BL-MATCH-001, BL-MATCH-002, BL-VEND-002..004. See
-- schema.prisma's comments on each new model for the exact SRS
-- traceability and the deliberate exclusions (AttributeDefinition/
-- AttributeOption, ProductMedia, OfferBranchInventory, PriceHistory,
-- ProductMatch, ImportJob/ImportRow, FxRate - all later-sprint scope).
--
-- PlatformRole (on users) and SubscriptionStatus/VendorSubscription are
-- new infrastructure this sprint needed but that isn't itself a listed
-- backlog item: FR-VEND-003 requires a "vendor-verification-reviewer"
-- role and the SRS never specifies a data-model mechanism for platform
-- staff roles (Part 3 has no such entity), so this is a minimal,
-- narrowly-scoped addition - just enough to gate the reviewer-decision
-- endpoint, not a general staff-role system.
--
-- As with every prior migration here, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in the earlier migrations. Left alone again.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('VERIFICATION_REVIEWER', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CanonicalProductStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "OfferCondition" AS ENUM ('NEW', 'USED', 'REFURBISHED', 'OPEN_BOX');

-- CreateEnum
CREATE TYPE "OfferIdentifierType" AS ENUM ('GTIN', 'EAN', 'UPC', 'ISBN', 'MPN');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM');

-- AlterEnum
ALTER TYPE "BranchVerificationStatus" ADD VALUE 'RESUBMISSION_REQUESTED';

-- AlterTable
ALTER TABLE "store_branches" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "platformRole" "PlatformRole";

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_products" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "status" "CanonicalProductStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_product_variants" (
    "id" TEXT NOT NULL,
    "canonicalProductId" TEXT NOT NULL,
    "structuralAttributes" JSONB NOT NULL,
    "mpn" TEXT,
    "gtin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_offers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "canonicalProductId" TEXT,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_variants" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "canonicalVariantId" TEXT,
    "sellerSku" TEXT NOT NULL,
    "condition" "OfferCondition" NOT NULL DEFAULT 'NEW',
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "basePrice" DECIMAL(10,2) NOT NULL,
    "salePrice" DECIMAL(10,2),
    "specsTextAr" TEXT,
    "specsTextEn" TEXT,
    "identifierType" "OfferIdentifierType",
    "identifierValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_subscriptions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "graceDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "brands_normalizedName_key" ON "brands"("normalizedName");

-- CreateIndex
CREATE INDEX "canonical_products_brandId_idx" ON "canonical_products"("brandId");

-- CreateIndex
CREATE INDEX "canonical_products_categoryId_idx" ON "canonical_products"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_product_variants_gtin_key" ON "canonical_product_variants"("gtin");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_product_variants_canonicalProductId_mpn_key" ON "canonical_product_variants"("canonicalProductId", "mpn");

-- CreateIndex
CREATE INDEX "vendor_offers_vendorId_idx" ON "vendor_offers"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_offers_canonicalProductId_idx" ON "vendor_offers"("canonicalProductId");

-- CreateIndex
CREATE INDEX "offer_variants_vendorOfferId_idx" ON "offer_variants"("vendorOfferId");

-- CreateIndex
CREATE INDEX "offer_variants_canonicalVariantId_idx" ON "offer_variants"("canonicalVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_variants_vendorId_sellerSku_key" ON "offer_variants"("vendorId", "sellerSku");

-- CreateIndex
CREATE INDEX "vendor_subscriptions_vendorId_idx" ON "vendor_subscriptions"("vendorId");

-- AddForeignKey
ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_product_variants" ADD CONSTRAINT "canonical_product_variants_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_offers" ADD CONSTRAINT "vendor_offers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_offers" ADD CONSTRAINT "vendor_offers_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_vendorOfferId_fkey" FOREIGN KEY ("vendorOfferId") REFERENCES "vendor_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_canonicalVariantId_fkey" FOREIGN KEY ("canonicalVariantId") REFERENCES "canonical_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
