-- The detailed categories each store offers per department (the public
-- storefront's subcategory chips), replacing the storefront's
-- frontend-only lists. Departments stay where they already are
-- (vendor_applicable_categories WOMEN/MEN/KIDS). Additive.
CREATE TABLE "storefront_categories" (
    "vendorId" TEXT NOT NULL,
    "audience" "ProductAudience" NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storefront_categories_pkey" PRIMARY KEY ("vendorId", "audience", "categoryCode")
);

CREATE INDEX "storefront_categories_vendorId_audience_sortOrder_idx" ON "storefront_categories"("vendorId", "audience", "sortOrder");

ALTER TABLE "storefront_categories"
  ADD CONSTRAINT "storefront_categories_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a (category, audience) pair the taxonomy links can be stored.
ALTER TABLE "storefront_categories"
  ADD CONSTRAINT "storefront_categories_categoryCode_audience_fkey" FOREIGN KEY ("categoryCode", "audience") REFERENCES "taxonomy_category_audiences"("categoryCode", "audience") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing stores start with the categories their own ACTIVE classified
-- products already use (each under every audience of that product the
-- category belongs to), in the taxonomy's order.
INSERT INTO "storefront_categories" ("vendorId", "audience", "categoryCode", "sortOrder")
SELECT DISTINCT vo."vendorId", a."audience", c."categoryCode", tc."sortOrder"
FROM "vendor_offers" vo
JOIN "vendor_offer_audiences" a ON a."vendorOfferId" = vo."id"
JOIN "vendor_offer_categories" c ON c."vendorOfferId" = vo."id"
JOIN "taxonomy_category_audiences" l ON l."categoryCode" = c."categoryCode" AND l."audience" = a."audience"
JOIN "taxonomy_categories" tc ON tc."code" = c."categoryCode"
WHERE vo."status" = 'ACTIVE' AND vo."taxonomyVersion" IS NOT NULL;
