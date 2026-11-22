-- CreateEnum
CREATE TYPE "ReviewFit" AS ENUM ('SMALL', 'TRUE_TO_SIZE', 'LARGE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ReviewTag" AS ENUM ('GOOD_QUALITY', 'EXCELLENT_MATERIAL', 'MATCHES_PHOTOS', 'COMFORTABLE', 'GOOD_VALUE', 'BELOW_EXPECTATIONS', 'DIFFERS_FROM_PHOTOS');

-- CreateEnum
CREATE TYPE "ReviewAuthorDisplay" AS ENUM ('ANONYMOUS', 'FIRST_NAME_INITIAL');

-- CreateEnum
CREATE TYPE "ReviewMediaStatus" AS ENUM ('VISIBLE', 'HIDDEN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_INVITATION';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_HIDDEN';

-- AlterTable
ALTER TABLE "branch_order_items" ADD COLUMN     "colorCodeSnapshot" TEXT,
ADD COLUMN     "colorLabelSnapshot" TEXT,
ADD COLUMN     "sizeCodeSnapshot" TEXT,
ADD COLUMN     "sizeLabelSnapshot" TEXT,
ADD COLUMN     "titleArSnapshot" TEXT,
ADD COLUMN     "titleEnSnapshot" TEXT;

-- AlterTable
ALTER TABLE "review_reports" ADD COLUMN     "decisionReason" TEXT,
ADD COLUMN     "mediaId" TEXT;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "authorDisplay" "ReviewAuthorDisplay" NOT NULL DEFAULT 'ANONYMOUS',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "fitFeedback" "ReviewFit",
ADD COLUMN     "helpfulCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "purchasedColorCode" TEXT,
ADD COLUMN     "purchasedColorLabel" TEXT,
ADD COLUMN     "purchasedSizeCode" TEXT,
ADD COLUMN     "purchasedSizeLabel" TEXT,
ADD COLUMN     "purchasedTitle" TEXT,
ADD COLUMN     "tags" "ReviewTag"[] DEFAULT ARRAY[]::"ReviewTag"[];

-- CreateTable
CREATE TABLE "review_media" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "status" "ReviewMediaStatus" NOT NULL DEFAULT 'VISIBLE',
    "hiddenReason" TEXT,
    "hiddenByUserId" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_helpful_votes" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_helpful_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_revisions" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "fitFeedback" "ReviewFit",
    "tags" "ReviewTag"[] DEFAULT ARRAY[]::"ReviewTag"[],
    "authorDisplay" "ReviewAuthorDisplay" NOT NULL,
    "revisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_media_fileName_key" ON "review_media"("fileName");

-- CreateIndex
CREATE INDEX "review_media_reviewId_status_sortOrder_idx" ON "review_media"("reviewId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "review_helpful_votes_customerId_idx" ON "review_helpful_votes"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "review_helpful_votes_reviewId_customerId_key" ON "review_helpful_votes"("reviewId", "customerId");

-- CreateIndex
CREATE INDEX "review_revisions_reviewId_revisedAt_idx" ON "review_revisions"("reviewId", "revisedAt");

-- CreateIndex
CREATE INDEX "reviews_canonicalProductId_createdAt_id_idx" ON "reviews"("canonicalProductId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "reviews_canonicalProductId_helpfulCount_id_idx" ON "reviews"("canonicalProductId", "helpfulCount" DESC, "id");

-- CreateIndex
CREATE INDEX "reviews_customerId_idx" ON "reviews"("customerId");

-- AddForeignKey
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_hiddenByUserId_fkey" FOREIGN KEY ("hiddenByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_helpful_votes" ADD CONSTRAINT "review_helpful_votes_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_helpful_votes" ADD CONSTRAINT "review_helpful_votes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_revisions" ADD CONSTRAINT "review_revisions_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "review_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PD-3 hand-written constraints (Prisma's schema DSL can't express
-- them - same pattern as the Sprint 23 reviews_* checks).

-- Fit verdict and impression tags belong to PRODUCT reviews only.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_only_signals" CHECK (
  "targetType" = 'PRODUCT'
  OR ("fitFeedback" IS NULL AND COALESCE(cardinality("tags"), 0) = 0)
);

-- At most three tags (duplicates are refused by the DTO).
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tags_max_three" CHECK (COALESCE(cardinality("tags"), 0) <= 3);

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_helpful_count_non_negative" CHECK ("helpfulCount" >= 0);

ALTER TABLE "review_revisions" ADD CONSTRAINT "review_revisions_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "review_media" ADD CONSTRAINT "review_media_alt_text_length" CHECK ("altText" IS NULL OR char_length("altText") <= 200);

ALTER TABLE "review_media" ADD CONSTRAINT "review_media_sort_order_non_negative" CHECK ("sortOrder" >= 0);

-- A hidden image always carries who/when/why; a visible one none of it.
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_hidden_consistency" CHECK (
  ("status" = 'VISIBLE' AND "hiddenAt" IS NULL AND "hiddenReason" IS NULL AND "hiddenByUserId" IS NULL)
  OR
  ("status" = 'HIDDEN' AND "hiddenAt" IS NOT NULL AND "hiddenReason" IS NOT NULL AND "hiddenByUserId" IS NOT NULL)
);

ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_decision_reason_length" CHECK ("decisionReason" IS NULL OR char_length(btrim("decisionReason")) BETWEEN 1 AND 500);
