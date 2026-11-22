-- PD-5.1: per-branch preparation time before a delivery window.
-- Additive: every existing branch gets 0 (no preparation time), so the
-- only behaviour change for existing data is the code-side rule that a
-- window which has already started is no longer offered or bookable.
ALTER TABLE "store_branches"
  ADD COLUMN "deliveryLeadMinutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "store_branches"
  ADD CONSTRAINT "store_branches_delivery_lead_minutes_range"
  CHECK ("deliveryLeadMinutes" BETWEEN 0 AND 2880);
