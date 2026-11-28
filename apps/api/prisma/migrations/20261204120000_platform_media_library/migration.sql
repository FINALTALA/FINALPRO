-- VIA phase 5: the platform Media Library. Additive only: new enums and
-- two new tables; no existing table or row changes.
CREATE TYPE "MediaCategory" AS ENUM ('HOMEPAGE', 'TRENDING', 'ADS', 'COLLECTIONS');
CREATE TYPE "PlatformMediaKind" AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE "MediaValidationState" AS ENUM ('PENDING', 'VALID');
CREATE TYPE "MediaStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'PURGING');
CREATE TYPE "MediaUsageState" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'REVISION');

CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MediaCategory" NOT NULL,
    "kind" "PlatformMediaKind" NOT NULL,
    "mimeType" TEXT,
    "storageKey" TEXT,
    "sizeBytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "sha256" TEXT,
    "validationState" "MediaValidationState" NOT NULL DEFAULT 'PENDING',
    "status" "MediaStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploadedById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "purgeRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- A VALID asset always carries its full validated metadata.
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_valid_shape" CHECK (
  "validationState" = 'PENDING'
  OR ("mimeType" IS NOT NULL AND "storageKey" IS NOT NULL AND "sizeBytes" > 0
      AND "width" > 0 AND "height" > 0 AND "sha256" IS NOT NULL
      AND ("kind" = 'IMAGE' OR ("durationMs" > 0 AND "videoCodec" IS NOT NULL)))
);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_name_length"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_archive_shape" CHECK (
  ("status" = 'ACTIVE' AND "archivedAt" IS NULL)
  OR ("status" IN ('ARCHIVED', 'PURGING') AND "archivedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "media_assets_storageKey_key" ON "media_assets"("storageKey");
CREATE INDEX "media_assets_status_category_createdAt_idx" ON "media_assets"("status", "category", "createdAt");
CREATE INDEX "media_assets_validationState_createdAt_idx" ON "media_assets"("validationState", "createdAt");

CREATE TABLE "media_usages" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL DEFAULT '',
    "state" "MediaUsageState" NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_usages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_usages_assetId_ownerType_ownerId_revisionId_state_key" ON "media_usages"("assetId", "ownerType", "ownerId", "revisionId", "state");
CREATE INDEX "media_usages_ownerType_ownerId_idx" ON "media_usages"("ownerType", "ownerId");

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_usages" ADD CONSTRAINT "media_usages_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
