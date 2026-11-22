-- TB-15: store notifications for the platform's final decision on an
-- escalated return and for a customer's cancellation - three
-- NotificationType values. Additive only - no existing value, row or
-- column changes. Runs after 20261104120000_tb14_return_notifications.
--
-- Postgres cannot drop an enum value, and an older build's Prisma client
-- cannot read a notification row of a type it does not know. So once a
-- row of one of these types exists, going back to an older build is NOT
-- safe on its own: the real rollback is the database backup taken before
-- this migration together with the previous build. Switching the
-- return_store_notifications_enabled flag off only stops new events.

-- Postgres allows ADD VALUE inside the migration's transaction as long
-- as the new value is not used in that same transaction (it is not).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_PLATFORM_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_PLATFORM_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_CANCELLED_BY_CUSTOMER';
