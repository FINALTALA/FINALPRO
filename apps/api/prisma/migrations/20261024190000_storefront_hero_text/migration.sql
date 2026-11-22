-- The hero title's and description's own text styling (their pencils).
-- Additive only: colour/font/weight start NULL (= the stylesheet's
-- default) and both shadows start off, so no existing store changes.
ALTER TABLE "vendors"
  ADD COLUMN "heroTitleColor" TEXT,
  ADD COLUMN "heroTitleFont" TEXT,
  ADD COLUMN "heroTitleWeight" INTEGER,
  ADD COLUMN "heroTitleShadowEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "heroTitleShadowStrength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "bioColor" TEXT,
  ADD COLUMN "bioFont" TEXT,
  ADD COLUMN "bioWeight" INTEGER,
  ADD COLUMN "bioShadowEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bioShadowStrength" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

-- The API validates the same rules; these keep direct writes honest.
-- Fonts are the identifiers of src/vendors/hero-text.ts HERO_FONTS;
-- Amiri ships only its bold face.
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_heroTitleColor_hex" CHECK ("heroTitleColor" IS NULL OR "heroTitleColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "vendors_bioColor_hex" CHECK ("bioColor" IS NULL OR "bioColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "vendors_heroTitleFont_known" CHECK ("heroTitleFont" IS NULL OR "heroTitleFont" IN ('NOTO_SANS', 'AMIRI', 'REEM_KUFI', 'BALOO_BHAIJAAN')),
  ADD CONSTRAINT "vendors_bioFont_known" CHECK ("bioFont" IS NULL OR "bioFont" IN ('NOTO_SANS', 'AMIRI', 'REEM_KUFI', 'BALOO_BHAIJAAN')),
  ADD CONSTRAINT "vendors_heroTitleWeight_known" CHECK ("heroTitleWeight" IS NULL OR "heroTitleWeight" IN (400, 500, 600, 700)),
  ADD CONSTRAINT "vendors_bioWeight_known" CHECK ("bioWeight" IS NULL OR "bioWeight" IN (400, 500, 600, 700)),
  ADD CONSTRAINT "vendors_heroTitle_amiri_bold" CHECK ("heroTitleFont" IS DISTINCT FROM 'AMIRI' OR "heroTitleWeight" IS NULL OR "heroTitleWeight" = 700),
  ADD CONSTRAINT "vendors_bio_amiri_bold" CHECK ("bioFont" IS DISTINCT FROM 'AMIRI' OR "bioWeight" IS NULL OR "bioWeight" = 700),
  ADD CONSTRAINT "vendors_heroTitleShadowStrength_range" CHECK ("heroTitleShadowStrength" >= 0.1 AND "heroTitleShadowStrength" <= 1),
  ADD CONSTRAINT "vendors_bioShadowStrength_range" CHECK ("bioShadowStrength" >= 0.1 AND "bioShadowStrength" <= 1);
