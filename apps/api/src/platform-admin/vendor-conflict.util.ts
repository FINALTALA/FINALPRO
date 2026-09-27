import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * Sprint 16 (D4): a platform reviewer/admin may never decide
 * verification for, suspend, or reactivate a store they are a
 * VendorUser (owner or employee) of. MUST be called inside the
 * transaction, immediately AFTER `SELECT ... FROM vendors ... FOR
 * UPDATE` on that vendor: the only two code paths that create a
 * VendorUser (apply() for a brand-new vendor, and acceptStaffInvite())
 * are ordered against every moderation path by that same vendor-row
 * lock, so a membership committed before this check is always seen,
 * and one that commits later is by definition after the decision.
 */
export async function assertNoPlatformVendorConflict(
  tx: Prisma.TransactionClient,
  userId: string,
  vendorId: string,
): Promise<void> {
  const membership = await tx.vendorUser.findFirst({
    where: { userId, vendorId },
    select: { id: true },
  });
  if (membership) {
    throw new ForbiddenException({
      code: 'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
      message:
        'You are a member of this store, so you cannot make a moderation decision about it',
    });
  }
}
