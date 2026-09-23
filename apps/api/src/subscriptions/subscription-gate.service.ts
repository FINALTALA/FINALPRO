import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

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
 *
 * Review-round finding: this transition previously wrote no AuditLog row
 * at all, even though it is a real vendor state change (Part 4, H.1
 * requires every state transition to be audited). `record()` is now
 * called inside the same `tx` the caller is already using, so the audit
 * row and the ACTIVE->EXPIRED write commit or roll back together. The
 * `SELECT ... FOR UPDATE` below serializes concurrent callers on the
 * same vendor row - Postgres row locks are re-entrant within one
 * transaction, so this is safe even when the caller (e.g.
 * `activate()`/`renew()`) already holds the same lock - and guarantees
 * that if two requests race to be the one that observes the trial has
 * lapsed, only the first actually performs the transition and writes
 * the audit row; the second sees the already-EXPIRED status and returns
 * early without a duplicate.
 */
@Injectable()
export class SubscriptionGateService {
  static readonly SANDBOX_PERIOD_DAYS = SANDBOX_PERIOD_DAYS;

  constructor(private readonly auditLog: AuditLogService) {}

  async refreshStatus(
    tx: Prisma.TransactionClient,
    vendorId: string,
    correlationId: string,
  ): Promise<SubscriptionStatus> {
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

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
    await this.auditLog.record(
      {
        actorId: null,
        correlationId,
        action: 'vendor_subscription.expired',
        entityType: 'VendorSubscription',
        entityId: current.id,
        beforeState: { status: 'ACTIVE' },
        afterState: {
          status: 'EXPIRED',
          period_end: current.periodEnd.toISOString(),
        },
      },
      tx,
    );
    return 'EXPIRED';
  }

  /**
   * Codex review round 3 on commit 3d81c9b: checkout's quote() is a
   * read-only preview - it must never take a `FOR UPDATE` lock, write
   * the lazy ACTIVE->EXPIRED transition, or emit an AuditLog row just
   * because someone previewed a cart. This computes the SAME effective
   * status refreshStatus() would settle on (same ACTIVE/periodEnd
   * logic), purely by reading - never persists the transition, so a
   * genuinely-expired trial is correctly reported as EXPIRED to the
   * caller without being the one to actually flip it in the database.
   * reserve()/confirm() (and cart add-to-cart) still call the real
   * refreshStatus() above, since THEY are actual mutations already
   * happening inside a real transaction, and persisting the transition
   * there is what makes the ACTIVE->EXPIRED flip eventually durable at
   * all under this codebase's lazy-expiry-on-read design.
   */
  async peekEffectiveStatus(
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
    return 'EXPIRED';
  }
}
