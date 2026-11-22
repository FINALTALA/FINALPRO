-- Independent storefront cover layers. Additive only - the defaults are
-- today's look, so no existing store changes appearance:
--   * cover image and the upper colour wash stay on (the wash still
--     only shows when the store has a cover colour),
--   * the new global colour layer is off,
--   * the bottom panel fade keeps its #4A1626 shadow at 6%.
-- Turning a layer off later only flips its *_Enabled flag; its colour
-- and strength stay saved.
ALTER TABLE "vendors"
  ADD COLUMN "coverImageEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "coverTintEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "coverGlobalOverlayEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "coverGlobalOverlayColor" TEXT NOT NULL DEFAULT '#D6AFA4',
  ADD COLUMN "coverGlobalOverlayOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  ADD COLUMN "coverGlobalOverlayBrightness" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "coverBottomFadeEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "coverBottomFadeColor" TEXT NOT NULL DEFAULT '#4A1626',
  ADD COLUMN "coverBottomFadeOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.06;

-- The API validates the same rules; these keep direct writes honest.
-- Brightness 0.5-1.5: half to one-and-a-half times the colour's own
-- brightness (1 = unchanged).
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_coverColor_hex" CHECK ("coverColor" IS NULL OR "coverColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "vendors_coverGlobalOverlayColor_hex" CHECK ("coverGlobalOverlayColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "vendors_coverBottomFadeColor_hex" CHECK ("coverBottomFadeColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "vendors_coverGlobalOverlayOpacity_range" CHECK ("coverGlobalOverlayOpacity" >= 0 AND "coverGlobalOverlayOpacity" <= 1),
  ADD CONSTRAINT "vendors_coverGlobalOverlayBrightness_range" CHECK ("coverGlobalOverlayBrightness" >= 0.5 AND "coverGlobalOverlayBrightness" <= 1.5),
  ADD CONSTRAINT "vendors_coverBottomFadeOpacity_range" CHECK ("coverBottomFadeOpacity" >= 0 AND "coverBottomFadeOpacity" <= 1);
