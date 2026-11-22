-- The product panel's appearance editor (the "panel" pencil on the public
-- store page). Stores only the owner's overrides; '{}' = the current look
-- for every existing store (the API merges overrides over defaults equal
-- to the stylesheet's own values). Additive only.
ALTER TABLE "vendors"
  ADD COLUMN "storefrontAppearance" JSONB NOT NULL DEFAULT '{}';

-- The API validates the full shape; the database at least keeps it an
-- object.
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_storefrontAppearance_object" CHECK (jsonb_typeof("storefrontAppearance") = 'object');
