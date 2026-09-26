-- Sprint 15 (PDR-035, OPEN-011 closed): ONLINE_ONLY store verification
-- via a warehouse-address snapshot, independent of the operational
-- warehouses table so an owner editing their address later never
-- silently changes what a reviewer already approved. Entirely
-- additive: one new enum, one new empty table, one new index on the
-- already-existing warehouses table. No existing column, row, or
-- constraint is touched.

-- CreateEnum
CREATE TYPE "WarehouseVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUESTED');

-- CreateIndex (additive alongside warehouses_vendorId_key - see
-- schema.prisma's comment on Warehouse.@@unique([vendorId, id]) -
-- this is what the new table's composite FK below targets)
CREATE UNIQUE INDEX "warehouses_vendorId_id_key" ON "warehouses"("vendorId", "id");

-- CreateTable
CREATE TABLE "warehouse_verification_evidence" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "addressNote" TEXT NOT NULL,
    "status" "WarehouseVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "warehouse_verification_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_verification_evidence_vendorId_status_idx" ON "warehouse_verification_evidence"("vendorId", "status");

-- CreateIndex (partial - not representable in schema.prisma, see the
-- WarehouseVerificationEvidence model's own doc comment. This is the
-- structural, database-level guarantee that at most one PENDING
-- snapshot exists per vendor at any time - the SELECT ... FOR UPDATE
-- lock in application code exists to order concurrent submissions and
-- return a clean 409 before this constraint would ever fire, not
-- instead of it.)
CREATE UNIQUE INDEX "warehouse_verification_evidence_vendor_pending_key" ON "warehouse_verification_evidence"("vendorId") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "warehouse_verification_evidence" ADD CONSTRAINT "warehouse_verification_evidence_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - tenant-safe, see the model's own comment
-- on why warehouseId alone would not be)
ALTER TABLE "warehouse_verification_evidence" ADD CONSTRAINT "warehouse_verification_evidence_vendorId_warehouseId_fkey" FOREIGN KEY ("vendorId", "warehouseId") REFERENCES "warehouses"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_verification_evidence" ADD CONSTRAINT "warehouse_verification_evidence_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
