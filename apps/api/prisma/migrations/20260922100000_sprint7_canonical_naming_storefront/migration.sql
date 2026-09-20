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
-- [a-z0-9-], plus a 6-hex-character suffix from the row's own id,
-- which alone already guarantees uniqueness), then set NOT NULL.

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
UPDATE "vendors"
SET "displayName" = COALESCE("displayName", "legalName"),
    "slug" = COALESCE(
      "slug",
      NULLIF(regexp_replace(lower(regexp_replace("legalName", '[^a-zA-Z0-9]+', '-', 'g')), '(^-+|-+$)', '', 'g'), '')
        || '-' || substr(replace(id, '-', ''), 1, 6)
    )
WHERE "slug" IS NULL;

-- A legalName that collapses to nothing under the regexes above (e.g.
-- entirely non-ASCII) would otherwise leave a slug starting with
-- "-<suffix>" (a leading dash) from the concatenation above having
-- nothing before it - harmless as a URL segment but tidied up here for
-- a cleaner-looking backfill; NULLIF above already handles the
-- "collapses to empty string" case by using COALESCE's second
-- expression to fall straight to the "-"||suffix form. Nothing further
-- to do - every row now has a non-null, syntactically valid slug.

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
