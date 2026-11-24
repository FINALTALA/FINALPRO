-- «إدارة طلبات الفرع v2» phase 2 (2026-11-24): preparation start, the saved
-- prep checklist, «جاهز» and two customer notifications. Additive only - no
-- existing row is rewritten, no existing value changes meaning, NO backfill:
-- every order placed or started before this migration keeps the new columns
-- null (and so keeps the old path - it is never held back by «جاهز»).
--
--  * branch_orders: preparationStartedAt/ById/ByRole (set by start-preparation
--    from now on), readyAt/ById/ByRole («جاهز» is a sub-state of PREPARING,
--    not a new status), completedAt (every path to COMPLETED). The roles are
--    the actor's store role at that moment.
--  * branch_order_prep_checks: one row per completed checklist item (closed
--    keys), who / when / role; same-vendor composite FK to branch_orders.
--  * NotificationType: READY_FOR_PICKUP, ORDER_SENT (both to the customer).

-- AlterEnum (the new values are not used by this migration itself)
ALTER TYPE "NotificationType" ADD VALUE 'READY_FOR_PICKUP';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_SENT';

-- AlterTable
ALTER TABLE "branch_orders" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "preparationStartedAt" TIMESTAMP(3),
ADD COLUMN     "preparationStartedById" TEXT,
ADD COLUMN     "preparationStartedByRole" TEXT,
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "readyById" TEXT,
ADD COLUMN     "readyByRole" TEXT;

-- who and when come together; a role is one of the store roles
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_preparation_started_check"
  CHECK (("preparationStartedById" IS NULL OR "preparationStartedAt" IS NOT NULL)
     AND ("preparationStartedByRole" IS NULL OR "preparationStartedByRole" IN ('OWNER', 'BRANCH_EMPLOYEE')));
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_ready_check"
  CHECK (("readyById" IS NULL OR "readyAt" IS NOT NULL)
     AND ("readyByRole" IS NULL OR "readyByRole" IN ('OWNER', 'BRANCH_EMPLOYEE')));

-- CreateTable
CREATE TABLE "branch_order_prep_checks" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "branchOrderId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneById" TEXT NOT NULL,
    "doneByRole" TEXT NOT NULL,

    CONSTRAINT "branch_order_prep_checks_pkey" PRIMARY KEY ("id")
);

-- the closed checklist and the store roles
ALTER TABLE "branch_order_prep_checks" ADD CONSTRAINT "branch_order_prep_checks_itemKey_check"
  CHECK ("itemKey" IN ('ITEMS_VERIFIED', 'PACKED', 'INVOICE_ATTACHED'));
ALTER TABLE "branch_order_prep_checks" ADD CONSTRAINT "branch_order_prep_checks_doneByRole_check"
  CHECK ("doneByRole" IN ('OWNER', 'BRANCH_EMPLOYEE'));

-- CreateIndex
CREATE UNIQUE INDEX "branch_order_prep_checks_branchOrderId_itemKey_key" ON "branch_order_prep_checks"("branchOrderId", "itemKey");

-- AddForeignKey
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_preparationStartedById_fkey" FOREIGN KEY ("preparationStartedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_orders" ADD CONSTRAINT "branch_orders_readyById_fkey" FOREIGN KEY ("readyById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_order_prep_checks" ADD CONSTRAINT "branch_order_prep_checks_vendorId_branchOrderId_fkey" FOREIGN KEY ("vendorId", "branchOrderId") REFERENCES "branch_orders"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_order_prep_checks" ADD CONSTRAINT "branch_order_prep_checks_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
