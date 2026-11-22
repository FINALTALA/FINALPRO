-- CreateEnum
CREATE TYPE "SizeGuideKind" AS ENUM ('STANDARD', 'PRODUCT');

-- CreateEnum
CREATE TYPE "SizeGuideVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "SizeMeasureKey" AS ENUM ('CHEST', 'WAIST', 'HIP', 'LENGTH', 'SHOULDER', 'SLEEVE', 'INSEAM', 'FOOT_LENGTH', 'HEIGHT');

-- CreateEnum
CREATE TYPE "SizeMeasureBasis" AS ENUM ('BODY', 'GARMENT');

-- CreateEnum
CREATE TYPE "SizeGuideRequestStatus" AS ENUM ('PENDING', 'RESOLVED', 'REJECTED');

-- AlterTable
ALTER TABLE "branch_order_items" ADD COLUMN     "sizeGuideVersionIdSnapshot" TEXT;

-- AlterTable
ALTER TABLE "vendor_offers" ADD COLUMN     "sizeGuideId" TEXT;

-- CreateTable
CREATE TABLE "size_guides" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "kind" "SizeGuideKind" NOT NULL,
    "canonicalProductId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "size_guides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_guide_versions" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SizeGuideVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "basis" "SizeMeasureBasis" NOT NULL DEFAULT 'BODY',
    "notesAr" TEXT,
    "notesEn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "size_guide_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_guide_measurements" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" "SizeMeasureKey" NOT NULL,
    "isRange" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "size_guide_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_guide_rows" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sizeCode" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "size_guide_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_guide_cells" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "measurementId" TEXT NOT NULL,
    "minTenths" INTEGER NOT NULL,
    "maxTenths" INTEGER,

    CONSTRAINT "size_guide_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_guide_applicability" (
    "guideId" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "audience" "ProductAudience" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "size_guide_applicability_pkey" PRIMARY KEY ("guideId","categoryCode","audience")
);

-- CreateTable
CREATE TABLE "size_guide_requests" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SizeGuideRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resolvedGuideId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "size_guide_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "size_guides_code_key" ON "size_guides"("code");

-- CreateIndex
CREATE INDEX "size_guides_kind_idx" ON "size_guides"("kind");

-- CreateIndex
CREATE INDEX "size_guide_versions_guideId_status_idx" ON "size_guide_versions"("guideId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "size_guide_versions_guideId_version_key" ON "size_guide_versions"("guideId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "size_guide_measurements_versionId_key_key" ON "size_guide_measurements"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "size_guide_rows_versionId_sizeCode_key" ON "size_guide_rows"("versionId", "sizeCode");

-- CreateIndex
CREATE UNIQUE INDEX "size_guide_cells_rowId_measurementId_key" ON "size_guide_cells"("rowId", "measurementId");

-- CreateIndex
CREATE INDEX "size_guide_applicability_categoryCode_audience_idx" ON "size_guide_applicability"("categoryCode", "audience");

-- CreateIndex
CREATE INDEX "size_guide_requests_status_createdAt_idx" ON "size_guide_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "size_guide_requests_vendorId_idx" ON "size_guide_requests"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_offers_sizeGuideId_idx" ON "vendor_offers"("sizeGuideId");

-- AddForeignKey
ALTER TABLE "vendor_offers" ADD CONSTRAINT "vendor_offers_sizeGuideId_fkey" FOREIGN KEY ("sizeGuideId") REFERENCES "size_guides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_order_items" ADD CONSTRAINT "branch_order_items_sizeGuideVersionIdSnapshot_fkey" FOREIGN KEY ("sizeGuideVersionIdSnapshot") REFERENCES "size_guide_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_versions" ADD CONSTRAINT "size_guide_versions_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "size_guides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_versions" ADD CONSTRAINT "size_guide_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_measurements" ADD CONSTRAINT "size_guide_measurements_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "size_guide_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_rows" ADD CONSTRAINT "size_guide_rows_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "size_guide_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_rows" ADD CONSTRAINT "size_guide_rows_sizeCode_fkey" FOREIGN KEY ("sizeCode") REFERENCES "taxonomy_sizes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_cells" ADD CONSTRAINT "size_guide_cells_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "size_guide_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_cells" ADD CONSTRAINT "size_guide_cells_measurementId_fkey" FOREIGN KEY ("measurementId") REFERENCES "size_guide_measurements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_applicability" ADD CONSTRAINT "size_guide_applicability_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "size_guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_applicability" ADD CONSTRAINT "size_guide_applicability_categoryCode_audience_fkey" FOREIGN KEY ("categoryCode", "audience") REFERENCES "taxonomy_category_audiences"("categoryCode", "audience") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_resolvedGuideId_fkey" FOREIGN KEY ("resolvedGuideId") REFERENCES "size_guides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PD-4 hand-written constraints (not expressible in Prisma's DSL).

-- A PRODUCT guide belongs to exactly one canonical product; a STANDARD
-- guide to none. At most one PRODUCT guide per canonical product.
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_kind_product" CHECK (
  ("kind" = 'PRODUCT') = ("canonicalProductId" IS NOT NULL)
);
CREATE UNIQUE INDEX "size_guides_one_product_guide" ON "size_guides"("canonicalProductId") WHERE "kind" = 'PRODUCT';
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_code_format" CHECK ("code" ~ '^[a-z0-9][a-z0-9-]{1,59}$');
ALTER TABLE "size_guides" ADD CONSTRAINT "size_guides_names" CHECK (
  char_length(btrim("nameAr")) BETWEEN 1 AND 120 AND char_length(btrim("nameEn")) BETWEEN 1 AND 120
);

