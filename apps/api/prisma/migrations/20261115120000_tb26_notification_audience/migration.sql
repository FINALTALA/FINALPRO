-- TB-26: every notification belongs to exactly one context - the shopping
-- bell (CUSTOMER), a store workspace (STORE) or the platform workspace
-- (PLATFORM). Runs after 20261112120000_tb15_return_store_notifications.
--
-- Existing rows are classified here ONCE, deterministically:
--  - every type except ORDER_CANCELLED has a single audience (the table
--    below is the senders' own audience in the code at TB-26);
--  - ORDER_CANCELLED goes to the customer when the store, the platform or
--    the sweep cancels, and to the branch team when the customer cancels.
--    A row is CUSTOMER when its recipient is the order's customer and has
--    never been a member of the order's store; STORE when its recipient is
--    a member of that store and is not the order's customer. Anything else
--    (the customer is also a member of the store - a self-purchase - or
--    the order cannot be found) is AMBIGUOUS and is NOT guessed.
--
-- Guard: if any row is left unclassified, or a STORE row lacks the store
-- (vendorId) or - for a branch-level type - the branch (branchId), the
-- migration RAISEs and nothing in it is applied (Prisma runs the whole
-- file as one transaction; TB-26 proves this with a deliberate failure).
--
-- After this migration the column is NOT NULL, so an older build (which
-- does not write it) can no longer create notifications: dropping the
-- column and the type is NOT a practical rollback once this build has
-- run. A deployment needs a database backup taken right before it and an
-- explicit compatibility/rollback plan.

CREATE TYPE "NotificationAudience" AS ENUM ('CUSTOMER', 'STORE', 'PLATFORM');

ALTER TABLE "notifications" ADD COLUMN "audience" "NotificationAudience";

UPDATE "notifications" SET "audience" = (CASE "type"::text
  WHEN 'DELIVERY_CONFIRM_REQUESTED'   THEN 'CUSTOMER'
  WHEN 'ORDER_AUTO_CONFIRMED'         THEN 'CUSTOMER'
  WHEN 'DELIVERY_CONFIRM_REMINDER'    THEN 'CUSTOMER'
  WHEN 'DELIVERY_FAILED'              THEN 'CUSTOMER'
  WHEN 'REFUND_APPROVED'              THEN 'CUSTOMER'
  WHEN 'REFUND_AUTOMATIC'             THEN 'CUSTOMER'
  WHEN 'SLOT_MISSED'                  THEN 'CUSTOMER'
  WHEN 'REVIEW_INVITATION'            THEN 'CUSTOMER'
  WHEN 'REVIEW_HIDDEN'                THEN 'CUSTOMER'
  WHEN 'FOLLOWED_STORE_NEW_PRODUCT'   THEN 'CUSTOMER'
  WHEN 'FOLLOWED_STORE_DISCOUNT'      THEN 'CUSTOMER'
  WHEN 'FAVORITE_PRICE_DROP'          THEN 'CUSTOMER'
  WHEN 'FAVORITE_BACK_IN_STOCK'       THEN 'CUSTOMER'
  WHEN 'FAVORITE_NEW_OFFER'           THEN 'CUSTOMER'
  WHEN 'RETURN_APPROVED'              THEN 'CUSTOMER'
  WHEN 'RETURN_REJECTED'              THEN 'CUSTOMER'
  WHEN 'RETURN_ADMIN_REJECTED'        THEN 'CUSTOMER'
  WHEN 'RETURN_ESCALATED'             THEN 'CUSTOMER'
  WHEN 'RETURN_REFUNDED'              THEN 'CUSTOMER'
  WHEN 'RETURN_EXCHANGED'             THEN 'CUSTOMER'
  WHEN 'RETURN_CODE_EXPIRED'          THEN 'CUSTOMER'
  WHEN 'STOCK_ADJUSTMENT'             THEN 'STORE'
  WHEN 'NOT_RECEIVED_REPORTED'        THEN 'STORE'
  WHEN 'VENDOR_SUSPENDED'             THEN 'STORE'
  WHEN 'VENDOR_REACTIVATED'           THEN 'STORE'
  WHEN 'NEW_ORDER_FOR_EMPLOYEE'       THEN 'STORE'
  WHEN 'LOW_STOCK_AFTER_RESERVE'      THEN 'STORE'
  WHEN 'ORDER_RESCHEDULED'            THEN 'STORE'
  WHEN 'REFUND_REQUESTED'             THEN 'STORE'
  WHEN 'PREP_REMINDER'                THEN 'STORE'
  WHEN 'RETURN_REQUESTED'             THEN 'STORE'
  WHEN 'RETURN_VENDOR_REMINDER'       THEN 'STORE'
  WHEN 'RETURN_PLATFORM_APPROVED'     THEN 'STORE'
  WHEN 'RETURN_PLATFORM_REJECTED'     THEN 'STORE'
  WHEN 'RETURN_CANCELLED_BY_CUSTOMER' THEN 'STORE'
  WHEN 'ORDER_INTEGRITY_ALERT'        THEN 'PLATFORM'
  WHEN 'RETURN_ESCALATION_ALERT'      THEN 'PLATFORM'
END)::"NotificationAudience"
WHERE "type"::text <> 'ORDER_CANCELLED';

-- ORDER_CANCELLED, row by row. Memberships are never deleted (only
-- suspended), so "has ever been a member" is a vendor_users row of any
-- status.
UPDATE "notifications" n SET "audience" = c.audience::"NotificationAudience"
FROM (
  SELECT n2.id,
    CASE
      WHEN cp."userId" = n2."recipientUserId" AND NOT EXISTS (
        SELECT 1 FROM "vendor_users" vu
        WHERE vu."userId" = n2."recipientUserId" AND vu."vendorId" = bo."vendorId"
      ) THEN 'CUSTOMER'
      WHEN cp."userId" <> n2."recipientUserId" AND EXISTS (
        SELECT 1 FROM "vendor_users" vu
        WHERE vu."userId" = n2."recipientUserId" AND vu."vendorId" = bo."vendorId"
      ) THEN 'STORE'
    END AS audience
  FROM "notifications" n2
  JOIN "branch_orders" bo ON bo.id = n2."targetId"
  JOIN "customer_orders" co ON co.id = bo."customerOrderId"
  JOIN "customer_profiles" cp ON cp.id = co."customerId"
  WHERE n2."type"::text = 'ORDER_CANCELLED' AND n2."targetType"::text = 'BRANCH_ORDER'
) c
WHERE n.id = c.id AND c.audience IS NOT NULL;

-- Events not yet sent (PENDING / FAILED / PROCESSING) were written by
-- the previous build without an audience, and this build's relay refuses
-- an event without one. They get the audience of their event type here
-- (branch_order.cancelled row by row, same rule as above); a sent or
-- dead-lettered event is history and is left as it is. An event type the
-- relay does not know stays unchanged (it fails as unknown either way).
UPDATE "outbox_events" SET "payload" = "payload" || jsonb_build_object('audience', CASE
  WHEN "eventType" IN (
    'branch_order.delivered_confirm_requested',
    'branch_order.confirm_rerequested',
    'branch_order.auto_confirmed_72h',
    'branch_order.confirm_reminder_48h',
    'branch_order.delivery_failed',
    'branch_order.refund_approved',
    'branch_order.refund_automatic',
    'branch_order.slot_missed',
    'branch_order.review_invitation',
    'review.hidden_product',
    'review.hidden_store',
    'return.approved',
    'return.rejected',
    'return.admin_rejected',
    'return.escalated',
    'return.refunded',
    'return.exchanged',
    'return.code_expired',
    'offer.published_for_followers',
    'offer.discount_activated_for_followers',
    'favorite.price_dropped',
    'favorite.back_in_stock',
    'favorite.new_offer_matched') THEN 'CUSTOMER'
  WHEN "eventType" IN (
    'stock_movement.owner_notification',
    'branch_order.not_received_reported',
    'vendor.suspended',
    'vendor.reactivated',
    'branch_order.new_order_for_employee',
    'checkout.low_stock_after_reserve',
    'branch_order.rescheduled',
    'branch_order.refund_requested',
    'branch_order.prep_reminder',
    'return.requested',
    'return.vendor_reminder',
    'return.platform_approved_for_store',
    'return.platform_rejected_for_store',
    'return.cancelled_for_store') THEN 'STORE'
  WHEN "eventType" IN (
    'branch_order.integrity_flagged',
    'return.escalation_alert') THEN 'PLATFORM'
END)
WHERE "status" IN ('PENDING', 'FAILED', 'PROCESSING')
  AND NOT ("payload" ? 'audience')
  AND "eventType" IN (
    'branch_order.delivered_confirm_requested',
    'branch_order.confirm_rerequested',
    'branch_order.auto_confirmed_72h',
    'branch_order.confirm_reminder_48h',
    'branch_order.delivery_failed',
    'branch_order.refund_approved',
    'branch_order.refund_automatic',
    'branch_order.slot_missed',
    'branch_order.review_invitation',
    'review.hidden_product',
    'review.hidden_store',
    'return.approved',
    'return.rejected',
    'return.admin_rejected',
    'return.escalated',
    'return.refunded',
    'return.exchanged',
    'return.code_expired',
    'offer.published_for_followers',
    'offer.discount_activated_for_followers',
    'favorite.price_dropped',
    'favorite.back_in_stock',
    'favorite.new_offer_matched',
    'stock_movement.owner_notification',
    'branch_order.not_received_reported',
    'vendor.suspended',
    'vendor.reactivated',
    'branch_order.new_order_for_employee',
    'checkout.low_stock_after_reserve',
    'branch_order.rescheduled',
    'branch_order.refund_requested',
    'branch_order.prep_reminder',
    'return.requested',
    'return.vendor_reminder',
    'return.platform_approved_for_store',
    'return.platform_rejected_for_store',
    'return.cancelled_for_store',
    'branch_order.integrity_flagged',
    'return.escalation_alert');

UPDATE "outbox_events" e SET "payload" = e."payload" || jsonb_build_object('audience', c.audience)
FROM (
  SELECT e2.id,
    CASE
      WHEN cp."userId" = e2."payload"->>'recipient_user_id' AND NOT EXISTS (
        SELECT 1 FROM "vendor_users" vu
        WHERE vu."userId" = e2."payload"->>'recipient_user_id' AND vu."vendorId" = bo."vendorId"
      ) THEN 'CUSTOMER'
      WHEN cp."userId" <> e2."payload"->>'recipient_user_id' AND EXISTS (
        SELECT 1 FROM "vendor_users" vu
        WHERE vu."userId" = e2."payload"->>'recipient_user_id' AND vu."vendorId" = bo."vendorId"
      ) THEN 'STORE'
    END AS audience
  FROM "outbox_events" e2
  JOIN "branch_orders" bo ON bo.id = e2."payload"->>'branch_order_id'
  JOIN "customer_orders" co ON co.id = bo."customerOrderId"
  JOIN "customer_profiles" cp ON cp.id = co."customerId"
  WHERE e2."eventType" = 'branch_order.cancelled'
    AND e2."status" IN ('PENDING', 'FAILED', 'PROCESSING')
    AND NOT (e2."payload" ? 'audience')
) c
WHERE e.id = c.id AND c.audience IS NOT NULL;

DO $$
DECLARE
  ambiguous integer;
  unclassified integer;
  store_without_vendor integer;
  branch_type_without_branch integer;
  ambiguous_pending integer;
BEGIN
  SELECT count(*) INTO ambiguous FROM "notifications"
    WHERE "audience" IS NULL AND "type"::text = 'ORDER_CANCELLED';
  SELECT count(*) INTO unclassified FROM "notifications"
    WHERE "audience" IS NULL AND "type"::text <> 'ORDER_CANCELLED';
  SELECT count(*) INTO store_without_vendor FROM "notifications"
    WHERE "audience" = 'STORE' AND "vendorId" IS NULL;
  SELECT count(*) INTO branch_type_without_branch FROM "notifications"
    WHERE "audience" = 'STORE' AND "branchId" IS NULL
      AND "type"::text NOT IN ('VENDOR_SUSPENDED', 'VENDOR_REACTIVATED');
  SELECT count(*) INTO ambiguous_pending FROM "outbox_events"
    WHERE "eventType" = 'branch_order.cancelled'
      AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')
      AND NOT ("payload" ? 'audience');
  IF ambiguous > 0 OR unclassified > 0 OR store_without_vendor > 0
     OR branch_type_without_branch > 0 OR ambiguous_pending > 0 THEN
    RAISE EXCEPTION 'TB-26 notification audience: % ambiguous ORDER_CANCELLED row(s), % unclassified row(s), % STORE row(s) without vendorId, % branch-level STORE row(s) without branchId, % unsent branch_order.cancelled event(s) without a clear audience - nothing was changed; classify them explicitly first',
      ambiguous, unclassified, store_without_vendor, branch_type_without_branch, ambiguous_pending;
  END IF;
END $$;

ALTER TABLE "notifications" ALTER COLUMN "audience" SET NOT NULL;

-- A store notification always names its store; a branch-level one also
-- names its branch. Store-wide types (the store suspended/reactivated)
-- may leave branchId empty.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_store_vendor_check"
  CHECK ("audience" <> 'STORE' OR "vendorId" IS NOT NULL);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_store_branch_check"
  CHECK ("audience" <> 'STORE' OR "branchId" IS NOT NULL
         OR "type" IN ('VENDOR_SUSPENDED', 'VENDOR_REACTIVATED'));

CREATE INDEX "notifications_recipientUserId_audience_readAt_createdAt_idx"
  ON "notifications"("recipientUserId", "audience", "readAt", "createdAt");
