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
--
-- Preflight (review round 5): a database that already ran the prior
-- migration could hold rows that were valid under its narrower,
-- per-vendor constraints but violate the global ones this migration
-- introduces - the same userId as BRANCH_EMPLOYEE at more than one
-- vendor, or the same phone with more than one PENDING StaffInvite
-- across different vendors. Without a check, CREATE UNIQUE INDEX below
-- would simply fail once it reached the first offending row, after
-- DROP INDEX above had already removed the old constraint, leaving the
-- migration half-applied on retry. A real employee assignment or a
-- real pending invite is a business fact, not something a migration
-- gets to silently delete, expire, or pick a "winner" for - so this
-- refuses to proceed at all when a conflict exists, names the
-- offending id, and leaves the whole migration (DO block included) to
-- roll back atomically inside Prisma's per-migration transaction. A
-- human resolves the conflict manually, then re-runs `prisma migrate
-- deploy`.
DO $$
DECLARE
  conflicting_employee record;
  conflicting_phone record;
BEGIN
  SELECT "userId" INTO conflicting_employee
  FROM "vendor_users"
  WHERE "role" = 'BRANCH_EMPLOYEE'
  GROUP BY "userId"
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Migration 20260919160000 preflight failed: user "%" already has more than one BRANCH_EMPLOYEE vendor_users row (at different vendors). This migration adds UNIQUE(userId) WHERE role=''BRANCH_EMPLOYEE'', which that data violates. Resolve manually (decide which assignment is correct and remove/reassign the other VendorUser row(s) for this user) before re-running this migration. No automatic cleanup was performed.', conflicting_employee."userId";
  END IF;

  SELECT "phone" INTO conflicting_phone
  FROM "staff_invites"
  WHERE "status" = 'PENDING'
  GROUP BY "phone"
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Migration 20260919160000 preflight failed: phone "%" already has more than one PENDING staff_invites row (at different vendors). This migration adds UNIQUE(phone) WHERE status=''PENDING'', which that data violates. Resolve manually (decide which invite is correct and cancel/expire the other StaffInvite row(s) for this phone) before re-running this migration. No automatic cleanup was performed.', conflicting_phone."phone";
  END IF;
END $$;

-- DropIndex
DROP INDEX "staff_invites_vendor_phone_pending_key";

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_phone_pending_key" ON "staff_invites"("phone") WHERE "status" = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_employee_userId_key" ON "vendor_users"("userId") WHERE "role" = 'BRANCH_EMPLOYEE';
