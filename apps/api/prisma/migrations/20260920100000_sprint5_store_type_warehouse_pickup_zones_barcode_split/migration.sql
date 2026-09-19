-- Sprint 5 (RB-STORE-001, RB-STORE-002, RB-INV-001). Every change here
-- is additive and safe against existing Sprint 1-4 data:
--   - vendors.storeType defaults to 'PHYSICAL', preserving every
--     existing vendor row's prior implicit meaning (only StoreBranch.
--     isPhysical existed before this).
--   - warehouses / pickup_points / vendor_delivery_zones are brand-new,
--     empty tables - nothing to backfill.
--   - canonical_product_variants.platformProductBarcode and
--     offer_variants.storeInventoryBarcode are new required+unique
--     columns on tables that may already have Sprint 3 rows, so each is
--     added nullable first, backfilled with a deterministic id-derived
--     value (the exact same scheme application code uses for new rows -
--     see apps/api/src/common/barcode.util.ts), then set NOT NULL. No
--     pre-existing column is touched.

-- CreateEnum
CREATE TYPE "StoreType" AS ENUM ('PHYSICAL', 'ONLINE_ONLY', 'HYBRID');

-- CreateEnum
CREATE TYPE "DeliveryZoneRegion" AS ENUM ('WEST_BANK', 'JERUSALEM', 'INSIDE');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN "storeType" "StoreType" NOT NULL DEFAULT 'PHYSICAL';

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "addressNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_vendorId_key" ON "warehouses"("vendorId");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "pickup_points" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "addressNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pickup_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pickup_points_vendorId_idx" ON "pickup_points"("vendorId");

-- AddForeignKey
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "vendor_delivery_zones" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "region" "DeliveryZoneRegion" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_delivery_zones_vendorId_region_key" ON "vendor_delivery_zones"("vendorId", "region");

-- AddForeignKey
ALTER TABLE "vendor_delivery_zones" ADD CONSTRAINT "vendor_delivery_zones_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: canonical_product_variants.platformProductBarcode
ALTER TABLE "canonical_product_variants" ADD COLUMN "platformProductBarcode" TEXT;

-- Backfill (RB-INV-001): every pre-existing row gets a stable,
-- deterministic code derived from its own id - see
-- common/barcode.util.ts's generatePlatformProductBarcode for the
-- identical TypeScript-side computation new rows use.
UPDATE "canonical_product_variants"
SET "platformProductBarcode" = 'PPB-' || upper(substr(replace(id, '-', ''), 1, 10))
WHERE "platformProductBarcode" IS NULL;

ALTER TABLE "canonical_product_variants" ALTER COLUMN "platformProductBarcode" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "canonical_product_variants_platformProductBarcode_key" ON "canonical_product_variants"("platformProductBarcode");

-- AlterTable: offer_variants.storeInventoryBarcode
ALTER TABLE "offer_variants" ADD COLUMN "storeInventoryBarcode" TEXT;

-- Backfill (RB-INV-001): same id-derived scheme, see
-- common/barcode.util.ts's generateStoreInventoryBarcode.
UPDATE "offer_variants"
SET "storeInventoryBarcode" = 'SIB-' || upper(substr(replace(id, '-', ''), 1, 10))
WHERE "storeInventoryBarcode" IS NULL;

ALTER TABLE "offer_variants" ALTER COLUMN "storeInventoryBarcode" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "offer_variants_vendorId_storeInventoryBarcode_key" ON "offer_variants"("vendorId", "storeInventoryBarcode");
