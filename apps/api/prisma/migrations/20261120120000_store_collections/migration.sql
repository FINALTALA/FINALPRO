-- «مجموعات المتجر» (2026-11-18): the store's own manual collections, built
-- on the existing store sections. Additive only - nothing is dropped and no
-- link is deleted:
--  - store_sections."name" stays and IS the Arabic name (existing names
--    become Arabic names as they are); an optional English name, an
--    optional cover image (one of the store's own uploads - checked by the
--    API) and a visible/hidden flag (existing rows: visible) are added;
--  - store_section_offers gets the owner's manual product order, filled for
--    every existing collection from the order the products were added in
--    (createdAt, then id), so nothing moves.
-- Runs after 20261119120000_offer_edit_drafts.

ALTER TABLE "store_sections"
  ADD COLUMN "nameEn" TEXT,
  ADD COLUMN "coverUrl" TEXT,
  ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "store_section_offers" ADD COLUMN "sortOrder" INTEGER;

UPDATE "store_section_offers" o
SET "sortOrder" = r.pos
FROM (
  SELECT id, (row_number() OVER (PARTITION BY "sectionId" ORDER BY "createdAt", id) - 1)::int AS pos
  FROM "store_section_offers"
) r
WHERE r.id = o.id;

ALTER TABLE "store_section_offers" ALTER COLUMN "sortOrder" SET NOT NULL;

CREATE INDEX "store_section_offers_sectionId_sortOrder_idx" ON "store_section_offers"("sectionId", "sortOrder");

-- Guard: every link kept its place (one position per link, 0..n-1 per collection).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "store_section_offers"
    GROUP BY "sectionId"
    HAVING count(*) <> count(DISTINCT "sortOrder") OR max("sortOrder") <> count(*) - 1
  ) THEN
    RAISE EXCEPTION 'store collections migration: product order not filled for every link';
  END IF;
END $$;
