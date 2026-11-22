-- Bulk publishing of drafts (2026-11-18, phase B of images in bulk): the
-- owner chooses drafts (an import's batch), a read-only preflight runs the
-- publish gate on each, and only the ready ones she confirms are published
-- - each one on its own, whole or not at all - by a run that the server
-- carries on even if the window is closed. One run at a time per store.
-- Followers get ONE summary notification per run, not one per product.
-- Additive only. Runs after 20261122120000_product_import_images.

-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as the
-- new value; nothing below uses it, so this file stays one transaction.
ALTER TYPE "NotificationType" ADD VALUE 'FOLLOWED_STORE_NEW_PRODUCTS';

CREATE TYPE "BulkPublishRunStatus" AS ENUM ('RUNNING', 'DONE');
CREATE TYPE "BulkPublishItemState" AS ENUM ('PENDING', 'PUBLISHED', 'REFUSED', 'ALREADY');

CREATE TABLE "bulk_publish_runs" (
  "id" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "importBatchId" TEXT,
  "status" "BulkPublishRunStatus" NOT NULL DEFAULT 'RUNNING',
  "correlationId" TEXT NOT NULL,
  "total" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "bulk_publish_runs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "bulk_publish_runs"
  ADD CONSTRAINT "bulk_publish_runs_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bulk_publish_runs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bulk_publish_runs_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "bulk_publish_runs_vendorId_createdAt_idx" ON "bulk_publish_runs"("vendorId", "createdAt");
-- one run at a time per store: a second start (another tab) is refused by the database itself
CREATE UNIQUE INDEX "bulk_publish_runs_one_running_per_vendor" ON "bulk_publish_runs"("vendorId") WHERE "status" = 'RUNNING';

CREATE TABLE "bulk_publish_items" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "state" "BulkPublishItemState" NOT NULL DEFAULT 'PENDING',
  "offerId" TEXT,
  "problems" JSONB,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "bulk_publish_items_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "bulk_publish_items"
  ADD CONSTRAINT "bulk_publish_items_runId_fkey" FOREIGN KEY ("runId") REFERENCES "bulk_publish_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "bulk_publish_items_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "offer_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "bulk_publish_items_runId_draftId_key" ON "bulk_publish_items"("runId", "draftId");
CREATE INDEX "bulk_publish_items_runId_position_idx" ON "bulk_publish_items"("runId", "position");
