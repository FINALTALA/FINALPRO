-- Phase A++ (product-entry wizard), items 5 and 6. Purely additive: two
-- nullable columns on vendor_offers (every existing row is NULL/NULL, which
-- satisfies both CHECKs) and one new, empty table.
--
-- Item 5 - the model in the photos («العارضة طولها 170 سم وترتدي M»), per
-- product. "modelSize" is deliberately plain TEXT, NOT a foreign key to
-- taxonomy_sizes: today it holds one of the product's own size codes (the
-- server checks it is one of THIS product's sizes on every write); a later
-- phase may allow a store's custom size label there without any migration
-- that has to undo a constraint.
ALTER TABLE "vendor_offers" ADD COLUMN "modelHeightCm" INTEGER;
ALTER TABLE "vendor_offers" ADD COLUMN "modelSize" TEXT;
ALTER TABLE "vendor_offers"
  ADD CONSTRAINT "vendor_offers_model_height_range" CHECK ("modelHeightCm" IS NULL OR "modelHeightCm" BETWEEN 100 AND 220),
  ADD CONSTRAINT "vendor_offers_model_size_text" CHECK ("modelSize" IS NULL OR char_length(btrim("modelSize")) BETWEEN 1 AND 40),
  ADD CONSTRAINT "vendor_offers_model_both_or_neither" CHECK (("modelHeightCm" IS NULL) = ("modelSize" IS NULL));

-- Item 6 - images shared by every colour of a product (a detail, the
-- fabric, a styled look), shown after the chosen colour's own images. Each
-- product has its OWN rows: the same uploaded file may be used by several
-- products or drafts, but removing it from one never touches another, and
-- the draft clean-up deletes a file only when nothing uses it any more
-- (it counts this table). They never count as a colour's main image.
-- At most 6 per product (sortOrder 0-5, unique per product).
CREATE TABLE "vendor_offer_shared_media" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_offer_shared_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_offer_shared_media_vendorOfferId_sortOrder_key" ON "vendor_offer_shared_media"("vendorOfferId", "sortOrder");
CREATE UNIQUE INDEX "vendor_offer_shared_media_vendorOfferId_url_key" ON "vendor_offer_shared_media"("vendorOfferId", "url");
CREATE INDEX "vendor_offer_shared_media_url_idx" ON "vendor_offer_shared_media"("url");

ALTER TABLE "vendor_offer_shared_media" ADD CONSTRAINT "vendor_offer_shared_media_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_offer_shared_media"
  ADD CONSTRAINT "vendor_offer_shared_media_sort_order" CHECK ("sortOrder" BETWEEN 0 AND 5);
