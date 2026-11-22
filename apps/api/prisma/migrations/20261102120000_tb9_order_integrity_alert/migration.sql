-- TB-9: the platform administrators' one-time alert for a branch order
-- found in a state the order state machine never produces. Additive
-- only - no existing value, row or column changes. Runs after
-- 20261028180000_pd5b_platform_collections.

-- Postgres allows ADD VALUE inside the migration's transaction as long
-- as the new value is not used in that same transaction (it is not).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_INTEGRITY_ALERT';
