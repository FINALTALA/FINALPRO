-- Sprint 20a (review-round requirement): at most one DELIVERY_FEE
-- refund row per BranchOrder. branchOrderItemId's own uniqueness
-- doesn't help here - every DELIVERY_FEE row has branchOrderItemId =
-- NULL, and standard Postgres unique-index semantics allow unlimited
-- NULLs. A real, scoped (branchOrderId, reason) partial unique index
-- is the only way to express this - not representable in Prisma's
-- schema DSL (same established pattern as BranchOrder.pickupCode's
-- own partial unique index).
CREATE UNIQUE INDEX "branch_order_refunds_delivery_fee_unique"
  ON "branch_order_refunds" ("branchOrderId")
  WHERE "reason" = 'DELIVERY_FEE';
