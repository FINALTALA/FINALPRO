-- Sprint 27: fixed product taxonomy (audiences, categories, season,
-- colours, sizes) and colour/size combinations on OfferVariant.
-- Additive only: no existing row is changed, nothing is backfilled or
-- guessed - an offer without audiences stays a legacy, unclassified
-- offer (taxonomyVersion NULL), sold and shown exactly as before.
-- The reference rows below ARE the versioned source of the taxonomy;
-- changing it means a new migration, never store-written data.

-- CreateEnum
CREATE TYPE "ProductAudience" AS ENUM ('WOMEN', 'MEN', 'KIDS');
CREATE TYPE "ProductSeason" AS ENUM ('SUMMER', 'WINTER', 'FALL');
CREATE TYPE "SizeGroup" AS ENUM ('ADULT', 'KIDS_AGE');

-- AlterEnum (opening stock of a new combination; no PDR-021 owner alert)
ALTER TYPE "StockMovementReason" ADD VALUE 'INITIAL_STOCK';

-- AlterTable
ALTER TABLE "offer_variants" ADD COLUMN "colorCode" TEXT,
ADD COLUMN "sizeCode" TEXT,
ADD COLUMN "isCombination" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "vendor_offers" ADD COLUMN "season" "ProductSeason",
ADD COLUMN "taxonomyVersion" INTEGER;

-- Every offer that exists now is legacy (false). The owner-facing creation
-- paths (product form, CSV import) set it to true explicitly, so a product
-- they create cannot be published until it is classified.
ALTER TABLE "vendor_offers" ADD COLUMN "requiresTaxonomy" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "taxonomy_categories" (
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "taxonomy_categories_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "taxonomy_category_audiences" (
    "categoryCode" TEXT NOT NULL,
    "audience" "ProductAudience" NOT NULL,
    CONSTRAINT "taxonomy_category_audiences_pkey" PRIMARY KEY ("categoryCode","audience")
);

