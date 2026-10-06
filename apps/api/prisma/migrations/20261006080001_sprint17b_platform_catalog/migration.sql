-- Sprint 17b: platform catalog administration - restriction,
-- product_type/warranty/tags/SEO (BL-CAT-003), merge/split redirect
-- columns, and the MatchReport model (FR-MATCH-005). All additive,
-- every new column nullable or safely defaulted - no backfill needed,
-- every pre-existing row is honestly PHYSICAL/unrestricted/unmerged
-- (nothing before this sprint could represent anything else).

-- AlterTable
ALTER TABLE "canonical_product_variants" ADD COLUMN     "mergedIntoVariantId" TEXT;

-- AlterTable
ALTER TABLE "canonical_products" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "productType" "ProductType" NOT NULL DEFAULT 'PHYSICAL',
ADD COLUMN     "restrictionReason" TEXT,
ADD COLUMN     "seoDescriptionAr" TEXT,
ADD COLUMN     "seoDescriptionEn" TEXT,
ADD COLUMN     "seoTitleAr" TEXT,
ADD COLUMN     "seoTitleEn" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "warrantyPeriod" TEXT,
ADD COLUMN     "warrantyType" TEXT;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restrictionReason" TEXT;

-- AlterTable
ALTER TABLE "match_review_candidates" ADD COLUMN     "source" "MatchCandidateSource" NOT NULL DEFAULT 'NON_EXACT_SCORE';

-- CreateTable
CREATE TABLE "match_reports" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_reports_candidateId_idx" ON "match_reports"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "match_reports_candidateId_reporterUserId_key" ON "match_reports"("candidateId", "reporterUserId");

-- CreateIndex
CREATE INDEX "canonical_product_variants_mergedIntoVariantId_idx" ON "canonical_product_variants"("mergedIntoVariantId");

-- CreateIndex
CREATE INDEX "canonical_products_mergedIntoId_idx" ON "canonical_products"("mergedIntoId");

-- AddForeignKey
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "canonical_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_product_variants" ADD CONSTRAINT "canonical_product_variants_mergedIntoVariantId_fkey" FOREIGN KEY ("mergedIntoVariantId") REFERENCES "canonical_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reports" ADD CONSTRAINT "match_reports_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "match_review_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reports" ADD CONSTRAINT "match_reports_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
