-- Edit drafts for published products. Additive:
--  * vendor_offers."contentRevision": the product's CONTENT revision, raised
--    by triggers whenever content changes anywhere (name, brand, specs,
--    model, the size-guide choice, classification; a version's price,
--    discount, description, colour or SKU; a new version; images; product
--    colours; shared images; a newly published own size table) - never by
--    stock, holds, status or archiving. An edit draft remembers the revision
--    it was opened at and is applied only if nothing changed meanwhile;
--  * offer_drafts: "editOfOfferId" (the product being edited - composite
--    FK, same store), "baseRevision" + "baseSnapshot" (the product as it was
--    when the draft was opened: conflicts are explained per group), and
--    "lastEditedByUserId"/"lastEditedAt" (presence: «تُعدَّل حالياً من عضو في
--    فريق المتجر» - no name is shown);
--  * at most ONE open edit draft per product (partial unique index);
--  * an edit draft can never be SUBMITTED (a build that does not know edit
--    drafts would otherwise create a duplicate product - the trigger refuses
--    it, so its whole transaction rolls back), and only an edit draft is
--    APPLIED.
-- No existing row changes (every existing draft is a creation draft; every
-- product starts at revision 1).
--
-- `ALTER TYPE ... ADD VALUE` is committed on its own before anything below
-- compares against it (see 20260919140000's note).

-- AlterEnum
BEGIN;
ALTER TYPE "OfferDraftStatus" ADD VALUE 'APPLIED';
COMMIT;

ALTER TABLE "vendor_offers" ADD COLUMN "contentRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "offer_drafts"
  ADD COLUMN "editOfOfferId" TEXT,
  ADD COLUMN "baseRevision" INTEGER,
  ADD COLUMN "baseSnapshot" JSONB,
  ADD COLUMN "lastEditedByUserId" TEXT,
  ADD COLUMN "lastEditedAt" TIMESTAMP(3);

ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_vendorId_editOfOfferId_fkey"
  FOREIGN KEY ("vendorId", "editOfOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_lastEditedByUserId_fkey"
  FOREIGN KEY ("lastEditedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- the edit fields go together; an edit draft never "creates" a product
ALTER TABLE "offer_drafts" ADD CONSTRAINT "offer_drafts_edit_fields"
  CHECK (("editOfOfferId" IS NULL) = ("baseRevision" IS NULL)
     AND ("editOfOfferId" IS NULL) = ("baseSnapshot" IS NULL)
     AND NOT ("editOfOfferId" IS NOT NULL AND "offerId" IS NOT NULL));

-- one open edit draft per product
CREATE UNIQUE INDEX "offer_drafts_open_edit_key" ON "offer_drafts"("editOfOfferId")
  WHERE "status" = 'OPEN' AND "editOfOfferId" IS NOT NULL;
CREATE INDEX "offer_drafts_vendorId_editOfOfferId_idx" ON "offer_drafts"("vendorId", "editOfOfferId");

CREATE FUNCTION "offer_drafts_edit_status"() RETURNS trigger AS $$
BEGIN
  IF NEW."editOfOfferId" IS NOT NULL AND NEW."status" = 'SUBMITTED' THEN
    RAISE EXCEPTION 'EDIT_DRAFT_NOT_SUBMITTABLE: an edit draft is applied to its product, never published as a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."editOfOfferId" IS NULL AND NEW."status" = 'APPLIED' THEN
    RAISE EXCEPTION 'ONLY_EDIT_DRAFTS_APPLY: only an edit draft is applied'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_drafts_edit_status"
  BEFORE INSERT OR UPDATE OF "status", "editOfOfferId" ON "offer_drafts"
  FOR EACH ROW EXECUTE FUNCTION "offer_drafts_edit_status"();

-- ------------------------------------------------------- content revision
CREATE FUNCTION "bump_offer_content_revision"(offer_id TEXT) RETURNS void AS $$
  UPDATE "vendor_offers" SET "contentRevision" = "contentRevision" + 1 WHERE "id" = offer_id;
$$ LANGUAGE sql;

-- the product's own content columns (never status / archivedAt)
CREATE FUNCTION "vendor_offers_content_revision"() RETURNS trigger AS $$
BEGIN
  NEW."contentRevision" := OLD."contentRevision" + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "vendor_offers_content_revision"
  BEFORE UPDATE ON "vendor_offers"
  FOR EACH ROW
  WHEN (OLD."titleAr" IS DISTINCT FROM NEW."titleAr"
     OR OLD."titleEn" IS DISTINCT FROM NEW."titleEn"
     OR OLD."brandId" IS DISTINCT FROM NEW."brandId"
     OR OLD."categoryTemplate" IS DISTINCT FROM NEW."categoryTemplate"
     OR OLD."templateAttributes"::text IS DISTINCT FROM NEW."templateAttributes"::text
     OR OLD."modelHeightCm" IS DISTINCT FROM NEW."modelHeightCm"
     OR OLD."modelSize" IS DISTINCT FROM NEW."modelSize"
     OR OLD."sizeGuideId" IS DISTINCT FROM NEW."sizeGuideId"
     OR OLD."taxonomyVersion" IS DISTINCT FROM NEW."taxonomyVersion"
     OR OLD."season" IS DISTINCT FROM NEW."season")
  EXECUTE FUNCTION "vendor_offers_content_revision"();

-- a version's price, discount, description, colour or SKU; a new version
CREATE FUNCTION "offer_variants_content_revision"() RETURNS trigger AS $$
BEGIN
  PERFORM "bump_offer_content_revision"(NEW."vendorOfferId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_variants_content_revision_ins"
  AFTER INSERT ON "offer_variants"
  FOR EACH ROW EXECUTE FUNCTION "offer_variants_content_revision"();
CREATE TRIGGER "offer_variants_content_revision_upd"
  AFTER UPDATE ON "offer_variants"
  FOR EACH ROW
  WHEN (OLD."basePrice" IS DISTINCT FROM NEW."basePrice"
     OR OLD."salePrice" IS DISTINCT FROM NEW."salePrice"
     OR OLD."discountPercent" IS DISTINCT FROM NEW."discountPercent"
     OR OLD."discountStartAt" IS DISTINCT FROM NEW."discountStartAt"
     OR OLD."discountEndAt" IS DISTINCT FROM NEW."discountEndAt"
     OR OLD."specsTextAr" IS DISTINCT FROM NEW."specsTextAr"
     OR OLD."specsTextEn" IS DISTINCT FROM NEW."specsTextEn"
     OR OLD."offerColorId" IS DISTINCT FROM NEW."offerColorId"
     OR OLD."sellerSku" IS DISTINCT FROM NEW."sellerSku")
  EXECUTE FUNCTION "offer_variants_content_revision"();

-- images of a version
CREATE FUNCTION "offer_variant_media_content_revision"() RETURNS trigger AS $$
BEGIN
  PERFORM "bump_offer_content_revision"(v."vendorOfferId")
  FROM "offer_variants" v WHERE v."id" = COALESCE(NEW."offerVariantId", OLD."offerVariantId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_variant_media_content_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "offer_variant_media"
  FOR EACH ROW EXECUTE FUNCTION "offer_variant_media_content_revision"();

-- product colours, shared images, classification: rows carrying "vendorOfferId"
CREATE FUNCTION "offer_child_content_revision"() RETURNS trigger AS $$
BEGIN
  PERFORM "bump_offer_content_revision"(COALESCE(NEW."vendorOfferId", OLD."vendorOfferId"));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "offer_colors_content_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "offer_colors"
  FOR EACH ROW EXECUTE FUNCTION "offer_child_content_revision"();
CREATE TRIGGER "vendor_offer_shared_media_content_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "vendor_offer_shared_media"
  FOR EACH ROW EXECUTE FUNCTION "offer_child_content_revision"();
CREATE TRIGGER "vendor_offer_audiences_content_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "vendor_offer_audiences"
  FOR EACH ROW EXECUTE FUNCTION "offer_child_content_revision"();
CREATE TRIGGER "vendor_offer_categories_content_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "vendor_offer_categories"
  FOR EACH ROW EXECUTE FUNCTION "offer_child_content_revision"();

-- a newly published version of the product's own size table
CREATE FUNCTION "size_guide_versions_content_revision"() RETURNS trigger AS $$
BEGIN
  PERFORM "bump_offer_content_revision"(g."vendorOfferId")
  FROM "size_guides" g WHERE g."id" = NEW."guideId" AND g."vendorOfferId" IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "size_guide_versions_content_revision"
  AFTER UPDATE OF "status" ON "size_guide_versions"
  FOR EACH ROW
  WHEN (NEW."status" = 'PUBLISHED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "size_guide_versions_content_revision"();
