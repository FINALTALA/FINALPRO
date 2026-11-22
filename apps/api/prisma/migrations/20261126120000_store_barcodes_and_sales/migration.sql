-- Barcodes and in-store sales (2026-11-20). Additive only: four enums, one
-- enum value, four new tables. No existing column, row or constraint is
-- changed. OfferVariant.storeInventoryBarcode (SIB-...) is left exactly as
-- it is (the cashier only reads it, as a legacy fallback).
--
--  * offer_barcodes: a PRODUCT's barcodes (up to 10, application-enforced
--    under a row lock on the product), unique per store, one primary at
--    most (partial unique index), each code shaped by its format (CHECK).
--  * vendor_code_counters: per-store counters for generated barcodes and
--    in-store sale numbers.
--  * store_sales / store_sale_items: a real in-store sale - price, colour,
--    size, branch, who sold it; each line points at its own SALE stock
--    movement (and, after a same-day whole-sale void, at the
--    STORE_SALE_VOID movement that put the stock back).

-- CreateEnum
CREATE TYPE "BarcodeSource" AS ENUM ('EXTERNAL', 'GENERATED');

-- CreateEnum
CREATE TYPE "BarcodeFormat" AS ENUM ('EAN13', 'EAN8', 'UPCA', 'CODE128');

-- CreateEnum
CREATE TYPE "StoreSalePaymentMethod" AS ENUM ('CASH', 'CARD');

-- CreateEnum
CREATE TYPE "StoreSaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- AlterEnum (not used by this migration itself)
ALTER TYPE "StockMovementReason" ADD VALUE 'STORE_SALE_VOID';

-- CreateTable
CREATE TABLE "offer_barcodes" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "format" "BarcodeFormat" NOT NULL,
    "source" "BarcodeSource" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_barcodes_pkey" PRIMARY KEY ("id"),
    -- The stored (normalized) shape of each format; UPCA is kept in its
    -- 13-digit EAN form. The check digit itself is verified by the
    -- application (common/barcode.util.ts).
    CONSTRAINT "offer_barcodes_code_shape_check" CHECK (
      ("format" = 'EAN13' AND "code" ~ '^[0-9]{13}$')
      OR ("format" = 'EAN8' AND "code" ~ '^[0-9]{8}$')
      OR ("format" = 'UPCA' AND "code" ~ '^0[0-9]{12}$')
      OR ("format" = 'CODE128' AND "code" ~ '^[A-Z0-9-]{4,32}$'
          AND "code" !~ '^(SIB|PPB)-')
    ),
    -- A generated code is always an EAN-13 in the GS1 restricted-circulation
    -- range (leading "2") - for in-store use, never a registered GTIN.
    CONSTRAINT "offer_barcodes_generated_shape_check" CHECK (
      "source" <> 'GENERATED' OR ("format" = 'EAN13' AND "code" ~ '^2')
    )
);

-- CreateTable
CREATE TABLE "vendor_code_counters" (
    "vendorId" TEXT NOT NULL,
    "lastBarcodeSeq" BIGINT NOT NULL DEFAULT 0,
    "lastSaleNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vendor_code_counters_pkey" PRIMARY KEY ("vendorId"),
    CONSTRAINT "vendor_code_counters_nonnegative_check" CHECK ("lastBarcodeSeq" >= 0 AND "lastSaleNumber" >= 0)
);

-- CreateTable
CREATE TABLE "store_sales" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "saleNumber" INTEGER NOT NULL,
    "status" "StoreSaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "paymentMethod" "StoreSalePaymentMethod" NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "soldById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "store_sales_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_sales_currency_check" CHECK ("currency" = 'ILS'),
    CONSTRAINT "store_sales_total_check" CHECK ("total" >= 0),
    CONSTRAINT "store_sales_number_check" CHECK ("saleNumber" > 0),
    -- The void facts exist exactly when the sale is voided; the reason is never blank.
    CONSTRAINT "store_sales_void_check" CHECK (
      ("status" = 'VOIDED') = ("voidedAt" IS NOT NULL)
      AND ("voidedAt" IS NULL) = ("voidedById" IS NULL)
      AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
      AND ("voidReason" IS NULL OR length(btrim("voidReason")) > 0)
    )
);

-- CreateTable
CREATE TABLE "store_sale_items" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "storeSaleId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(10,2) NOT NULL,
    "titleArSnapshot" TEXT NOT NULL,
    "titleEnSnapshot" TEXT NOT NULL,
    "colorNameArSnapshot" TEXT,
    "colorNameEnSnapshot" TEXT,
    "sizeCodeSnapshot" TEXT,
    "sizeLabelSnapshot" TEXT,
    "scannedCode" TEXT,
    "saleMovementId" TEXT NOT NULL,
    "voidMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_sale_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_sale_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "store_sale_items_money_check" CHECK ("unitPrice" >= 0 AND "lineTotal" = "unitPrice" * "quantity")
);

-- CreateIndex
CREATE INDEX "offer_barcodes_vendorOfferId_idx" ON "offer_barcodes"("vendorOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_barcodes_vendorId_code_key" ON "offer_barcodes"("vendorId", "code");

-- One primary barcode per product at most.
CREATE UNIQUE INDEX "offer_barcodes_one_primary_per_offer" ON "offer_barcodes"("vendorOfferId") WHERE "isPrimary";

-- CreateIndex
CREATE INDEX "store_sales_vendorId_branchId_createdAt_idx" ON "store_sales"("vendorId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "store_sales_vendorId_createdAt_idx" ON "store_sales"("vendorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "store_sales_vendorId_saleNumber_key" ON "store_sales"("vendorId", "saleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "store_sales_vendorId_id_key" ON "store_sales"("vendorId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_sale_items_saleMovementId_key" ON "store_sale_items"("saleMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "store_sale_items_voidMovementId_key" ON "store_sale_items"("voidMovementId");

-- CreateIndex
CREATE INDEX "store_sale_items_storeSaleId_idx" ON "store_sale_items"("storeSaleId");

-- CreateIndex
CREATE INDEX "store_sale_items_vendorId_vendorOfferId_idx" ON "store_sale_items"("vendorId", "vendorOfferId");

-- CreateIndex
CREATE INDEX "store_sale_items_offerVariantId_idx" ON "store_sale_items"("offerVariantId");

-- AddForeignKey
ALTER TABLE "offer_barcodes" ADD CONSTRAINT "offer_barcodes_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_barcodes" ADD CONSTRAINT "offer_barcodes_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_barcodes" ADD CONSTRAINT "offer_barcodes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_code_counters" ADD CONSTRAINT "vendor_code_counters_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sales" ADD CONSTRAINT "store_sales_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sales" ADD CONSTRAINT "store_sales_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sales" ADD CONSTRAINT "store_sales_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sales" ADD CONSTRAINT "store_sales_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_vendorId_storeSaleId_fkey" FOREIGN KEY ("vendorId", "storeSaleId") REFERENCES "store_sales"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_saleMovementId_fkey" FOREIGN KEY ("saleMovementId") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_sale_items" ADD CONSTRAINT "store_sale_items_voidMovementId_fkey" FOREIGN KEY ("voidMovementId") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
