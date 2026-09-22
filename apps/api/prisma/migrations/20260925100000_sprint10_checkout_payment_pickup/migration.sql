-- Sprint 10 (RB-ORD-002, RB-ORD-003, RB-ORD-004). Every new table here
-- is brand-new; every altered table (addresses, branch_stock,
-- branch_orders) only gains additive, nullable-or-defaulted columns -
-- no Sprint 1-9 data is touched or made invalid by this migration. See
-- schema.prisma's own Sprint 10 section comment for the full design
-- rationale (the real, DB-backed 10-minute reservation and why
-- BranchStock.reservedQuantity exists).

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable: addresses gains a nullable zone (PDR-022), reusing
-- Sprint 5's own "DeliveryZoneRegion" enum (already created by that
-- migration) rather than a new duplicate type - existing Sprint 2 rows
-- simply have zone = NULL and can't be used for delivery checkout
-- until re-saved with one.
ALTER TABLE "addresses" ADD COLUMN "zone" "DeliveryZoneRegion";

-- AlterTable: branch_stock gains reservedQuantity, defaulting existing
-- rows to 0 (nothing was ever reserved before this sprint).
ALTER TABLE "branch_stock" ADD COLUMN "reservedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_reservedQuantity_nonnegative" CHECK ("reservedQuantity" >= 0);
-- The core cross-path invariant this sprint depends on: physical
-- quantity can never drop below what is currently held by a live
-- reservation, through ANY writer (checkout confirm's atomic decrement
-- or InventoryController's own POS/manual-movement decrement, both
-- updated in this sprint to use the same "quantity + delta -
-- reservedQuantity >= 0" conditional-UPDATE shape - see
-- BranchStock.reservedQuantity's own schema.prisma comment).
ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_reserved_not_exceed_quantity" CHECK ("quantity" >= "reservedQuantity");

-- AlterTable: branch_orders gains the Sprint 10 columns - all
-- nullable, all additive.
ALTER TABLE "branch_orders" ADD COLUMN "scheduledDate" DATE;
ALTER TABLE "branch_orders" ADD COLUMN "pickupCode" TEXT;
ALTER TABLE "branch_orders" ADD COLUMN "paymentTransactionId" TEXT;
ALTER TABLE "branch_orders" ADD COLUMN "addressId" TEXT;

-- CreateIndex
CREATE INDEX "branch_orders_deliveryWindowId_scheduledDate_idx" ON "branch_orders"("deliveryWindowId", "scheduledDate");

-- CreateIndex
CREATE INDEX "branch_orders_paymentTransactionId_idx" ON "branch_orders"("paymentTransactionId");

-- AddForeignKey
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Codex review round 1 on commit d0ea80d (RB-ORD-004): a partial
-- unique index, not representable in Prisma's schema DSL (same
-- already-established pattern as e.g. StaffInvite's own partial unique
-- index) - two simultaneously-ACTIVE pickup orders at the same branch
-- can never share a pickup code, closing the collision gap a staff
-- member matching by code alone could otherwise hit. Scoped to
-- fulfilmentMethod = 'PICKUP' and a non-terminal status only - a
-- terminal order's code is free to be reused by a later active one,
-- and DELIVERY orders never set a code at all.
CREATE UNIQUE INDEX "branch_orders_active_pickup_code_key" ON "branch_orders"("branchId", "pickupCode")
  WHERE "pickupCode" IS NOT NULL
    AND "fulfilmentMethod" = 'PICKUP'
    AND "status" NOT IN ('COMPLETED', 'CANCELLED', 'REFUNDED');

