-- Sprint 20b (FR-PRICE-006, FR-CART-003/012/014): minimum order value
-- (branch default + delivery-zone override), customer/internal-store
-- notes, and platform-terms acceptance snapshot. All columns are
-- additive and nullable - no backfill needed, every existing row is
-- correctly "no minimum set / no note / terms not recorded" by virtue
-- of being NULL.

-- AlterTable
ALTER TABLE "branch_orders" ADD COLUMN     "customerNote" TEXT,
ADD COLUMN     "internalStoreNote" TEXT;

-- AlterTable
ALTER TABLE "checkout_reservation_items" ADD COLUMN     "customerNote" TEXT;

-- AlterTable
ALTER TABLE "checkout_reservations" ADD COLUMN     "platformTermsVersion" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "customer_orders" ADD COLUMN     "platformTermsVersion" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_branches" ADD COLUMN     "minimumOrderValue" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "vendor_delivery_zones" ADD COLUMN     "minimumOrderValue" DECIMAL(10,2);
