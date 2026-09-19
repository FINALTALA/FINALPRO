import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '../../generated/prisma/client';

const SANDBOX_PERIOD_DAYS = 30;

/**
 * Sprint 3 remediation (PDR-033): the unified one-month sandbox/trial
 * subscription's lazy expiry check, shared by every place that needs to
 * know whether a vendor's trial is actually still current -
 * `SubscriptionsController` (reading/renewing it directly) and
 * `VendorOffersController` (gating new-listing creation on it, BR-014).
 *
 * "Lazy" because this codebase has no scheduled-job worker to expire a
 * trial the instant its `periodEnd` passes - the transition happens the
 * next time anything actually checks, inside that caller's own
 * transaction. This is a one-way, idempotent write (ACTIVE -> EXPIRED
 * only, never the reverse - see `renew()` on SubscriptionsController for
 * the only path back to ACTIVE), so calling it redundantly across
 * multiple request paths is always safe.
 */
@Injectable()
export class SubscriptionGateService {
  static readonly SANDBOX_PERIOD_DAYS = SANDBOX_PERIOD_DAYS;

  async refreshStatus(
    tx: Prisma.TransactionClient,
    vendorId: string,
  ): Promise<SubscriptionStatus> {
    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    if (vendor.subscriptionStatus !== 'ACTIVE') {
      return vendor.subscriptionStatus;
    }

    const current = await tx.vendorSubscription.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
    });
    if (!current || current.periodEnd > new Date()) {
      return vendor.subscriptionStatus;
    }

    await tx.vendor.update({
      where: { id: vendorId },
      data: { subscriptionStatus: 'EXPIRED' },
    });
    await tx.vendorSubscription.update({
      where: { id: current.id },
      data: { status: 'EXPIRED' },
    });
    return 'EXPIRED';
  }
}
