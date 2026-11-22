-- PD-5.2: the internal sales rank - derived data only, rebuilt from
-- orders by SalesRankService. Creates two new tables; changes no
-- existing table or row. Unrelated pre-existing schema drift removed.

-- CreateEnum
CREATE TYPE "SalesRankScope" AS ENUM ('OFFER', 'CANONICAL');

-- CreateEnum
CREATE TYPE "SalesRankTrigger" AS ENUM ('SCHEDULED', 'ADMIN');

-- CreateTable
CREATE TABLE "sales_rank_runs" (
    "id" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "trigger" "SalesRankTrigger" NOT NULL,
    "triggeredById" TEXT,
    "rowCount" INTEGER NOT NULL,
    "qualifiedCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_rank_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_rank_snapshots" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "scope" "SalesRankScope" NOT NULL,
    "vendorId" TEXT,
    "vendorOfferId" TEXT,
    "canonicalProductId" TEXT,
    "categoryCode" TEXT NOT NULL,
    "audience" "ProductAudience" NOT NULL,
    "units" INTEGER NOT NULL,
    "customers" INTEGER NOT NULL,
    "firstSoldAt" TIMESTAMPTZ(3) NOT NULL,
    "rank" INTEGER NOT NULL,
    "qualifiedRank" INTEGER,
    "qualified" BOOLEAN NOT NULL,

    CONSTRAINT "sales_rank_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_rank_runs_computedAt_idx" ON "sales_rank_runs"("computedAt");

-- CreateIndex
CREATE INDEX "sales_rank_snapshots_vendorOfferId_idx" ON "sales_rank_snapshots"("vendorOfferId");

-- CreateIndex
CREATE INDEX "sales_rank_snapshots_canonicalProductId_idx" ON "sales_rank_snapshots"("canonicalProductId");

-- AddForeignKey
ALTER TABLE "sales_rank_runs" ADD CONSTRAINT "sales_rank_runs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rank_snapshots" ADD CONSTRAINT "sales_rank_snapshots_runId_fkey" FOREIGN KEY ("runId") REFERENCES "sales_rank_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rank_snapshots" ADD CONSTRAINT "sales_rank_snapshots_vendorId_vendorOfferId_fkey" FOREIGN KEY ("vendorId", "vendorOfferId") REFERENCES "vendor_offers"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rank_snapshots" ADD CONSTRAINT "sales_rank_snapshots_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rank_snapshots" ADD CONSTRAINT "sales_rank_snapshots_categoryCode_audience_fkey" FOREIGN KEY ("categoryCode", "audience") REFERENCES "taxonomy_category_audiences"("categoryCode", "audience") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PD-5.2 hand-written constraints (Prisma's schema language can't express them).
ALTER TABLE "sales_rank_runs"
  ADD CONSTRAINT "sales_rank_runs_window" CHECK ("windowEnd" > "windowStart"),
  ADD CONSTRAINT "sales_rank_runs_counts" CHECK ("rowCount" >= 0 AND "qualifiedCount" >= 0 AND "qualifiedCount" <= "rowCount"),
  ADD CONSTRAINT "sales_rank_runs_trigger_actor" CHECK (("trigger" = 'ADMIN') = ("triggeredById" IS NOT NULL));

ALTER TABLE "sales_rank_snapshots"
  -- An OFFER entry names one store's offer; a CANONICAL entry one product.
  ADD CONSTRAINT "sales_rank_snapshots_scope_target" CHECK (
    ("scope" = 'OFFER' AND "vendorId" IS NOT NULL AND "vendorOfferId" IS NOT NULL AND "canonicalProductId" IS NULL)
    OR ("scope" = 'CANONICAL' AND "vendorId" IS NULL AND "vendorOfferId" IS NULL AND "canonicalProductId" IS NOT NULL)
  ),
  ADD CONSTRAINT "sales_rank_snapshots_counts" CHECK ("units" >= 1 AND "customers" >= 1 AND "customers" <= "units"),
  ADD CONSTRAINT "sales_rank_snapshots_rank" CHECK ("rank" >= 1),
  ADD CONSTRAINT "sales_rank_snapshots_qualified" CHECK (
    ("qualified" AND "qualifiedRank" BETWEEN 1 AND 10) OR (NOT "qualified" AND "qualifiedRank" IS NULL)
  );

-- One entry per target and scope (category + audience).
CREATE UNIQUE INDEX "sales_rank_snapshots_offer_scope_key"
  ON "sales_rank_snapshots"("vendorOfferId", "categoryCode", "audience") WHERE "scope" = 'OFFER';
CREATE UNIQUE INDEX "sales_rank_snapshots_canonical_scope_key"
  ON "sales_rank_snapshots"("canonicalProductId", "categoryCode", "audience") WHERE "scope" = 'CANONICAL';
-- Ranks are unique within a scope.
CREATE UNIQUE INDEX "sales_rank_snapshots_rank_key"
  ON "sales_rank_snapshots"("scope", "categoryCode", "audience", "rank");
