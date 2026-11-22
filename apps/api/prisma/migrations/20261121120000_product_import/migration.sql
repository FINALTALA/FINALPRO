-- The product import (2026-11-18): an XLSX file is CHECKED first (nothing
-- created), then the owner confirms the products she chooses and they are
-- created as wizard drafts - all of them in one transaction, or none.
-- Additive only: existing batches are the older flat import (LEGACY_FLAT)
-- and keep every value they had; no draft changes.
-- Runs after 20261120120000_store_collections.

-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as the
-- new values; nothing below uses them, so this file stays one transaction.
ALTER TYPE "ImportBatchStatus" ADD VALUE 'CHECKED';
ALTER TYPE "ImportBatchStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "ImportBatchStatus" ADD VALUE 'EXPIRED';

CREATE TYPE "ImportBatchKind" AS ENUM ('LEGACY_FLAT', 'PRODUCT_DRAFTS');

ALTER TABLE "import_batches"
  ADD COLUMN "kind" "ImportBatchKind" NOT NULL DEFAULT 'LEGACY_FLAT',
  ADD COLUMN "fileSha256" TEXT,
  ADD COLUMN "checkResult" JSONB,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "draftsCreated" INTEGER,
  ADD COLUMN "productsRejected" INTEGER;

CREATE INDEX "import_batches_vendorId_kind_fileSha256_idx" ON "import_batches"("vendorId", "kind", "fileSha256");

ALTER TABLE "offer_drafts"
  ADD COLUMN "importBatchId" TEXT,
  ADD COLUMN "importRef" TEXT;

ALTER TABLE "offer_drafts"
  ADD CONSTRAINT "offer_drafts_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "offer_drafts_importBatchId_importRef_key" ON "offer_drafts"("importBatchId", "importRef");
