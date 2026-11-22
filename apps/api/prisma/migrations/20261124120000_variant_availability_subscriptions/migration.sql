-- Customer opt-in availability alerts. These are deliberately separate
-- from Favorites: one subscription is for one exact sellable variant
-- (product colour x size), and is consumed after a successful restock.
ALTER TYPE "NotificationType" ADD VALUE 'VARIANT_BACK_IN_STOCK';

CREATE TABLE "variant_availability_subscriptions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "offerVariantId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "variant_availability_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_availability_subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "variant_availability_subscriptions_offerVariantId_fkey"
    FOREIGN KEY ("offerVariantId") REFERENCES "offer_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "variant_availability_subscriptions_userId_offerVariantId_key"
  ON "variant_availability_subscriptions"("userId", "offerVariantId");
CREATE INDEX "variant_availability_subscriptions_offerVariantId_active_idx"
  ON "variant_availability_subscriptions"("offerVariantId", "active");
