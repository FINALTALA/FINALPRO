import { Prisma } from '../../generated/prisma/client';

/**
 * Sprint 18b: the one shared Postgres advisory lock serializing every
 * writer that depends on a branch's own operational status
 * (verificationStatus, archivedAt, or an active BranchClosure) against
 * every OTHER such writer for the exact same (vendorId, branchId) -
 * closing the TOCTOU race a plain read-then-decide would leave open
 * (e.g. reserve() reading a branch as open a moment before a
 * concurrent archive() commits, then creating the reservation anyway).
 *
 * Taken by: checkout.service.ts's reserve() (once per distinct branch
 * in the checkout, sorted ascending by branchId - a fixed order,
 * never per-caller-chosen, so two concurrent multi-branch checkouts
 * can never deadlock against each other), branches.controller.ts's
 * archive(), branch-closures.controller.ts's create(), vendors-
 * controller.ts's inviteStaff() and the staff transfer endpoint (on
 * the target branch), auth.controller.ts's acceptStaffInvite(), and
 * vendor-verification.controller.ts's submitEvidence()/decide() (see
 * each call site's own comment for why those two specifically need
 * this real lock rather than relying on BranchArchivedGuard alone).
 *
 * Global fixed lock order this project now follows everywhere more
 * than one of these locks is taken together (documented once here,
 * not re-derived per call site):
 *   1) phone advisory lock (pre-existing, inviteStaff/acceptStaffInvite only)
 *   2) THIS branch-operational-status advisory lock
 *   3) vendor row `SELECT ... FOR UPDATE` (pre-existing)
 *   4) a specific VendorUser row `SELECT ... FOR UPDATE` (transfer/suspend/reactivate only)
 * A lock a given operation doesn't need is simply skipped - omitting
 * an earlier or later step in a fixed chain is always deadlock-safe;
 * only a REVERSED relative order between two steps both present would
 * risk one, and nothing in this codebase does that.
 *
 * $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns void,
 * which $queryRaw can't deserialize (see categories.controller.ts for
 * the same long-established note).
 */
export async function lockBranchOperationalStatus(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_operational_status:' || ${vendorId} || ':' || ${branchId}))`;
}

/**
 * Whether a BranchClosure covering `at` exists for this branch right
 * now - the half-open `[startsAt, endsAt)` interpreted literally, not
 * BETWEEN, so a closure ending exactly at `at` no longer covers it.
 * Callers that need the real serialized guarantee must call this only
 * after lockBranchOperationalStatus() on the same (vendorId, branchId)
 * inside the same transaction.
 */
export async function hasActiveBranchClosure(
  tx: Prisma.TransactionClient,
  branchId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const closure = await tx.branchClosure.findFirst({
    where: { branchId, startsAt: { lte: at }, endsAt: { gt: at } },
    select: { id: true },
  });
  return closure !== null;
}
