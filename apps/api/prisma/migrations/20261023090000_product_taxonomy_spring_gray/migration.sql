-- Product taxonomy: a fourth season and a grey colour. Additive only -
-- no existing value, row or column changes. Runs after
-- 20261021120000_sprint27_product_taxonomy.

-- Postgres allows ADD VALUE inside the migration's transaction as long
-- as the new value is not used in that same transaction (it is not).
ALTER TYPE "ProductSeason" ADD VALUE IF NOT EXISTS 'SPRING';

INSERT INTO "taxonomy_colors" ("code", "nameAr", "nameEn", "hex", "sortOrder")
VALUES ('GRAY', 'رمادي', 'Gray', '#808080', 21)
ON CONFLICT ("code") DO NOTHING;
