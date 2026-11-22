-- PD-5b.1: platform editorial collections (admin-managed, canonical products).
-- Two new tables + one enum; no existing table or row changes. Unrelated
-- pre-existing schema drift removed.

-- CreateEnum
CREATE TYPE "PlatformCollectionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "platform_collections" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "descriptionAr" TEXT,
    "descriptionEn" TEXT,
    "audience" "ProductAudience",
    "showOnHome" BOOLEAN NOT NULL DEFAULT false,
    "status" "PlatformCollectionStatus" NOT NULL DEFAULT 'DRAFT',
    "publishFrom" TIMESTAMPTZ(3),
    "publishUntil" TIMESTAMPTZ(3),
    "sortOrder" INTEGER NOT NULL,
    "firstPublishedAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

CONSTRAINT "platform_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_collection_items" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "canonicalProductId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "platform_collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_collections_slug_key" ON "platform_collections"("slug");

-- CreateIndex
CREATE INDEX "platform_collections_status_sortOrder_idx" ON "platform_collections"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "platform_collection_items_canonicalProductId_idx" ON "platform_collection_items"("canonicalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_collection_items_collectionId_canonicalProductId_key" ON "platform_collection_items"("collectionId", "canonicalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_collection_items_collectionId_sortOrder_key" ON "platform_collection_items"("collectionId", "sortOrder");

-- AddForeignKey
ALTER TABLE "platform_collections" ADD CONSTRAINT "platform_collections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_collection_items" ADD CONSTRAINT "platform_collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "platform_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_collection_items" ADD CONSTRAINT "platform_collection_items_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_collection_items" ADD CONSTRAINT "platform_collection_items_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PD-5b hand-written rules (Prisma's schema language can't express them).
ALTER TABLE "platform_collections"
  ADD CONSTRAINT "platform_collections_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  ADD CONSTRAINT "platform_collections_titles" CHECK (
    char_length(btrim("titleAr")) BETWEEN 1 AND 80 AND char_length(btrim("titleEn")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "platform_collections_descriptions" CHECK (
    ("descriptionAr" IS NULL OR char_length("descriptionAr") <= 280)
    AND ("descriptionEn" IS NULL OR char_length("descriptionEn") <= 280)),
  ADD CONSTRAINT "platform_collections_window" CHECK (
    "publishFrom" IS NULL OR "publishUntil" IS NULL OR "publishUntil" > "publishFrom"),
  ADD CONSTRAINT "platform_collections_sort_order" CHECK ("sortOrder" >= 0),
  -- Lifecycle: PUBLISHED has a publish time; ARCHIVED an archive time; only
  -- a DRAFT may never have been published.
  ADD CONSTRAINT "platform_collections_lifecycle" CHECK (
    ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL)
    AND ("status" <> 'ARCHIVED' OR "archivedAt" IS NOT NULL)
    AND ("status" = 'DRAFT' OR "firstPublishedAt" IS NOT NULL));

ALTER TABLE "platform_collection_items"
  ADD CONSTRAINT "platform_collection_items_sort_order" CHECK ("sortOrder" BETWEEN 0 AND 23);

-- At most 24 items per collection, serialised per collection so two
-- concurrent writers can't both pass the count.
CREATE FUNCTION platform_collection_items_limit() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('finalpro:platform_collection_items:' || NEW."collectionId"));
  IF (SELECT count(*) FROM "platform_collection_items"
       WHERE "collectionId" = NEW."collectionId" AND "id" <> NEW."id") >= 24 THEN
    RAISE EXCEPTION 'COLLECTION_ITEM_LIMIT: a collection holds at most 24 products'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_collection_items_limit
  BEFORE INSERT OR UPDATE OF "collectionId" ON "platform_collection_items"
  FOR EACH ROW EXECUTE FUNCTION platform_collection_items_limit();
