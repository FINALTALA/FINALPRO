-- «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the store owner's own home
-- page, made of ready blocks (hero, banner, chosen collections, chosen
-- products, new arrivals / sale, store categories, text). Additive only -
-- one new table, nothing existing is touched:
--  - one row per store at most (created on the first draft save); a store
--    with no row - every existing store - keeps its page exactly as it is;
--  - "draft" is what the owner edits (autosaved), "published" what shoppers
--    see; publishing copies the draft atomically;
--  - "draftVersion" grows on every draft write (a save from a stale screen
--    is refused), "publishedVersion" is the draft version that was published.
-- The block documents are validated by the API (closed list of block types
-- and fields, the store's own uploads only, no free links or HTML).
-- Runs after 20261126120000_store_barcodes_and_sales.

CREATE TABLE "store_home_layouts" (
    "vendorId" TEXT NOT NULL,
    "draft" JSONB NOT NULL DEFAULT '{"blocks": []}',
    "published" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_home_layouts_pkey" PRIMARY KEY ("vendorId"),
    CONSTRAINT "store_home_layouts_versions_check" CHECK (
      "draftVersion" >= 0
      AND ("publishedVersion" IS NULL OR ("publishedVersion" >= 0 AND "publishedVersion" <= "draftVersion"))
    ),
    CONSTRAINT "store_home_layouts_published_check" CHECK (("published" IS NULL) = ("publishedAt" IS NULL)),
    CONSTRAINT "store_home_layouts_draft_object_check" CHECK (jsonb_typeof("draft") = 'object'),
    CONSTRAINT "store_home_layouts_published_object_check" CHECK ("published" IS NULL OR jsonb_typeof("published") = 'object')
);

ALTER TABLE "store_home_layouts" ADD CONSTRAINT "store_home_layouts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