-- AlterTable: vendor_delivery_zones (Sprint 5) gains the fee amount
-- that sprint's own migration comment explicitly deferred to RB-ORD-003
-- - nullable, since "enabled" keeps its existing lazy-default-true
-- meaning unchanged and a NULL fee separately means "not priced yet"
-- (see VendorDeliveryZone's own schema.prisma comment). No new table,
-- no new enum - reuses Sprint 5's own "vendor_delivery_zones" table and
-- "DeliveryZoneRegion" type as-is.
ALTER TABLE "vendor_delivery_zones" ADD COLUMN "fee" DECIMAL(10,2);
ALTER TABLE "vendor_delivery_zones" ADD CONSTRAINT "vendor_delivery_zones_fee_nonnegative" CHECK ("fee" IS NULL OR "fee" >= 0);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cart_items_customerId_idx" ON "cart_items"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_customerId_vendorId_offerVariantId_key" ON "cart_items"("customerId", "vendorId", "offerVariantId");

ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - against offer_variants' own (vendorId, id)).
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "customerOrderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PaymentTransactionStatus" NOT NULL,
    "sandboxReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_transactions_customerOrderId_idx" ON "payment_transactions"("customerOrderId");

ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amount_nonnegative" CHECK ("amount" >= 0);

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_customerOrderId_fkey" FOREIGN KEY ("customerOrderId") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (branch_orders.paymentTransactionId - plain, not
-- composite: PaymentTransaction is checkout-scoped, not vendor-owned,
-- so there is no tenant dimension to compose against here).
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "checkout_reservations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_reservations_customerId_idx" ON "checkout_reservations"("customerId");

-- CreateIndex
CREATE INDEX "checkout_reservations_expiresAt_idx" ON "checkout_reservations"("expiresAt");

-- AddForeignKey
ALTER TABLE "checkout_reservations" ADD CONSTRAINT "checkout_reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "checkout_reservation_items" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceAtReserve" DECIMAL(10,2) NOT NULL,
    "fulfilmentMethod" "FulfilmentMethod" NOT NULL,
    "paymentMethod" "BranchOrderPaymentMethod" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cartItemId" TEXT,

    CONSTRAINT "checkout_reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_reservation_items_vendorId_branchId_offerVariant_idx" ON "checkout_reservation_items"("vendorId", "branchId", "offerVariantId");

ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_unitPrice_nonnegative" CHECK ("unitPriceAtReserve" >= 0);

-- AddForeignKey (cascade - a reservation's items die with it, whether
-- consumed at confirm or released at expiry/cancel).
ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "checkout_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (composite - against store_branches' own (vendorId, id)).
ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - against offer_variants' own (vendorId, id)).
ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (plain, SET NULL - Codex review round 1 on commit
-- d0ea80d: tracks the exact source cart line so confirm() can
-- decrement only the reserved amount from it, never bulk-delete the
-- whole line and lose quantity the customer added during the hold.
-- SET NULL, not RESTRICT: the customer may still freely edit/delete
-- this cart line while the hold is live - the stock hold itself stays
-- valid regardless, only the cart-reconciliation step at confirm has
-- nothing left to do if it's gone).
ALTER TABLE "checkout_reservation_items" ADD CONSTRAINT "checkout_reservation_items_cartItemId_fkey" FOREIGN KEY ("cartItemId") REFERENCES "cart_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "checkout_reservation_slots" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "deliveryWindowId" TEXT NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "deliveryFeeAtReserve" DECIMAL(10,2) NOT NULL,
    "addressId" TEXT NOT NULL,

    CONSTRAINT "checkout_reservation_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_reservation_slots_deliveryWindowId_scheduledDate_idx" ON "checkout_reservation_slots"("deliveryWindowId", "scheduledDate");

ALTER TABLE "checkout_reservation_slots" ADD CONSTRAINT "checkout_reservation_slots_fee_nonnegative" CHECK ("deliveryFeeAtReserve" >= 0);

-- AddForeignKey (cascade - same reasoning as reservation items above).
ALTER TABLE "checkout_reservation_slots" ADD CONSTRAINT "checkout_reservation_slots_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "checkout_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (composite, 3-column - against delivery_windows' own
-- (vendorId, branchId, id), the same tenant/branch-safe target
-- branch_orders.deliveryWindowId already uses).
ALTER TABLE "checkout_reservation_slots" ADD CONSTRAINT "checkout_reservation_slots_vendorId_branchId_deliveryWind_fkey" FOREIGN KEY ("vendorId", "branchId", "deliveryWindowId") REFERENCES "delivery_windows"("vendorId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_reservation_slots" ADD CONSTRAINT "checkout_reservation_slots_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
