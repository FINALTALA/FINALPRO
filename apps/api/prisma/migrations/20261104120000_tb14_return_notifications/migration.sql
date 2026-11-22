-- TB-14: notifications for the returns lifecycle - ten NotificationType
-- values and the RETURN target type. Additive only - no existing value,
-- row or column changes. Runs after
-- 20261103120000_tb12_platform_alert_recipients.

-- Postgres allows ADD VALUE inside the migration's transaction as long
-- as the new value is not used in that same transaction (it is not).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_VENDOR_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_ADMIN_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_ESCALATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_REFUNDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_EXCHANGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_CODE_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RETURN_ESCALATION_ALERT';

ALTER TYPE "NotificationTargetType" ADD VALUE IF NOT EXISTS 'RETURN';