CREATE TABLE "taxonomy_colors" (
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "hex" TEXT,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "taxonomy_colors_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "taxonomy_sizes" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "group" "SizeGroup" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "taxonomy_sizes_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "vendor_offer_audiences" (
    "vendorOfferId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "audience" "ProductAudience" NOT NULL,
    CONSTRAINT "vendor_offer_audiences_pkey" PRIMARY KEY ("vendorOfferId","audience")
);

CREATE TABLE "vendor_offer_categories" (
    "vendorOfferId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    CONSTRAINT "vendor_offer_categories_pkey" PRIMARY KEY ("vendorOfferId","categoryCode")
);

-- CreateIndex
CREATE INDEX "taxonomy_category_audiences_audience_idx" ON "taxonomy_category_audiences"("audience");
CREATE INDEX "vendor_offer_audiences_audience_idx" ON "vendor_offer_audiences"("audience");
CREATE INDEX "vendor_offer_categories_categoryCode_idx" ON "vendor_offer_categories"("categoryCode");
CREATE INDEX "offer_variants_colorCode_idx" ON "offer_variants"("colorCode");
CREATE INDEX "offer_variants_sizeCode_idx" ON "offer_variants"("sizeCode");
CREATE INDEX "vendor_offers_season_idx" ON "vendor_offers"("season");

-- One combination per (offer, colour, size) - NULLS NOT DISTINCT, so at
-- most one "no options" combination; legacy variants are never
-- constrained. A combination at quantity 0 keeps its row, so the owner
-- refills it instead of being blocked from re-creating it.
CREATE UNIQUE INDEX "offer_variants_combination_key"
    ON "offer_variants"("vendorOfferId", "colorCode", "sizeCode") NULLS NOT DISTINCT
    WHERE "isCombination";

-- AddForeignKey
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_colorCode_fkey" FOREIGN KEY ("colorCode") REFERENCES "taxonomy_colors"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_sizeCode_fkey" FOREIGN KEY ("sizeCode") REFERENCES "taxonomy_sizes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "taxonomy_category_audiences" ADD CONSTRAINT "taxonomy_category_audiences_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "taxonomy_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_offer_audiences" ADD CONSTRAINT "vendor_offer_audiences_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_offer_categories" ADD CONSTRAINT "vendor_offer_categories_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_offer_categories" ADD CONSTRAINT "vendor_offer_categories_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "taxonomy_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: categories (one code per distinct Arabic name)
INSERT INTO "taxonomy_categories" ("code", "nameAr", "nameEn", "sortOrder") VALUES
  ('DRESSES_WOMEN', 'فساتين', 'Dresses', 1),
  ('TOPS', 'بلايز وتوبات', 'Tops & blouses', 2),
  ('TSHIRTS', 'تيشيرتات', 'T-shirts', 3),
  ('SHIRTS', 'قمصان', 'Shirts', 4),
  ('TROUSERS', 'بناطيل', 'Trousers', 5),
  ('JEANS', 'جينز', 'Jeans', 6),
  ('SKIRTS', 'تنانير', 'Skirts', 7),
  ('SHORTS', 'شورتات', 'Shorts', 8),
  ('JACKETS', 'جكيتات', 'Jackets', 9),
  ('COATS', 'معاطف', 'Coats', 10),
  ('BLAZERS', 'بليزرات', 'Blazers', 11),
  ('CARDIGANS', 'كارديغان', 'Cardigans', 12),
  ('HOODIES', 'هوديز', 'Hoodies', 13),
  ('SWEATSHIRTS', 'سويت شيرت', 'Sweatshirts', 14),
  ('KNITWEAR', 'كنزات وتريكو', 'Sweaters & knitwear', 15),
  ('TWO_PIECE_SETS', 'أطقم من قطعتين', 'Two-piece sets', 16),
  ('JUMPSUITS', 'جمبسوت وأوفرولات', 'Jumpsuits & overalls', 17),
  ('FORMAL_SUITS', 'بدلات رسمية', 'Formal suits', 18),
  ('SPORTSWEAR', 'ملابس رياضية', 'Sportswear', 19),
  ('SWIMWEAR', 'ملابس سباحة', 'Swimwear', 20),
  ('SLEEPWEAR', 'ملابس نوم', 'Sleepwear', 21),
  ('LOUNGEWEAR', 'ملابس منزلية', 'Loungewear', 22),
  ('UNDERWEAR', 'ملابس داخلية', 'Underwear', 23),
  ('LINGERIE', 'لانجري', 'Lingerie', 24),
  ('MATERNITY', 'ملابس حمل', 'Maternity', 25),
  ('MODEST_WEAR', 'ملابس محجبات', 'Modest wear', 26),
  ('ABAYAS', 'عبايات', 'Abayas', 27),
  ('JALABIYAS_KAFTANS', 'جلابيات وقفاطين', 'Jalabiyas & kaftans', 28),
  ('HIJABS_SHAWLS', 'حجابات وشالات', 'Hijabs & shawls', 29),
  ('SHOES', 'أحذية', 'Shoes', 30),
  ('BAGS', 'حقائب', 'Bags', 31),
  ('JEWELLERY', 'مجوهرات', 'Jewellery', 32),
  ('WATCHES', 'ساعات', 'Watches', 33),
  ('EYEWEAR', 'نظارات', 'Eyewear', 34),
  ('BELTS', 'أحزمة', 'Belts', 35),
  ('HATS_CAPS', 'قبعات وطواقي', 'Hats & caps', 36),
  ('ACCESSORIES', 'إكسسوارات', 'Accessories', 37),
  ('SOCKS', 'جوارب', 'Socks', 38),
  ('BLOUSES_MEN', 'بلايز', 'Tops', 39),
  ('FORMAL_TROUSERS', 'بناطيل رسمية', 'Formal trousers', 40),
  ('WALLETS', 'محافظ', 'Wallets', 41),
  ('GIRLS_DRESSES', 'فساتين بنات', 'Girls'' dresses', 42),
  ('LEGGINGS', 'ليغينغز', 'Leggings', 43),
  ('MULTI_PIECE_SETS', 'أطقم متعددة القطع', 'Multi-piece sets', 44),
  ('NEWBORN', 'ملابس مواليد', 'Newborn wear', 45),
  ('DUNGAREES', 'سالوبيت', 'Dungarees', 46),
  ('BABY_BODYSUITS', 'بودي أطفال', 'Baby bodysuits', 47),
  ('OCCASION_WEAR', 'ملابس مناسبات وأعياد', 'Occasion & Eid wear', 48),
  ('HAIR_ACCESSORIES', 'إكسسوارات الشعر', 'Hair accessories', 49);

-- Seed: which audience each category belongs to
INSERT INTO "taxonomy_category_audiences" ("categoryCode", "audience") VALUES
  ('DRESSES_WOMEN', 'WOMEN'),
  ('TOPS', 'WOMEN'),
  ('TSHIRTS', 'WOMEN'),
  ('SHIRTS', 'WOMEN'),
  ('TROUSERS', 'WOMEN'),
  ('JEANS', 'WOMEN'),
  ('SKIRTS', 'WOMEN'),
  ('SHORTS', 'WOMEN'),
  ('JACKETS', 'WOMEN'),
  ('COATS', 'WOMEN'),
  ('BLAZERS', 'WOMEN'),
  ('CARDIGANS', 'WOMEN'),
  ('HOODIES', 'WOMEN'),
  ('SWEATSHIRTS', 'WOMEN'),
  ('KNITWEAR', 'WOMEN'),
  ('TWO_PIECE_SETS', 'WOMEN'),
  ('JUMPSUITS', 'WOMEN'),
  ('FORMAL_SUITS', 'WOMEN'),
  ('SPORTSWEAR', 'WOMEN'),
  ('SWIMWEAR', 'WOMEN'),
  ('SLEEPWEAR', 'WOMEN'),
  ('LOUNGEWEAR', 'WOMEN'),
  ('UNDERWEAR', 'WOMEN'),
  ('LINGERIE', 'WOMEN'),
  ('MATERNITY', 'WOMEN'),
  ('MODEST_WEAR', 'WOMEN'),
  ('ABAYAS', 'WOMEN'),
  ('JALABIYAS_KAFTANS', 'WOMEN'),
  ('HIJABS_SHAWLS', 'WOMEN'),
  ('SHOES', 'WOMEN'),
  ('BAGS', 'WOMEN'),
  ('JEWELLERY', 'WOMEN'),
  ('WATCHES', 'WOMEN'),
  ('EYEWEAR', 'WOMEN'),
  ('BELTS', 'WOMEN'),
  ('HATS_CAPS', 'WOMEN'),
  ('ACCESSORIES', 'WOMEN'),
  ('SOCKS', 'WOMEN'),
  ('SHIRTS', 'MEN'),
  ('TSHIRTS', 'MEN'),
  ('BLOUSES_MEN', 'MEN'),
  ('TROUSERS', 'MEN'),
  ('JEANS', 'MEN'),
  ('FORMAL_TROUSERS', 'MEN'),
  ('SHORTS', 'MEN'),
  ('JACKETS', 'MEN'),
  ('COATS', 'MEN'),
  ('BLAZERS', 'MEN'),
  ('HOODIES', 'MEN'),
  ('SWEATSHIRTS', 'MEN'),
  ('KNITWEAR', 'MEN'),
  ('FORMAL_SUITS', 'MEN'),
  ('TWO_PIECE_SETS', 'MEN'),
  ('SPORTSWEAR', 'MEN'),
  ('SWIMWEAR', 'MEN'),
  ('SLEEPWEAR', 'MEN'),
  ('LOUNGEWEAR', 'MEN'),
  ('UNDERWEAR', 'MEN'),
  ('SHOES', 'MEN'),
  ('BAGS', 'MEN'),
  ('WALLETS', 'MEN'),
  ('JEWELLERY', 'MEN'),
  ('WATCHES', 'MEN'),
  ('EYEWEAR', 'MEN'),
  ('BELTS', 'MEN'),
  ('HATS_CAPS', 'MEN'),
  ('ACCESSORIES', 'MEN'),
  ('SOCKS', 'MEN'),
  ('SHIRTS', 'KIDS'),
  ('TSHIRTS', 'KIDS'),
  ('TOPS', 'KIDS'),
  ('TROUSERS', 'KIDS'),
  ('JEANS', 'KIDS'),
  ('FORMAL_TROUSERS', 'KIDS'),
  ('SHORTS', 'KIDS'),
  ('JACKETS', 'KIDS'),
  ('COATS', 'KIDS'),
  ('HOODIES', 'KIDS'),
  ('SWEATSHIRTS', 'KIDS'),
  ('KNITWEAR', 'KIDS'),
  ('GIRLS_DRESSES', 'KIDS'),
  ('SKIRTS', 'KIDS'),
  ('LEGGINGS', 'KIDS'),
  ('FORMAL_SUITS', 'KIDS'),
  ('TWO_PIECE_SETS', 'KIDS'),
  ('MULTI_PIECE_SETS', 'KIDS'),
  ('JUMPSUITS', 'KIDS'),
  ('SPORTSWEAR', 'KIDS'),
  ('SWIMWEAR', 'KIDS'),
  ('SLEEPWEAR', 'KIDS'),
  ('LOUNGEWEAR', 'KIDS'),
  ('UNDERWEAR', 'KIDS'),
  ('NEWBORN', 'KIDS'),
  ('DUNGAREES', 'KIDS'),
  ('BABY_BODYSUITS', 'KIDS'),
  ('OCCASION_WEAR', 'KIDS'),
  ('SHOES', 'KIDS'),
  ('BAGS', 'KIDS'),
  ('JEWELLERY', 'KIDS'),
  ('WATCHES', 'KIDS'),
  ('EYEWEAR', 'KIDS'),
  ('BELTS', 'KIDS'),
  ('HATS_CAPS', 'KIDS'),
  ('ACCESSORIES', 'KIDS'),
  ('SOCKS', 'KIDS'),
  ('HAIR_ACCESSORIES', 'KIDS');

-- Seed: colours
INSERT INTO "taxonomy_colors" ("code", "nameAr", "nameEn", "hex", "sortOrder") VALUES
  ('WHITE', 'أبيض', 'White', '#ffffff', 1),
  ('BLUE', 'أزرق', 'Blue', '#2f6fd6', 2),
  ('CREAM', 'سكري', 'Cream', '#f3ead7', 3),
  ('PINK', 'زهري', 'Pink', '#f4a7bb', 4),
  ('BROWN', 'بني', 'Brown', '#7b4a2a', 5),
  ('CAMEL', 'كاميل', 'Camel', '#c19a6b', 6),
  ('INDIGO', 'نيلي', 'Indigo', '#3f3d99', 7),
  ('FUCHSIA', 'فوشي', 'Fuchsia', '#d62b8a', 8),
  ('LILAC', 'ليلكي/زهري', 'Lilac', '#c8a2c8', 9),
  ('GREEN', 'أخضر', 'Green', '#2e8b57', 10),
  ('BLACK', 'أسود', 'Black', '#111111', 11),
  ('RED', 'أحمر', 'Red', '#d0312d', 12),
  ('YELLOW', 'أصفر', 'Yellow', '#f2c230', 13),
  ('BEIGE', 'بيج', 'Beige', '#d9c7a7', 14),
  ('BURGUNDY', 'برغندي/خمري', 'Burgundy', '#6d1f2f', 15),
  ('DENIM', 'دينم/جينز', 'Denim', '#4a6c9b', 16),
  ('OLIVE', 'زيتي', 'Olive', '#6b6f2f', 17),
  ('MULTICOLOR', 'ألوان متعددة', 'Multicolour', NULL, 18),
  ('ORANGE', 'برتقالي', 'Orange', '#ef7d22', 19),
  ('NAVY', 'كحلي', 'Navy', '#1c2a4a', 20);

-- Seed: sizes (KIDS_AGE only ever accepted on a KIDS offer)
INSERT INTO "taxonomy_sizes" ("code", "label", "group", "sortOrder") VALUES
  ('ONE_SIZE', 'One Size', 'ADULT', 1),
  ('XS', 'XS', 'ADULT', 2),
  ('S', 'S', 'ADULT', 3),
  ('M', 'M', 'ADULT', 4),
  ('L', 'L', 'ADULT', 5),
  ('XL', 'XL', 'ADULT', 6),
  ('XXL', '2XL', 'ADULT', 7),
  ('XXXL', '3XL', 'ADULT', 8),
  ('XXXXL', '4XL', 'ADULT', 9),
  ('EU_36', '36', 'ADULT', 10),
  ('EU_38', '38', 'ADULT', 11),
  ('EU_40', '40', 'ADULT', 12),
  ('EU_42', '42', 'ADULT', 13),
  ('EU_44', '44', 'ADULT', 14),
  ('EU_46', '46', 'ADULT', 15),
  ('EU_48', '48', 'ADULT', 16),
  ('AGE_0_3M', '0–3 أشهر', 'KIDS_AGE', 17),
  ('AGE_3_6M', '3–6 أشهر', 'KIDS_AGE', 18),
  ('AGE_6_9M', '6–9 أشهر', 'KIDS_AGE', 19),
  ('AGE_9_12M', '9–12 شهرًا', 'KIDS_AGE', 20),
  ('AGE_12_18M', '12–18 شهرًا', 'KIDS_AGE', 21),
  ('AGE_18_24M', '18–24 شهرًا', 'KIDS_AGE', 22),
  ('AGE_2_3Y', '2–3 سنوات', 'KIDS_AGE', 23),
  ('AGE_3_4Y', '3–4 سنوات', 'KIDS_AGE', 24),
  ('AGE_4_5Y', '4–5 سنوات', 'KIDS_AGE', 25),
  ('AGE_5_6Y', '5–6 سنوات', 'KIDS_AGE', 26),
  ('AGE_6_7Y', '6–7 سنوات', 'KIDS_AGE', 27),
  ('AGE_7_8Y', '7–8 سنوات', 'KIDS_AGE', 28),
  ('AGE_8_9Y', '8–9 سنوات', 'KIDS_AGE', 29),
  ('AGE_9_10Y', '9–10 سنوات', 'KIDS_AGE', 30),
  ('AGE_10_11Y', '10–11 سنة', 'KIDS_AGE', 31),
  ('AGE_11_12Y', '11–12 سنة', 'KIDS_AGE', 32),
  ('AGE_12_13Y', '12–13 سنة', 'KIDS_AGE', 33),
  ('AGE_13_14Y', '13–14 سنة', 'KIDS_AGE', 34);

-- Database backstop for the unified-price rule: at commit time, every
-- variant of a classified offer (taxonomyVersion NOT NULL) must carry the
-- same price configuration. The API only ever writes all of them at once
-- (PUT .../offers/:id/price); this catches any path that does not.
CREATE FUNCTION "assert_offer_unified_price"() RETURNS trigger AS $$
DECLARE
  offer_id TEXT;
  distinct_prices INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'vendor_offers' THEN
    offer_id := NEW."id";
  ELSE
    offer_id := NEW."vendorOfferId";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "vendor_offers" WHERE "id" = offer_id AND "taxonomyVersion" IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT COUNT(DISTINCT ("basePrice", "salePrice", "discountPercent", "discountStartAt", "discountEndAt"))
    INTO distinct_prices
    FROM "offer_variants" WHERE "vendorOfferId" = offer_id;
  IF distinct_prices > 1 THEN
    RAISE EXCEPTION 'OFFER_PRICE_NOT_UNIFIED: every variant of classified offer % must share one price', offer_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "offer_variants_unified_price"
  AFTER INSERT OR UPDATE OF "basePrice", "salePrice", "discountPercent", "discountStartAt", "discountEndAt", "vendorOfferId"
  ON "offer_variants" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_offer_unified_price"();

CREATE CONSTRAINT TRIGGER "vendor_offers_unified_price"
  AFTER UPDATE OF "taxonomyVersion" ON "vendor_offers" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_offer_unified_price"();

-- Every NEW variant of a classified offer must be a taxonomy combination
-- (created by POST .../combinations, isCombination = true). This is what
-- stops the older variant endpoint and the CSV import from attaching a
-- plain variant to a classified offer. Variants that already existed
-- before an offer was classified are untouched (the rule is on INSERT and
-- on moving a variant between offers), and isCombination itself can never
-- be flipped after creation.
CREATE FUNCTION "assert_variant_is_combination"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."isCombination" IS DISTINCT FROM OLD."isCombination" THEN
    RAISE EXCEPTION 'COMBINATION_FLAG_IMMUTABLE: isCombination cannot change after a variant is created'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW."isCombination"
     AND (TG_OP = 'INSERT' OR NEW."vendorOfferId" IS DISTINCT FROM OLD."vendorOfferId")
     AND EXISTS (SELECT 1 FROM "vendor_offers" WHERE "id" = NEW."vendorOfferId" AND "taxonomyVersion" IS NOT NULL) THEN
    RAISE EXCEPTION 'OFFER_REQUIRES_COMBINATION: a classified offer only accepts colour/size combinations'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "offer_variants_require_combination"
  BEFORE INSERT OR UPDATE OF "vendorOfferId", "isCombination" ON "offer_variants"
  FOR EACH ROW EXECUTE FUNCTION "assert_variant_is_combination"();

-- Publish gate backstop: a product created after this migration
-- (requiresTaxonomy) cannot become ACTIVE until it is classified.
CREATE FUNCTION "assert_offer_classified_to_publish"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND NEW."requiresTaxonomy" AND NEW."taxonomyVersion" IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_CLASSIFIED: classify this product (audience + category) before publishing it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "vendor_offers_classified_to_publish"
  BEFORE INSERT OR UPDATE OF "status", "taxonomyVersion", "requiresTaxonomy" ON "vendor_offers"
  FOR EACH ROW EXECUTE FUNCTION "assert_offer_classified_to_publish"();
