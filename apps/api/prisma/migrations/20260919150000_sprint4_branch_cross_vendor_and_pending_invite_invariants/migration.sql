-- Sprint 4 fix (review round 2): closes two data-integrity gaps Codex
-- found in the already-committed 20260919140000 migration.
--
-- 1. VendorUser/StaffInvite's branchId FK only proved the referenced
--    store_branches row existed *somewhere* - nothing stopped a direct
--    write from linking an employee, or an invite, to a branch
--    belonging to a *different* vendor than that same row's own
--    vendorId claims. Both single-column FKs are replaced with
--    composite ones: (vendorId, branchId) -> store_branches(vendorId,
--    id). This needs store_branches(vendorId, id) to itself be unique
--    first - a plain PK-only unique on id already exists, but a
--    composite FK's target must be unique on the *exact* column pair
--    it references, added below.
--
--    onDelete changes from SET NULL (vendor_users' original FK) to
--    RESTRICT on both composite FKs: a composite FK cannot honour
--    SET NULL when one of its two columns (vendorId) is itself
--    NOT NULL - Postgres would only discover that at the moment a
--    delete actually cascaded into it, a landmine rather than a
--    deliberate policy. RESTRICT is also the correct business rule
--    regardless (PDR-010: a branch is never hard-deleted; nothing in
--    this codebase deletes a StoreBranch today, so this never fires in
--    practice - it exists to fail loudly rather than corrupt data if
--    that ever changes).
--
-- 2. Nothing stopped an owner creating two PENDING StaffInvite rows for
--    the same phone in the same vendor to two different branches -
--    acceptance would then be ambiguous about which branch wins.
--    Added a partial unique index: at most one PENDING invite per
--    (vendorId, phone). ACCEPTED rows are deliberately excluded from
--    it (PDR-010's "retain the old record, correctable new application
--    stays possible" reasoning applies the same way here - a
--    previously-accepted invite must never block a *later*, separate
--    invite to the same vendor/phone from being created and audited;
--    this index only ever blocks a second *simultaneously pending*
--    one). Prisma's schema DSL cannot express a partial index - it is
--    documented on StaffInvite in schema.prisma but only actually
--    created here, the same already-established pattern as
--    VendorUser's role/branch CHECK constraint from the prior
--    migration.
--
-- Both changes are purely additive/tightening: no currently-committed
-- row can violate either (every VendorUser/StaffInvite row created so
-- far by this codebase's own application code already has a
-- consistent vendorId/branchId pair, and at most one PENDING invite
-- has ever existed per vendor/phone in test data) - verified directly
-- against Postgres with a scratch-row test for each before this file
-- was written, and by dedicated e2e tests added alongside this
-- migration.

-- CreateIndex
CREATE UNIQUE INDEX "store_branches_vendorId_id_key" ON "store_branches"("vendorId", "id");

-- DropForeignKey (replaced below by the composite version)
ALTER TABLE "vendor_users" DROP CONSTRAINT "vendor_users_branchId_fkey";

-- AddForeignKey
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropForeignKey (replaced below by the composite version)
ALTER TABLE "staff_invites" DROP CONSTRAINT "staff_invites_branchId_fkey";

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_vendorId_branchId_fkey" FOREIGN KEY ("vendorId", "branchId") REFERENCES "store_branches"("vendorId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (partial - not representable in schema.prisma, see its comment on StaffInvite)
CREATE UNIQUE INDEX "staff_invites_vendor_phone_pending_key" ON "staff_invites"("vendorId", "phone") WHERE "status" = 'PENDING';
