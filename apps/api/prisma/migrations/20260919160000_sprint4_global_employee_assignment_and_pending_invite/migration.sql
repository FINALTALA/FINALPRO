-- Sprint 4 fix (review round 4): PDR-008 and SRS Part 3 G.0 say a
-- BRANCH_EMPLOYEE is assigned to one branch at a time across *every*
-- active assignment, not one branch per vendor - the prior
-- unique(userId, vendorId) constraint only ever prevented a duplicate
-- row for the *same* vendor, so the same account could become
-- BRANCH_EMPLOYEE at Vendor A and, separately, at Vendor B
-- simultaneously. Two changes close this, both purely additive/
-- tightening (no existing row can violate either: no two VendorUser
-- rows for the same userId with role=BRANCH_EMPLOYEE exist yet, and no
-- two StaffInvite rows for the same phone are PENDING at once, per the
-- prior migration's own per-vendor version of this same index).
--
-- 1. UNIQUE(userId) WHERE role = 'BRANCH_EMPLOYEE' on vendor_users -
--    an account may still be OWNER of any number of vendors (that role
--    is untouched) and always remains a customer regardless; it may
--    only ever be BRANCH_EMPLOYEE of one branch, at one vendor, at a
--    time. Not representable in Prisma's schema DSL (a partial index),
--    documented as a comment on VendorUser in schema.prisma, same
--    already-established pattern as this table's own role/branch
--    CHECK constraint and store_branches' composite-FK-supporting
--    unique index.
--
-- 2. staff_invites' pending-uniqueness partial index moves from
--    (vendorId, phone) to (phone) alone - AuthController.
--    acceptStaffInvite() has no invite_id parameter and no UI to
--    choose between multiple candidates; it always resolves "the"
--    pending invite for a phone via a plain most-recent lookup. Two
--    PENDING invites for the same phone from two *different* vendors
--    would make that resolution genuinely ambiguous, and - combined
--    with fix 1 above - at most one could ever actually be accepted
--    anyway, leaving the other permanently dangling exactly like the
--    bug this whole line of fixes started from. Replaces (does not
--    just add to) the prior per-vendor partial index.

-- DropIndex
DROP INDEX "staff_invites_vendor_phone_pending_key";

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_phone_pending_key" ON "staff_invites"("phone") WHERE "status" = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_employee_userId_key" ON "vendor_users"("userId") WHERE "role" = 'BRANCH_EMPLOYEE';
