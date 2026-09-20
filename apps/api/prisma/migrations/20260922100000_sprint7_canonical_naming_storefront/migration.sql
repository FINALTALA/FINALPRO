-- Sprint 7 (RB-MATCH-003, RB-STOREF-001). canonical_products'
-- canonicalNameAr/En and canonical_name_change_requests are all
-- nullable/brand-new - nothing to backfill. vendors.storefrontPublished
-- has a safe default (false) matching every existing vendor's actual
-- state (none has ever published a storefront - the feature didn't
-- exist before this sprint). vendors.slug is the one genuinely new
-- required+unique column on a table with existing Sprint 1-6 rows, so
-- it is added nullable first, backfilled with a deterministic,
-- id-derived value (the exact same scheme
-- apps/api/src/common/slug.util.ts's generateVendorSlug() uses for new
-- rows going forward - legalName-derived prefix, stripped to
-- [a-z0-9-], plus the row's own FULL id with dashes stripped, which
-- alone already guarantees uniqueness - see that file's own comment on
-- why a truncated suffix, an earlier review round's finding, is not
-- safe), then set NOT NULL.
--
-- Review-round fix (Blocker 3, RB-MATCH-004/PDR-019): also adds
-- import_identifier_records, a brand-new table with nothing to
-- backfill - see ImportIdentifierRecord's own schema.prisma comment.

-- CreateEnum
CREATE TYPE "NameChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "canonical_products" ADD COLUMN "canonicalNameAr" TEXT,
ADD COLUMN "canonicalNameEn" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN "bio" TEXT,
ADD COLUMN "coverColor" TEXT,
ADD COLUMN "coverImageUrl" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "facebookUrl" TEXT,
ADD COLUMN "instagramUrl" TEXT,
ADD COLUMN "logoUrl" TEXT,
ADD COLUMN "slug" TEXT,
ADD COLUMN "storefrontPublished" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "whatsappUrl" TEXT;

-- Backfill (RB-STOREF-001): existing vendors get displayName copied
-- from legalName (matches what VendorsController.apply() now does for
-- every new vendor going forward) and a deterministic slug - see this
-- file's own header comment for the exact scheme.
--
-- Review-round fix: the previous version of this backfill computed
-- `NULLIF(<slugified legalName>, '') || '-' || <suffix>` directly - for
-- any legalName that collapses to nothing under the regexes below
-- (entirely non-ASCII, e.g. a purely Arabic name, which this
-- Arabic-first platform's own vendors are quite likely to have), the
-- NULLIF produces SQL NULL, and `NULL || '-' || suffix` is itself NULL
-- (Postgres string concatenation propagates NULL, it does not treat it
-- as empty) - not the intended "-"||suffix, and not even a leading-dash
-- slug as an earlier comment here incorrectly claimed, but an actual
-- NULL that would have failed the NOT NULL constraint two statements
-- below for every such vendor. Fixed with a nested COALESCE that falls
-- back to the bare id-derived part alone (no separator) when the
-- legalName-derived part is empty - matching
-- apps/api/src/common/slug.util.ts's generateVendorSlug() exactly,
-- including for non-ASCII input, and producing no leading/stray dash
-- either way.
UPDATE "vendors"
SET "displayName" = COALESCE("displayName", "legalName"),
    "slug" = COALESCE(
      "slug",
      COALESCE(
        NULLIF(regexp_replace(lower(regexp_replace("legalName", '[^a-zA-Z0-9]+', '-', 'g')), '(^-+|-+$)', '', 'g'), '')
          || '-' || replace(id, '-', ''),
        replace(id, '-', '')
      )
    )
WHERE "slug" IS NULL;

ALTER TABLE "vendors" ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "canonical_name_change_requests" (
    "id" TEXT NOT NULL,
    "canonicalProductId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requestedNameAr" TEXT NOT NULL,
    "requestedNameEn" TEXT NOT NULL,
    "reason" TEXT,
    "status" "NameChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_name_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canonical_name_change_requests_canonicalProductId_status_idx" ON "canonical_name_change_requests"("canonicalProductId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_slug_key" ON "vendors"("slug");

-- AddForeignKey
ALTER TABLE "canonical_name_change_requests" ADD CONSTRAINT "canonical_name_change_requests_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_name_change_requests" ADD CONSTRAINT "canonical_name_change_requests_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_name_change_requests" ADD CONSTRAINT "canonical_name_change_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "import_identifier_records" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "identifierType" "OfferIdentifierType" NOT NULL,
    "identifierValue" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "brandName" TEXT,
    "productType" TEXT,
    "mpn" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_identifier_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_identifier_records_vendor_identifier_key" ON "import_identifier_records"("vendorId", "identifierType", "identifierValue");

-- AddForeignKey
ALTER TABLE "import_identifier_records" ADD CONSTRAINT "import_identifier_records_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_identifier_records" ADD CONSTRAINT "import_identifier_records_vendorOfferId_fkey" FOREIGN KEY ("vendorOfferId") REFERENCES "vendor_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
