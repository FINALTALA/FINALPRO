-- Product colours (expand). A product's colour is now its OWN row: a free
-- Arabic name (unique inside the product after normalisation), an optional
-- English name, a family from taxonomy_colors (for filters and discovery -
-- families may repeat inside a product: «بيج رملي» and «بيج غامق»), an
-- optional HEX and fabric swatch, and the seller's order (the first is the
-- default). A sellable version is (product colour id x size) - never the
-- name, never the family code.
--
-- Additive and deterministic:
--  * every existing combination version keeps its id; for each product,
--    every distinct family it uses becomes ONE product colour named after
--    that family (exactly what shoppers see today), ordered by first use;
--  * offer_variants."colorCode" stays, kept equal to the colour's family by
--    a trigger, so every filter / discovery / comparison / review path that
--    reads it works unchanged; "colour" (the older text) follows the name;
--  * an older build inserting a combination with "colorCode" only is still
--    served (compatibility trigger): the product's single colour of that
--    family is used, or one is created; two of that family -> COLOR_AMBIGUOUS
--    (never a guess). This is what makes rolling the build back safe;
--  * order lines get name / swatch snapshots; old lines take the colour
--    label they already stored (no guessing), hex and swatch stay NULL.
-- Checks at the end abort the whole migration if any version, SKU, stock,
-- hold, cart, order line, favourite, image or snapshot changed.

-- ---------------------------------------------------------------- snapshot
CREATE TEMP TABLE "_oc_before" ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM "offer_variants") AS variants,
  (SELECT md5(coalesce(string_agg("id" || ':' || "sellerSku" || ':' || coalesce("colorCode", '') || ':' || coalesce("sizeCode", ''), ',' ORDER BY "id"), '')) FROM "offer_variants") AS variants_hash,
  (SELECT coalesce(sum("quantity"), 0) FROM "branch_stock") AS stock_sum,
  (SELECT count(*) FROM "branch_stock") AS stock_rows,
  (SELECT count(*) FROM "stock_movements") AS movements,
  (SELECT count(*) FROM "checkout_reservation_items") AS holds,
  (SELECT count(*) FROM "cart_items") AS carts,
  (SELECT count(*) FROM "branch_order_items") AS order_lines,
  (SELECT md5(coalesce(string_agg("id" || ':' || "offerVariantId" || ':' || coalesce("colorCodeSnapshot", '') || ':' || coalesce("colorLabelSnapshot", ''), ',' ORDER BY "id"), '')) FROM "branch_order_items") AS order_hash,
  (SELECT count(*) FROM "favorites") AS favorites,
  (SELECT count(*) FROM "offer_variant_media") AS media,
  (SELECT count(*) FROM "price_history") AS prices,
  (SELECT count(*) FROM "discount_activation_notices") AS notices;

