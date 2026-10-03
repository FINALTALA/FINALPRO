-- Sprint 19: notification relay, Outbox claim/lease state machine,
-- bounded follower fan-out, and the scheduled-discount activation
-- dedup key. See each table/column's own schema.prisma comment for
-- the full design rationale.

-- ============================================================
-- 1. OutboxEvent: claim/lease columns (PROCESSING/DEAD_LETTER enum
--    values added by the preceding 20261003090000 migration - see its
--    own comment for why that had to be a separate migration file)
-- ============================================================
ALTER TABLE "outbox_events"
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "lastError" TEXT;

DROP INDEX "outbox_events_status_createdAt_idx";
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- ============================================================
-- 2. VendorOffer: first-publish marker (FR-FAV-005 E.0 new-product trigger)
-- ============================================================
ALTER TABLE "vendor_offers" ADD COLUMN "firstPublishedAt" TIMESTAMP(3);

-- ============================================================
-- 3. Notification
-- ============================================================
CREATE TYPE "NotificationType" AS ENUM (
  'STOCK_ADJUSTMENT',
  'DELIVERY_CONFIRM_REQUESTED',
  'NOT_RECEIVED_REPORTED',
  'ORDER_AUTO_CONFIRMED',
  'DELIVERY_CONFIRM_REMINDER',
  'VENDOR_SUSPENDED',
  'VENDOR_REACTIVATED',
  'NEW_ORDER_FOR_EMPLOYEE',
  'LOW_STOCK_AFTER_RESERVE',
  'FOLLOWED_STORE_NEW_PRODUCT',
  'FOLLOWED_STORE_DISCOUNT'
);

CREATE TYPE "NotificationTargetType" AS ENUM ('BRANCH_ORDER', 'STOCK', 'VENDOR', 'OFFER');

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "data" JSONB NOT NULL,
    "targetType" "NotificationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "vendorId" TEXT,
    "branchId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_outboxEventId_recipientUserId_key" ON "notifications"("outboxEventId", "recipientUserId");
CREATE INDEX "notifications_recipientUserId_readAt_createdAt_idx" ON "notifications"("recipientUserId", "readAt", "createdAt");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 4. OutboxDeliveryTarget - bounded follower fan-out snapshot
-- ============================================================
CREATE TABLE "outbox_delivery_targets" (
    "id" TEXT NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_delivery_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_delivery_targets_outboxEventId_recipientUserId_key" ON "outbox_delivery_targets"("outboxEventId", "recipientUserId");
CREATE INDEX "outbox_delivery_targets_outboxEventId_processedAt_idx" ON "outbox_delivery_targets"("outboxEventId", "processedAt");

ALTER TABLE "outbox_delivery_targets" ADD CONSTRAINT "outbox_delivery_targets_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 5. DiscountActivationNotice - durable dedup key for the scheduled-
--    discount sweep (the unique constraint IS the lock)
-- ============================================================
CREATE TABLE "discount_activation_notices" (
    "id" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "discountStartAt" TIMESTAMP(3) NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_activation_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discount_activation_notices_offerVariantId_discountStartAt_key" ON "discount_activation_notices"("offerVariantId", "discountStartAt");

-- ============================================================
-- 6. Legacy data migration: every still-PENDING/FAILED row for the
--    three event types whose enqueue call sites did NOT yet snapshot a
--    recipient (stock_movement.owner_notification, vendor.suspended,
--    vendor.reactivated - fixed in this same sprint's application
--    code) predates the recipient-snapshot guarantee. Resolving their
--    recipient now, at relay time, would mean using the CURRENT owner
--    set instead of the set that existed when the event actually
--    happened - exactly the snapshot-not-lookup violation this
--    project explicitly rejected. Distinguished by payload shape, not
--    eventType alone (both old and new rows share the same eventType
--    string): a row written by the fixed code always carries
--    recipient_user_id; a legacy row never does. Never touches
--    PUBLISHED/PROCESSING/DEAD_LETTER rows (none can exist yet - no
--    relay has ever run before this sprint - but excluded explicitly
--    for safety in case this migration is ever replayed against a
--    database this invariant no longer holds for).
-- ============================================================
UPDATE "outbox_events"
SET "status" = 'DEAD_LETTER', "lastError" = 'LEGACY_MISSING_RECIPIENT_SNAPSHOT'
WHERE "eventType" IN ('stock_movement.owner_notification', 'vendor.suspended', 'vendor.reactivated')
  AND "status" IN ('PENDING', 'FAILED')
  AND "payload"->>'recipient_user_id' IS NULL;
