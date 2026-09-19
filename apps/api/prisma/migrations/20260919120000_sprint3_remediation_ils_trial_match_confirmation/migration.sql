-- Sprint 3 remediation (approved-product-decisions-2026-09.md,
-- PDR-001/PDR-012/PDR-033; docs/sprint-1-3-compatibility-audit-2026-09.md
-- S3-B01/S3-B02/S3-B03). Three changes, each tied to one blocker:
--
-- 1. PDR-001 (ILS-only): drops offer_variants.currency entirely - there
--    is no FX conversion or vendor-native checkout currency, so the
--    column (which only ever held "ILS" in practice) is removed rather
--    than kept as a vestigial always-ILS field.
-- 2. PDR-033 (unified sandbox subscription): drops vendor_subscriptions.
--    plan (SubscriptionPlan enum removed with it) and .graceDeadline -
--    no Basic/Pro tiers, no grace-period billing lifecycle. SubscriptionStatus
--    is narrowed from NONE/ACTIVE/PAST_DUE/SUSPENDED/CANCELLED to
--    NONE/ACTIVE/EXPIRED.
-- 3. PDR-012 (match confirmation required): adds
--    offer_variants.matchProposalStatus/proposedCanonicalVariantId - an
--    exact-identifier match is now stored as a pending proposal, never
--    an immediate link, until the store owner explicitly confirms it.
--
-- Migration safety note (SubscriptionStatus): narrowing this enum can't
-- use a plain ::text::newtype cast if any row still holds a value the
-- new type doesn't have (PAST_DUE/SUSPENDED/CANCELLED) - and a value
-- can't be normalized to 'EXPIRED' via a pre-swap UPDATE either, since
-- 'EXPIRED' isn't valid in the *old* enum type until after the swap.
-- The USING clauses below remap those three legacy values to 'EXPIRED'
-- (the closest honest equivalent - "not currently usable") inline, as
-- part of the type conversion itself, so this can never fail regardless
-- of what a given database's rows actually hold - even though no
-- environment this has run against (local dev/CI only; Sprint 3 was
-- never merged to main, so no production data exists) has ever driven
-- a subscription into those states, since that lifecycle was never
-- built.
--
-- Migration safety note (offer_variants.currency, review-round finding):
-- unlike SubscriptionStatus above, currency is NOT safe to silently
-- remap - the pre-remediation DTO accepted any string, so a real
-- dev/staging database could genuinely hold USD/JOD rows. Dropping the
-- column without checking would make that price silently read as ILS
-- forever, with no FX rate this migration is authorised to invent and
-- no way to recover the original value afterward - real data
-- corruption, not a cosmetic normalization. The DO block below is a
-- hard preflight: it inspects every row first and refuses to proceed
-- (via RAISE EXCEPTION, aborting the whole migration transaction) if
-- any is found, naming exactly how many and requiring a human to
-- correct them before re-running this migration. No automatic
-- conversion, ever.
--
-- As with every prior migration here, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in the earlier migrations. Left alone again.

DO $$
DECLARE
  non_ils_count integer;
BEGIN
  SELECT COUNT(*) INTO non_ils_count
  FROM "offer_variants"
  WHERE "currency" IS DISTINCT FROM 'ILS';

  IF non_ils_count > 0 THEN
    RAISE EXCEPTION 'Refusing to drop offer_variants.currency: % row(s) have a currency value other than ILS (PDR-001 remediation preflight). Correct or migrate these rows to ILS manually first - this migration performs no automatic currency conversion and invents no FX rate. Inspect them with: SELECT id, "sellerSku", currency, "basePrice" FROM offer_variants WHERE currency IS DISTINCT FROM ''ILS'';', non_ils_count;
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "MatchProposalStatus" AS ENUM ('NONE', 'PENDING', 'CONFIRMED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "SubscriptionStatus_new" AS ENUM ('NONE', 'ACTIVE', 'EXPIRED');
ALTER TABLE "public"."vendor_subscriptions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."vendors" ALTER COLUMN "subscriptionStatus" DROP DEFAULT;
ALTER TABLE "vendors" ALTER COLUMN "subscriptionStatus" TYPE "SubscriptionStatus_new" USING (
  CASE "subscriptionStatus"::text
    WHEN 'PAST_DUE' THEN 'EXPIRED'
    WHEN 'SUSPENDED' THEN 'EXPIRED'
    WHEN 'CANCELLED' THEN 'EXPIRED'
    ELSE "subscriptionStatus"::text
  END
)::"SubscriptionStatus_new";
ALTER TABLE "vendor_subscriptions" ALTER COLUMN "status" TYPE "SubscriptionStatus_new" USING (
  CASE "status"::text
    WHEN 'PAST_DUE' THEN 'EXPIRED'
    WHEN 'SUSPENDED' THEN 'EXPIRED'
    WHEN 'CANCELLED' THEN 'EXPIRED'
    ELSE "status"::text
  END
)::"SubscriptionStatus_new";
ALTER TYPE "SubscriptionStatus" RENAME TO "SubscriptionStatus_old";
ALTER TYPE "SubscriptionStatus_new" RENAME TO "SubscriptionStatus";
DROP TYPE "public"."SubscriptionStatus_old";
ALTER TABLE "vendor_subscriptions" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
ALTER TABLE "vendors" ALTER COLUMN "subscriptionStatus" SET DEFAULT 'NONE';
COMMIT;

-- AlterTable
ALTER TABLE "offer_variants" DROP COLUMN "currency",
ADD COLUMN     "matchProposalStatus" "MatchProposalStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "proposedCanonicalVariantId" TEXT;

-- AlterTable
ALTER TABLE "vendor_subscriptions" DROP COLUMN "graceDeadline",
DROP COLUMN "plan";

-- DropEnum
DROP TYPE "SubscriptionPlan";

-- CreateIndex
CREATE INDEX "offer_variants_proposedCanonicalVariantId_idx" ON "offer_variants"("proposedCanonicalVariantId");

-- AddForeignKey
ALTER TABLE "offer_variants" ADD CONSTRAINT "offer_variants_proposedCanonicalVariantId_fkey" FOREIGN KEY ("proposedCanonicalVariantId") REFERENCES "canonical_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
