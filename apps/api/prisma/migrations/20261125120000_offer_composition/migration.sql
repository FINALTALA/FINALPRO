-- Fabric composition and country of origin (2026-11-19): what the whole
-- product is made of, per part (shell, lining, filling, trim - each part's
-- fibres totalling 100%, checked by the API), and where it was made.
-- Both optional; separate from «الخامة» (a spec in templateAttributes),
-- which is unchanged. Additive only: existing products get NULL.
-- Runs after 20261124120000_variant_availability_subscriptions.

ALTER TABLE "vendor_offers"
  ADD COLUMN "composition" JSONB,
  ADD COLUMN "countryOfOrigin" TEXT;

ALTER TABLE "vendor_offers"
  ADD CONSTRAINT "vendor_offers_countryOfOrigin_iso2"
  CHECK ("countryOfOrigin" IS NULL OR "countryOfOrigin" ~ '^[A-Z]{2}$');
