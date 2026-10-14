-- Sprint 23 (PDR-032): reviews from verified purchasers, separate
-- PRODUCT/STORE targets, immutable by the customer; reports that a
-- PLATFORM_ADMIN decision may hide.

-- CreateEnum
CREATE TYPE "ReviewTargetType" AS ENUM ('PRODUCT', 'STORE');

-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('VISIBLE', 'REPORTED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ReviewReportStatus" AS ENUM ('PENDING', 'DISMISSED', 'UPHELD');

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceBranchOrderItemId" TEXT NOT NULL,
    "targetType" "ReviewTargetType" NOT NULL,
    "canonicalProductId" TEXT,
    "vendorId" TEXT,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'VISIBLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_reports" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReviewReportStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_canonicalProductId_moderationStatus_idx" ON "reviews"("canonicalProductId", "moderationStatus");

-- CreateIndex
CREATE INDEX "reviews_vendorId_moderationStatus_idx" ON "reviews"("vendorId", "moderationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_sourceBranchOrderItemId_targetType_key" ON "reviews"("sourceBranchOrderItemId", "targetType");

-- CreateIndex
CREATE INDEX "review_reports_status_idx" ON "review_reports"("status");

-- CreateIndex
CREATE UNIQUE INDEX "review_reports_reviewId_reporterId_key" ON "review_reports"("reviewId", "reporterId");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_sourceBranchOrderItemId_fkey" FOREIGN KEY ("sourceBranchOrderItemId") REFERENCES "branch_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one target: a PRODUCT review carries canonicalProductId
-- only, a STORE review carries vendorId only - never both, never
-- neither. Not representable in Prisma's schema DSL (a cross-column
-- XOR) - hand-written, same pattern as this schema's other mutual-
-- exclusivity checks (e.g. vendor_offers_template_pair_check).
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_exactly_one_target" CHECK (
  ("targetType" = 'PRODUCT' AND "canonicalProductId" IS NOT NULL AND "vendorId" IS NULL)
  OR
  ("targetType" = 'STORE' AND "vendorId" IS NOT NULL AND "canonicalProductId" IS NULL)
);

-- 1-5 inclusive - structural backstop for CreateReviewDto's own
-- @Min(1)/@Max(5).
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- Non-empty after trimming, up to 1000 chars - mirrors TrimmedText(1,
-- 1000)'s own bounds structurally.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_body_length" CHECK (char_length(btrim("body")) BETWEEN 1 AND 1000);

-- Same bounds on a report's reason.
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reason_length" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 1000);