-- ---------------------------------------------------- the name, normalised
-- Trim and collapse spaces; أ/إ/آ -> ا, ة -> ه, ى -> ي; remove tashkeel
-- (U+064B-U+065F, U+0670), tatweel (U+0640) and invisible direction marks;
-- Latin letters case-insensitive. The API (offers/color-name.ts) applies the
-- same rule; a test proves the two agree.
CREATE FUNCTION "normalize_color_name"(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT lower(btrim(regexp_replace(
    translate(
      regexp_replace(
        t,
        '[' || chr(1611) || '-' || chr(1631) || chr(1648) || chr(1600)
            || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)
            || chr(8294) || '-' || chr(8297) || chr(65279) || ']',
        '', 'g'),
      chr(1571) || chr(1573) || chr(1570) || chr(1609) || chr(1577),
      chr(1575) || chr(1575) || chr(1575) || chr(1610) || chr(1607)),
    '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || ']+', ' ', 'g')))
$fn$;

-- ------------------------------------------------------------ offer_colors
CREATE TABLE "offer_colors" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOfferId" TEXT NOT NULL,
    "familyCode" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "nameKey" TEXT GENERATED ALWAYS AS ("normalize_color_name"("nameAr")) STORED,
    "hex" TEXT,
    "swatchUrl" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "offer_colors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offer_colors_name_ar" CHECK (char_length(btrim("nameAr")) BETWEEN 1 AND 40 AND "nameKey" <> ''),
    CONSTRAINT "offer_colors_name_en" CHECK ("nameEn" IS NULL OR char_length(btrim("nameEn")) BETWEEN 1 AND 40),
    CONSTRAINT "offer_colors_hex" CHECK ("hex" IS NULL OR "hex" ~ '^#[0-9a-f]{6}$'),
    -- at most 30 colours per product (0..29, unique per product)
    CONSTRAINT "offer_colors_sort_order" CHECK ("sortOrder" BETWEEN 0 AND 29)
);

-- the target of the versions' composite FK (a version can only use a colour of ITS product)
CREATE UNIQUE INDEX "offer_colors_vendorOfferId_id_key" ON "offer_colors"("vendorOfferId", "id");
-- one name per product, after normalisation (the server maps a clash to COLOR_NAME_TAKEN)
CREATE UNIQUE INDEX "offer_colors_vendorOfferId_nameKey_key" ON "offer_colors"("vendorOfferId", "nameKey");
CREATE INDEX "offer_colors_familyCode_idx" ON "offer_colors"("familyCode");
-- the seller's order; deferrable so a reorder is one transaction
ALTER TABLE "offer_colors" ADD CONSTRAINT "offer_colors_vendorOfferId_sortOrder_key"
  UNIQUE ("vendorOfferId", "sortOrder") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "offer_colors" ADD CONSTRAINT "offer_colors_vendorId_vendorOfferId_fkey"
  FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_colors" ADD CONSTRAINT "offer_colors_familyCode_fkey"
  FOREIGN KEY ("familyCode") REFERENCES "taxonomy_colors"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------- offer_variants colour
ALTER TABLE "offer_variants" ADD COLUMN "offerColorId" TEXT;
CREATE INDEX "offer_variants_offerColorId_idx" ON "offer_variants"("offerColorId");
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_vendorOfferId_offerColorId_fkey"
  FOREIGN KEY ("vendorOfferId", "offerColorId") REFERENCES "offer_colors"("vendorOfferId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------- order snapshots
ALTER TABLE "branch_order_items"
  ADD COLUMN "offerColorIdSnapshot" TEXT,
  ADD COLUMN "colorNameArSnapshot" TEXT,
  ADD COLUMN "colorNameEnSnapshot" TEXT,
  ADD COLUMN "colorHexSnapshot" TEXT,
  ADD COLUMN "colorSwatchUrlSnapshot" TEXT;

-- --------------------------------------------------------------- backfill
-- One product colour per (product, family) used by its combination
-- versions, named after the family, ordered by first use (then the
-- family's own order, then its code - a total, deterministic order).
INSERT INTO "offer_colors" ("id", "vendorId", "vendorOfferId", "familyCode", "nameAr", "nameEn", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."vendorId", u."vendorOfferId", u."colorCode", tc."nameAr", tc."nameEn",
       (row_number() OVER (PARTITION BY u."vendorOfferId" ORDER BY u.first_used, tc."sortOrder", u."colorCode") - 1)::int,
       u.first_used, u.first_used
FROM (
  SELECT v."vendorId", v."vendorOfferId", v."colorCode", min(v."createdAt") AS first_used
  FROM "offer_variants" v
  WHERE v."isCombination" AND v."colorCode" IS NOT NULL
  GROUP BY v."vendorId", v."vendorOfferId", v."colorCode"
) u
JOIN "taxonomy_colors" tc ON tc."code" = u."colorCode";

UPDATE "offer_variants" v
SET "offerColorId" = oc."id"
FROM "offer_colors" oc
WHERE v."isCombination" AND v."colorCode" IS NOT NULL
  AND oc."vendorOfferId" = v."vendorOfferId" AND oc."familyCode" = v."colorCode";

-- Old order lines: the name they already stored (the family's Arabic name
-- at purchase); the colour that now stands for that family in that product.
UPDATE "branch_order_items" i
SET "colorNameArSnapshot" = i."colorLabelSnapshot",
    "offerColorIdSnapshot" = v."offerColorId"
FROM "offer_variants" v
WHERE v."id" = i."offerVariantId" AND i."colorCodeSnapshot" IS NOT NULL;

-- ---------------------------------------------- identity of a combination
-- (product colour x size) replaces (family x size): two shades of one
-- family may now share a size; a (colour, size) still exists once.
DROP INDEX "offer_variants_combination_key";
CREATE UNIQUE INDEX "offer_variants_color_size_key"
    ON "offer_variants"("vendorOfferId", "offerColorId", "sizeCode") NULLS NOT DISTINCT
    WHERE "isCombination";
-- a coloured combination always has its product colour
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_combination_has_color"
  CHECK (NOT "isCombination" OR "colorCode" IS NULL OR "offerColorId" IS NOT NULL) NOT VALID;
ALTER TABLE "offer_variants" VALIDATE CONSTRAINT "offer_variants_combination_has_color";

-- --------------------------------------------------------------- triggers
-- A combination version: its family code and older colour text always come
-- from its product colour. Sent with "colorCode" only (an older build, or
-- the unchanged combinations endpoint): the product's single colour of that
-- family, or a new one named after the family; two of that family ->
-- COLOR_AMBIGUOUS. Serialised per product (advisory lock).
CREATE FUNCTION "offer_variant_color"() RETURNS trigger AS $$
DECLARE
  c RECORD;
  n INT;
BEGIN
  IF NOT NEW."isCombination" THEN
    RETURN NEW;
  END IF;
  IF NEW."offerColorId" IS NULL AND NEW."colorCode" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('finalpro:offer_colors:' || NEW."vendorOfferId"));
    SELECT count(*) INTO n FROM "offer_colors" WHERE "vendorOfferId" = NEW."vendorOfferId" AND "familyCode" = NEW."colorCode";
    IF n > 1 THEN
      RAISE EXCEPTION 'COLOR_AMBIGUOUS: this product has more than one colour of family %; name the product colour', NEW."colorCode"
        USING ERRCODE = 'check_violation';
    ELSIF n = 1 THEN
      SELECT "id" INTO NEW."offerColorId" FROM "offer_colors" WHERE "vendorOfferId" = NEW."vendorOfferId" AND "familyCode" = NEW."colorCode";
    ELSE
      INSERT INTO "offer_colors" ("id", "vendorId", "vendorOfferId", "familyCode", "nameAr", "nameEn", "sortOrder", "updatedAt")
      SELECT gen_random_uuid()::text, NEW."vendorId", NEW."vendorOfferId", tc."code", tc."nameAr", tc."nameEn",
             coalesce((SELECT max("sortOrder") + 1 FROM "offer_colors" WHERE "vendorOfferId" = NEW."vendorOfferId"), 0),
             CURRENT_TIMESTAMP
      FROM "taxonomy_colors" tc WHERE tc."code" = NEW."colorCode"
      RETURNING "id" INTO NEW."offerColorId";
    END IF;
  END IF;
  IF NEW."offerColorId" IS NOT NULL THEN
    SELECT "familyCode", "nameAr" INTO c FROM "offer_colors" WHERE "id" = NEW."offerColorId";
    NEW."colorCode" := c."familyCode";
    NEW."colour" := c."nameAr";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_variants_color"
  BEFORE INSERT OR UPDATE OF "offerColorId", "colorCode", "isCombination" ON "offer_variants"
  FOR EACH ROW EXECUTE FUNCTION "offer_variant_color"();

-- A colour's family or name changes: its versions follow.
CREATE FUNCTION "offer_color_to_variants"() RETURNS trigger AS $$
BEGIN
  UPDATE "offer_variants" SET "colorCode" = NEW."familyCode", "colour" = NEW."nameAr"
  WHERE "offerColorId" = NEW."id" AND ("colorCode" IS DISTINCT FROM NEW."familyCode" OR "colour" IS DISTINCT FROM NEW."nameAr");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_colors_to_variants"
  AFTER UPDATE OF "familyCode", "nameAr" ON "offer_colors"
  FOR EACH ROW EXECUTE FUNCTION "offer_color_to_variants"();

-- A product colour is never deleted while anything refers to it (the
-- version FK is RESTRICT); deleting one with no versions is refused too in
-- this package (no deletion feature yet).
CREATE FUNCTION "offer_colors_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'COLOR_NOT_DELETABLE: a product colour is never deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_colors_no_delete"
  BEFORE DELETE ON "offer_colors"
  FOR EACH ROW EXECUTE FUNCTION "offer_colors_no_delete"();

-- ------------------------------------------------------------------ checks
DO $$
DECLARE
  b RECORD;
  a RECORD;
  bad INT;
BEGIN
  SELECT * INTO b FROM "_oc_before";
  SELECT
    (SELECT count(*) FROM "offer_variants") AS variants,
    (SELECT md5(coalesce(string_agg("id" || ':' || "sellerSku" || ':' || coalesce("colorCode", '') || ':' || coalesce("sizeCode", ''), ',' ORDER BY "id"), '')) FROM "offer_variants") AS variants_hash,
    (SELECT coalesce(sum("quantity"), 0) FROM "branch_stock") AS stock_sum,
    (SELECT count(*) FROM "branch_stock") AS stock_rows,
    (SELECT count(*) FROM "stock_movements") AS movements,
    (SELECT count(*) FROM "checkout_reservation_items") AS holds,
    (SELECT count(*) FROM "cart_items") AS carts,
    (SELECT count(*) FROM "branch_order_items") AS order_lines,
    (SELECT md5(coalesce(string_agg("id" || ':' || "offerVariantId" || ':' || coalesce("colorCodeSnapshot", '') || ':' || coalesce("colorLabelSnapshot", ''), ',' ORDER BY "id"), '')) FROM "branch_order_items") AS order_hash,
    (SELECT count(*) FROM "favorites") AS favorites,
    (SELECT count(*) FROM "offer_variant_media") AS media,
    (SELECT count(*) FROM "price_history") AS prices,
    (SELECT count(*) FROM "discount_activation_notices") AS notices
  INTO a;
  IF a IS DISTINCT FROM b THEN
    RAISE EXCEPTION 'OFFER_COLORS_MIGRATION_CHECK: data changed (before %, after %)', b, a;
  END IF;
  SELECT count(*) INTO bad FROM "offer_variants" WHERE "isCombination" AND "colorCode" IS NOT NULL AND "offerColorId" IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'OFFER_COLORS_MIGRATION_CHECK: % combination version(s) without a product colour', bad;
  END IF;
  SELECT count(*) INTO bad FROM "offer_variants" v JOIN "offer_colors" oc ON oc."id" = v."offerColorId"
   WHERE oc."familyCode" IS DISTINCT FROM v."colorCode" OR oc."vendorOfferId" <> v."vendorOfferId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'OFFER_COLORS_MIGRATION_CHECK: % version(s) whose colour family or product disagrees', bad;
  END IF;
  SELECT count(*) INTO bad FROM "branch_order_items"
   WHERE "colorCodeSnapshot" IS NOT NULL AND "colorNameArSnapshot" IS DISTINCT FROM "colorLabelSnapshot";
  IF bad > 0 THEN
    RAISE EXCEPTION 'OFFER_COLORS_MIGRATION_CHECK: % old order line(s) without their colour name', bad;
  END IF;
END $$;
