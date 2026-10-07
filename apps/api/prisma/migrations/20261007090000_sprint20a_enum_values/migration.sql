-- Sprint 20a: new enum TYPES first (brand new, no restriction), then
-- the ADD VALUE statements for the two EXISTING enums, isolated into
-- this own migration file - same established pattern as Sprint 19's
-- own enum-value migrations (Postgres cannot use a newly-added enum
-- value in the same transaction that adds it, so nothing in a LATER
-- migration file may reference these new values in a raw multi-
-- statement batch run against the same connection as this file).

-- CreateEnum
CREATE TYPE "BranchOrderRefundReason" AS ENUM ('SLOT_MISSED', 'DELIVERY_FAILURE_TIMEOUT', 'DELIVERY_FAILED_TWICE', 'ITEM_CANCELLED', 'DELIVERY_FEE', 'PLATFORM_ADMIN_MANUAL');

-- CreateEnum
CREATE TYPE "BranchOrderRefundInitiator" AS ENUM ('SYSTEM', 'CUSTOMER_REQUEST', 'STAFF', 'PLATFORM_ADMIN');

-- AlterEnum
ALTER TYPE "BranchOrderStatus" ADD VALUE 'DELIVERY_FAILED';
ALTER TYPE "BranchOrderStatus" ADD VALUE 'REFUND_REQUESTED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PREP_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'SLOT_MISSED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_RESCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_AUTOMATIC';
