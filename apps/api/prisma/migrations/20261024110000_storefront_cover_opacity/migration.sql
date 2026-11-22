-- Storefront cover look as per-store settings. Additive only: the
-- defaults are the fixed values the public store hero used until now
-- (cover image opacity .20, cover colour wash 30%), so every existing
-- store keeps exactly its current appearance.
ALTER TABLE "vendors"
  ADD COLUMN "coverImageOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  ADD COLUMN "coverTintOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.3;

-- The API validates 0-1 too; this keeps direct writes honest as well.
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_coverImageOpacity_range" CHECK ("coverImageOpacity" >= 0 AND "coverImageOpacity" <= 1),
  ADD CONSTRAINT "vendors_coverTintOpacity_range" CHECK ("coverTintOpacity" >= 0 AND "coverTintOpacity" <= 1);
