-- Images in bulk (2026-11-18): the product import takes a ZIP of images
-- with its XLSX file. The check keeps the images it accepted in a private
-- staging folder (outside the public uploads); confirming copies them to
-- the public uploads and creates complete drafts, all or none.
-- Additive only: no existing row changes; offer_drafts is untouched (its
-- payload and its upload ledger already hold images).
-- Runs after 20261121120000_product_import.

-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as the
-- new value; nothing below uses it, so this file stays one transaction.
ALTER TYPE "ImportBatchStatus" ADD VALUE 'CONFIRMING';

ALTER TABLE "import_batches"
  ADD COLUMN "zipFileName" TEXT,
  ADD COLUMN "zipSha256" TEXT,
  ADD COLUMN "zipBytes" INTEGER,
  ADD COLUMN "imagesStaged" INTEGER,
  ADD COLUMN "plannedUploads" JSONB,
  ADD COLUMN "confirmStartedAt" TIMESTAMP(3);

-- the staging clean-up looks for expired checks and interrupted confirms
CREATE INDEX "import_batches_kind_status_expiresAt_idx" ON "import_batches"("kind", "status", "expiresAt");
