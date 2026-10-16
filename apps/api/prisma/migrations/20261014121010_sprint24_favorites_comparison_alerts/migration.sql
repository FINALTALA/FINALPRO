-- Sprint 24: favorites (product/offer), saved comparison sets, and
-- the three favorite-driven alert types (price-drop, back-in-stock,
-- new-offer).

-- CreateEnum
CREATE TYPE "FavoriteTargetType" AS ENUM ('PRODUCT', 'OFFER');

-- CreateEnum
CREATE TYPE "FavoriteAlertType" AS ENUM ('PRICE_DROP', 'BACK_IN_STOCK', 'NEW_OFFER');

-- AlterEnum: each ADD VALUE in its own statement - this project's own
-- established convention (see the Sprint 4/21b migrations), since a
-- newly-added enum value isn't usable until its own ADD VALUE commits.
ALTER TYPE "NotificationTargetType" ADD VALUE 'CANONICAL_PRODUCT';
ALTER TYPE "NotificationType" ADD VALUE 'FAVORITE_PRICE_DROP';
ALTER TYPE "NotificationType" ADD VALUE 'FAVORITE_BACK_IN_STOCK';
ALTER TYPE "NotificationType" ADD VALUE 'FAVORITE_NEW_OFFER';

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" "FavoriteTargetType" NOT NULL,
    "canonicalProductId" TEXT,
    "offerVariantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_sets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shareSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_set_items" (
    "id" TEXT NOT NULL,
    "comparisonSetId" TEXT NOT NULL,
    "canonicalProductId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_set_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertType" "FavoriteAlertType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_canonicalProductId_key" ON "favorites"("userId", "canonicalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_offerVariantId_key" ON "favorites"("userId", "offerVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_sets_shareSlug_key" ON "comparison_sets"("shareSlug");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_set_items_comparisonSetId_canonicalProductId_key" ON "comparison_set_items"("comparisonSetId", "canonicalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_alertType_key" ON "notification_preferences"("userId", "alertType");

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_offerVariantId_fkey" FOREIGN KEY ("offerVariantId") REFERENCES "offer_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_sets" ADD CONSTRAINT "comparison_sets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_set_items" ADD CONSTRAINT "comparison_set_items_comparisonSetId_fkey" FOREIGN KEY ("comparisonSetId") REFERENCES "comparison_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_set_items" ADD CONSTRAINT "comparison_set_items_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one target: a PRODUCT favorite carries canonicalProductId
-- only, an OFFER favorite carries offerVariantId only - never both,
-- never neither. Same hand-written XOR shape as
-- reviews_exactly_one_target (Sprint 23) - not representable in
-- Prisma's schema DSL.
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_exactly_one_target" CHECK (
  ("targetType" = 'PRODUCT' AND "canonicalProductId" IS NOT NULL AND "offerVariantId" IS NULL)
  OR
  ("targetType" = 'OFFER' AND "offerVariantId" IS NOT NULL AND "canonicalProductId" IS NULL)
);
