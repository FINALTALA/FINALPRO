-- Independent public hero copy. displayName remains the store identity used
-- throughout discovery and account surfaces; this field belongs only to the
-- large title in the public storefront hero.
ALTER TABLE "vendors" ADD COLUMN "heroTitle" TEXT;
