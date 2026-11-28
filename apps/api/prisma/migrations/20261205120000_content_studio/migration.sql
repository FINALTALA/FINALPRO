-- VIA phase 6: Content Studio. Additive only: new enums and four new
-- tables; no existing table or row changes.
CREATE TYPE "ContentPageKey" AS ENUM ('HOMEPAGE', 'TRENDING', 'ADS');
CREATE TYPE "ContentRevisionSource" AS ENUM ('IMPORT', 'PUBLISH', 'SCHEDULE', 'RESTORE');
CREATE TYPE "ContentScheduleStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'REPLACED');

CREATE TABLE "content_pages" (
    "key" "ContentPageKey" NOT NULL,
    "draft" JSONB NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "draftUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "draftUpdatedById" TEXT,
    "publishedRevisionId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "unpublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "content_pages_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "content_pages_draft_version_positive" CHECK ("draftVersion" >= 1)
);
CREATE UNIQUE INDEX "content_pages_publishedRevisionId_key" ON "content_pages"("publishedRevisionId");

CREATE TABLE "content_revisions" (
    "id" TEXT NOT NULL,
    "pageKey" "ContentPageKey" NOT NULL,
    "number" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "source" "ContentRevisionSource" NOT NULL,
    "restoredFromId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "content_revisions_number_positive" CHECK ("number" >= 1)
);
CREATE UNIQUE INDEX "content_revisions_pageKey_number_key" ON "content_revisions"("pageKey", "number");

-- Revisions are immutable: only the archive fields may change.
CREATE FUNCTION content_revisions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."document" IS DISTINCT FROM OLD."document"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."pageKey" IS DISTINCT FROM OLD."pageKey"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'content revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER content_revisions_immutable BEFORE UPDATE ON "content_revisions"
  FOR EACH ROW EXECUTE FUNCTION content_revisions_immutable();

CREATE TABLE "content_schedules" (
    "id" TEXT NOT NULL,
    "pageKey" "ContentPageKey" NOT NULL,
    "revisionId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "localTime" TEXT NOT NULL,
    "status" "ContentScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "failureDetails" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "content_schedules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "content_schedules_status_runAt_idx" ON "content_schedules"("status", "runAt");
CREATE INDEX "content_schedules_pageKey_createdAt_idx" ON "content_schedules"("pageKey", "createdAt");
-- One pending publication per page.
CREATE UNIQUE INDEX "content_schedules_one_pending_per_page" ON "content_schedules"("pageKey") WHERE "status" = 'PENDING';

CREATE TABLE "content_issues" (
    "id" TEXT NOT NULL,
    "pageKey" "ContentPageKey" NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL DEFAULT '',
    "field" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "content_issues_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "content_issues_revisionId_sectionId_itemId_field_key" ON "content_issues"("revisionId", "sectionId", "itemId", "field");
CREATE INDEX "content_issues_pageKey_resolvedAt_idx" ON "content_issues"("pageKey", "resolvedAt");

ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_publishedRevisionId_fkey" FOREIGN KEY ("publishedRevisionId") REFERENCES "content_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_pageKey_fkey" FOREIGN KEY ("pageKey") REFERENCES "content_pages"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_schedules" ADD CONSTRAINT "content_schedules_pageKey_fkey" FOREIGN KEY ("pageKey") REFERENCES "content_pages"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_schedules" ADD CONSTRAINT "content_schedules_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "content_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_issues" ADD CONSTRAINT "content_issues_pageKey_fkey" FOREIGN KEY ("pageKey") REFERENCES "content_pages"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