-- Versions: numbered from 1; at most one PUBLISHED and one DRAFT per
-- guide; publish metadata exactly when it was published.
ALTER TABLE "size_guide_versions" ADD CONSTRAINT "size_guide_versions_number" CHECK ("version" >= 1);
CREATE UNIQUE INDEX "size_guide_versions_one_published" ON "size_guide_versions"("guideId") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "size_guide_versions_one_draft" ON "size_guide_versions"("guideId") WHERE "status" = 'DRAFT';
ALTER TABLE "size_guide_versions" ADD CONSTRAINT "size_guide_versions_lifecycle" CHECK (
  ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "publishedById" IS NULL AND "retiredAt" IS NULL)
  OR ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "publishedById" IS NOT NULL AND "retiredAt" IS NULL)
  OR ("status" = 'RETIRED' AND "publishedAt" IS NOT NULL AND "publishedById" IS NOT NULL AND "retiredAt" IS NOT NULL)
);
ALTER TABLE "size_guide_versions" ADD CONSTRAINT "size_guide_versions_notes_length" CHECK (
  ("notesAr" IS NULL OR char_length("notesAr") <= 1000) AND ("notesEn" IS NULL OR char_length("notesEn") <= 1000)
);

ALTER TABLE "size_guide_measurements" ADD CONSTRAINT "size_guide_measurements_sort" CHECK ("sortOrder" >= 0);
ALTER TABLE "size_guide_rows" ADD CONSTRAINT "size_guide_rows_sort" CHECK ("sortOrder" >= 0);
ALTER TABLE "size_guide_cells" ADD CONSTRAINT "size_guide_cells_values" CHECK (
  "minTenths" > 0 AND ("maxTenths" IS NULL OR "maxTenths" >= "minTenths")
);

-- One default guide per category/audience.
CREATE UNIQUE INDEX "size_guide_applicability_one_default" ON "size_guide_applicability"("categoryCode", "audience") WHERE "isDefault";

-- Requests: one PENDING per offer; a decision carries who/when.
CREATE UNIQUE INDEX "size_guide_requests_one_pending" ON "size_guide_requests"("vendorOfferId") WHERE "status" = 'PENDING';
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_message" CHECK (char_length(btrim("message")) BETWEEN 1 AND 1000);
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_decision" CHECK (
  ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedById" IS NULL)
  OR ("status" <> 'PENDING' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL)
);
ALTER TABLE "size_guide_requests" ADD CONSTRAINT "size_guide_requests_note_length" CHECK ("decisionNote" IS NULL OR char_length("decisionNote") <= 1000);

-- A published (or retired) version is immutable: its own content fields
-- can't change and its columns/rows/cells can't be added, changed or
-- removed. Only DRAFT -> PUBLISHED -> RETIRED moves are allowed.
CREATE FUNCTION size_guide_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."guideId" <> OLD."guideId" OR NEW."version" <> OLD."version"
       OR NEW."basis" <> OLD."basis"
       OR NEW."notesAr" IS DISTINCT FROM OLD."notesAr"
       OR NEW."notesEn" IS DISTINCT FROM OLD."notesEn"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
       OR NEW."publishedById" IS DISTINCT FROM OLD."publishedById"
       OR NOT (NEW."status" = OLD."status" OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'SIZE_GUIDE_VERSION_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER size_guide_version_guard BEFORE UPDATE ON "size_guide_versions"
  FOR EACH ROW EXECUTE FUNCTION size_guide_version_guard();
CREATE FUNCTION size_guide_version_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'SIZE_GUIDE_VERSION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER size_guide_version_no_delete BEFORE DELETE ON "size_guide_versions"
  FOR EACH ROW EXECUTE FUNCTION size_guide_version_no_delete();

CREATE FUNCTION size_guide_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id text;
  v_status "SizeGuideVersionStatus";
BEGIN
  IF TG_TABLE_NAME = 'size_guide_cells' THEN
    SELECT r."versionId" INTO v_id FROM "size_guide_rows" r
      WHERE r."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."rowId" ELSE NEW."rowId" END);
  ELSE
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."versionId" ELSE NEW."versionId" END;
  END IF;
  SELECT "status" INTO v_status FROM "size_guide_versions" WHERE "id" = v_id;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'SIZE_GUIDE_VERSION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER size_guide_measurements_guard BEFORE INSERT OR UPDATE OR DELETE ON "size_guide_measurements"
  FOR EACH ROW EXECUTE FUNCTION size_guide_content_guard();
CREATE TRIGGER size_guide_rows_guard BEFORE INSERT OR UPDATE OR DELETE ON "size_guide_rows"
  FOR EACH ROW EXECUTE FUNCTION size_guide_content_guard();
CREATE TRIGGER size_guide_cells_guard BEFORE INSERT OR UPDATE OR DELETE ON "size_guide_cells"
  FOR EACH ROW EXECUTE FUNCTION size_guide_content_guard();
