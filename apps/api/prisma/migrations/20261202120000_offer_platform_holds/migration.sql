-- VIA phase 2C - platform offer moderation (Platform Hold). Additive only:
-- one new table and one enum; no existing row or column changes, NO
-- backfill. VendorOffer.status stays the owner's own; a hold is a separate,
-- platform-owned record. While a hold is open (releasedAt IS NULL) the
-- offer is out of every public surface and cannot be bought.
--
--  * at most ONE open hold per offer (partial unique index) - two
--    administrators acting at once cannot both open one;
--  * the reason is required (3-1000 characters after trimming);
--  * a correction (owner-submitted content revision) exists only on a
--    REQUEST_CHANGES hold, and its revision/time/actor come together;
--  * a release (RESTORE) records who/when/why together;
--  * a returned correction records who/when/why together.

-- CreateEnum
CREATE TYPE "OfferPlatformHoldAction" AS ENUM ('HIDE', 'REQUEST_CHANGES');

-- CreateTable
CREATE TABLE "offer_platform_holds" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "action" "OfferPlatformHoldAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "placedById" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correctionRevision" INTEGER,
    "correctionNote" TEXT,
    "correctionSubmittedAt" TIMESTAMP(3),
    "correctionSubmittedById" TEXT,
    "correctionReturnedAt" TIMESTAMP(3),
    "correctionReturnNote" TEXT,
    "correctionReturnedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseNote" TEXT,
    "releasedAtRevision" INTEGER,

    CONSTRAINT "offer_platform_holds_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_reason_length"
  CHECK (char_length(btrim("reason")) BETWEEN 3 AND 1000);
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_correction_shape"
  CHECK (
    (("correctionRevision" IS NULL) = ("correctionSubmittedAt" IS NULL))
    AND (("correctionRevision" IS NULL) = ("correctionSubmittedById" IS NULL))
    AND ("correctionRevision" IS NULL OR "action" = 'REQUEST_CHANGES')
    AND ("correctionNote" IS NULL OR "correctionRevision" IS NOT NULL)
    AND ("correctionNote" IS NULL OR char_length("correctionNote") <= 1000)
  );
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_return_shape"
  CHECK (
    (("correctionReturnedAt" IS NULL) = ("correctionReturnNote" IS NULL))
    AND (("correctionReturnedAt" IS NULL) = ("correctionReturnedById" IS NULL))
    AND ("correctionReturnedAt" IS NULL OR "action" = 'REQUEST_CHANGES')
    AND ("correctionReturnNote" IS NULL OR char_length(btrim("correctionReturnNote")) BETWEEN 3 AND 1000)
  );
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_release_shape"
  CHECK (
    (("releasedAt" IS NULL) = ("releasedById" IS NULL))
    AND (("releasedAt" IS NULL) = ("releaseNote" IS NULL))
    AND ("releaseNote" IS NULL OR char_length(btrim("releaseNote")) BETWEEN 3 AND 1000)
    AND ("releasedAtRevision" IS NULL OR "releasedAt" IS NOT NULL)
  );

-- CreateIndex
CREATE INDEX "offer_platform_holds_vendorOfferId_idx" ON "offer_platform_holds"("vendorOfferId");
CREATE INDEX "offer_platform_holds_releasedAt_placedAt_idx" ON "offer_platform_holds"("releasedAt", "placedAt");
CREATE INDEX "offer_platform_holds_vendorId_idx" ON "offer_platform_holds"("vendorId");
-- At most one OPEN hold per offer.
CREATE UNIQUE INDEX "offer_platform_holds_one_open_per_offer" ON "offer_platform_holds"("vendorOfferId") WHERE "releasedAt" IS NULL;

-- AddForeignKey (composite: the hold's store is the offer's store)
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_placedById_fkey" FOREIGN KEY ("placedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_correctionSubmittedById_fkey" FOREIGN KEY ("correctionSubmittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_correctionReturnedById_fkey" FOREIGN KEY ("correctionReturnedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_platform_holds" ADD CONSTRAINT "offer_platform_holds_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
