-- PD-5.4: «نسّقي معه» - a store owner's own offer-to-offer pairings.
-- One new table; no existing table or row changes. Unrelated pre-existing
-- schema drift removed.

-- CreateTable
CREATE TABLE "offer_pairings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "pairedOfferId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_pairings_vendorId_pairedOfferId_idx" ON "offer_pairings"("vendorId", "pairedOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_pairings_offerId_pairedOfferId_key" ON "offer_pairings"("offerId", "pairedOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_pairings_offerId_sortOrder_key" ON "offer_pairings"("offerId", "sortOrder");

-- AddForeignKey: both ends carry vendorId, so a pairing can never span two stores.
ALTER TABLE "offer_pairings" ADD CONSTRAINT "offer_pairings_vendorId_offerId_fkey" FOREIGN KEY ("vendorId", "offerId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_pairings" ADD CONSTRAINT "offer_pairings_vendorId_pairedOfferId_fkey" FOREIGN KEY ("vendorId", "pairedOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PD-5.4 hand-written rules.
ALTER TABLE "offer_pairings"
  ADD CONSTRAINT "offer_pairings_not_self" CHECK ("offerId" <> "pairedOfferId"),
  ADD CONSTRAINT "offer_pairings_sort_order" CHECK ("sortOrder" BETWEEN 0 AND 5);

-- At most 6 pairings per offer, serialised per offer so two concurrent
-- writers can't both pass the count.
CREATE FUNCTION offer_pairings_limit() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('finalpro:offer_pairings:' || NEW."offerId"));
  IF (SELECT count(*) FROM "offer_pairings"
       WHERE "offerId" = NEW."offerId" AND "id" <> NEW."id") >= 6 THEN
    RAISE EXCEPTION 'OFFER_PAIRING_LIMIT: an offer can be styled with at most 6 offers'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_pairings_limit
  BEFORE INSERT OR UPDATE OF "offerId" ON "offer_pairings"
  FOR EACH ROW EXECUTE FUNCTION offer_pairings_limit();
