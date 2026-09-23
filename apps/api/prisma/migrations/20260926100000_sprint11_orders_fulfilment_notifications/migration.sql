-- Sprint 11 (RB-FUL-002, PDR-026): additive-only columns driving the
-- Sent -> Delivered -> customer-confirm loop's lazy reconciliation
-- (48h reminder, 72h auto-confirm) and the "not received" report. All
-- four are nullable, so every pre-existing branch_orders row (Sprints
-- 9-10 data) is unaffected.
ALTER TABLE "branch_orders" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "branch_orders" ADD COLUMN "confirmReminderSentAt" TIMESTAMP(3);
ALTER TABLE "branch_orders" ADD COLUMN "notReceivedReportedAt" TIMESTAMP(3);
ALTER TABLE "branch_orders" ADD COLUMN "notReceivedReason" TEXT;
