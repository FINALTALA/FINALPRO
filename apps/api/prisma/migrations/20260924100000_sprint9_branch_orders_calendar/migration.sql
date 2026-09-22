-- Sprint 9 (RB-ORD-001, RB-FUL-001). Every table here is brand-new -
-- nothing existing is touched, no column is added to any Sprint 1-8
-- table. Checkout/real order creation/payment/pickup codes/Orders UI
-- are out of scope this sprint (Sprint 10-11) - nothing here is ever
-- written by any HTTP endpoint yet; see schema.prisma's own section
-- comments for the full scope note.

-- CreateEnum
CREATE TYPE "FulfilmentMethod" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "BranchOrderPaymentMethod" AS ENUM ('ONLINE', 'COD');

-- CreateEnum
CREATE TYPE "BranchOrderStatus" AS ENUM ('PLACED', 'PREPARING', 'SENT', 'DELIVERED', 'PICKED_UP', 'COMPLETED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_orders_customerId_idx" ON "customer_orders"("customerId");

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "branch_orders" (
    "id" TEXT NOT NULL,
    "customerOrderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "deliveryWindowId" TEXT,
    "fulfilmentMethod" "FulfilmentMethod" NOT NULL,
    "paymentMethod" "BranchOrderPaymentMethod" NOT NULL,
    "status" "BranchOrderStatus" NOT NULL DEFAULT 'PLACED',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "deliveryFee" DECIMAL(10,2),
    "total" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_orders_customerOrderId_idx" ON "branch_orders"("customerOrderId");

-- CreateIndex
CREATE INDEX "branch_orders_vendorId_branchId_idx" ON "branch_orders"("vendorId", "branchId");

-- CreateIndex
CREATE INDEX "branch_orders_status_idx" ON "branch_orders"("status");

-- CreateIndex
CREATE INDEX "branch_orders_deliveryWindowId_idx" ON "branch_orders"("deliveryWindowId");

-- CreateIndex (backs branch_order_items' own composite FK below).
CREATE UNIQUE INDEX "branch_orders_vendorId_id_key" ON "branch_orders"("vendorId", "id");

-- Sprint 9 review-discipline CHECK constraints - non-negative money,
-- same defensive-backstop convention this schema already uses
-- elsewhere (e.g. branch_stock.quantity >= 0): the real guarantee is
-- application-level (Sprint 10's checkout will never compute a
-- negative figure), this is the last line of defense against a direct
-- write.
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_subtotal_nonnegative" CHECK ("subtotal" >= 0);
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_total_nonnegative" CHECK ("total" >= 0);
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_deliveryFee_nonnegative" CHECK ("deliveryFee" IS NULL OR "deliveryFee" >= 0);
-- Codex review round 1 on commit e12d77a: the non-negative checks
-- above allow subtotal/deliveryFee/total to individually be
-- well-formed yet mutually inconsistent (e.g. total that doesn't
-- actually add up). This is the real arithmetic invariant - COALESCE
-- treats a NULL (PICKUP) deliveryFee as 0, exactly matching
-- checkout's own future computation.
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_total_matches_subtotal_plus_fee" CHECK ("total" = "subtotal" + COALESCE("deliveryFee", 0));

-- AddForeignKey
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_customerOrderId_fkey" FOREIGN KEY ("customerOrderId") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - tenant-safety, see BranchOrder's own
-- schema.prisma comment).
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "branch_order_items" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchOrderId" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_order_items_branchOrderId_idx" ON "branch_order_items"("branchOrderId");

ALTER TABLE "branch_order_items" ADD CONSTRAINT "branch_order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "branch_order_items" ADD CONSTRAINT "branch_order_items_unitPrice_nonnegative" CHECK ("unitPrice" >= 0);

-- AddForeignKey (composite - against branch_orders' own (vendorId, id)).
ALTER TABLE "branch_order_items" ADD CONSTRAINT "branch_order_items_vendorId_branchOrderId_fkey" FOREIGN KEY ("vendorId", "branchOrderId") REFERENCES "branch_orders"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - against offer_variants' own (vendorId, id)).
ALTER TABLE "branch_order_items" ADD CONSTRAINT "branch_order_items_vendorId_offerVariantId_fkey" FOREIGN KEY ("vendorId", "offerVariantId") REFERENCES "offer_variants"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "delivery_windows" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_windows_vendorId_branchId_dayOfWeek_idx" ON "delivery_windows"("vendorId", "branchId", "dayOfWeek");

-- CreateIndex (backs delivery_window_exceptions' own composite FK below).
CREATE UNIQUE INDEX "delivery_windows_vendorId_id_key" ON "delivery_windows"("vendorId", "id");

-- CreateIndex (backs branch_orders.deliveryWindow's own composite FK
-- below - Postgres requires a unique constraint on exactly the
-- referenced column set, so (vendorId, id) above is not enough on its
-- own for a 3-column FK target).
CREATE UNIQUE INDEX "delivery_windows_vendorId_branchId_id_key" ON "delivery_windows"("vendorId", "branchId", "id");

ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_dayOfWeek_range" CHECK ("dayOfWeek" BETWEEN 0 AND 6);
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_startMinute_range" CHECK ("startMinute" >= 0 AND "startMinute" < 1440);
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_endMinute_range" CHECK ("endMinute" > 0 AND "endMinute" <= 1440);
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_end_after_start" CHECK ("endMinute" > "startMinute");
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_capacity_positive" CHECK ("capacity" > 0);

-- AddForeignKey
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite - tenant-safety, see DeliveryWindow's own
-- schema.prisma comment).
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite, 3-column - Codex review round 1 on commit
-- e12d77a, PDR-024: a BranchOrder's optional deliveryWindowId must be
-- tenant- AND branch-safe, so a branch-A order can never reference a
-- branch-B window even within the same vendor. NULL deliveryWindowId
-- (every row until Sprint 10's checkout sets one) is exempt from this
-- FK check by ordinary Postgres MATCH SIMPLE semantics - only a
-- non-null value is validated.
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_vendorId_branchId_deliveryWindowId_fkey" FOREIGN KEY ("vendorId", "branchId", "deliveryWindowId") REFERENCES "delivery_windows"("vendorId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PDR-024: "non-overlapping" delivery windows, enforced ATOMICALLY at
-- the DB level regardless of application-level races - not
-- representable in Prisma's schema DSL (same already-established
-- pattern this schema uses for every constraint Prisma's DSL can't
-- express). Requires btree_gist for an integer equality/range GiST
-- exclusion constraint. Scoped to (branchId, dayOfWeek): the same
-- branch's own windows on the same weekday can never overlap in
-- [startMinute, endMinute); branchId alone already uniquely identifies
-- one branch (a UUID), so vendorId does not need to be part of the
-- exclusion key for this constraint's own correctness.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_no_overlap"
  EXCLUDE USING gist (
    "branchId" WITH =,
    "dayOfWeek" WITH =,
    int4range("startMinute", "endMinute") WITH &&
  );

-- CreateTable
CREATE TABLE "delivery_window_exceptions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "exceptionDate" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "capacityOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_window_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_window_exceptions_windowId_exceptionDate_key" ON "delivery_window_exceptions"("windowId", "exceptionDate");

ALTER TABLE "delivery_window_exceptions" ADD CONSTRAINT "delivery_window_exceptions_capacityOverride_positive" CHECK ("capacityOverride" IS NULL OR "capacityOverride" > 0);
-- A closed exception never also carries a capacity override - the two
-- are mutually exclusive by construction, not just controller-level
-- validation (defense in depth, same reasoning as every other CHECK in
-- this migration).
ALTER TABLE "delivery_window_exceptions" ADD CONSTRAINT "delivery_window_exceptions_closed_xor_override" CHECK (NOT ("isClosed" AND "capacityOverride" IS NOT NULL));

-- AddForeignKey (composite - against delivery_windows' own (vendorId, id)).
ALTER TABLE "delivery_window_exceptions" ADD CONSTRAINT "delivery_window_exceptions_vendorId_windowId_fkey" FOREIGN KEY ("vendorId", "windowId") REFERENCES "delivery_windows"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
