import { Injectable } from '@nestjs/common';
import { CanonicalProductStatus, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { canTransitionCanonicalProduct } from './canonical-product-state-machine';

export type TransitionOutcome =
  | { outcome: 'success'; status: CanonicalProductStatus }
  | { outcome: 'rejected'; status: CanonicalProductStatus; reason: string };

/**
 * Sprint 17b (FR-CAT-008 review-round fix): every attempt - valid or
 * rejected - happens inside ONE transaction, with the row locked before
 * the current status is even read, closing the TOCTOU window a
 * plain-read-then-separately-audit approach would leave open (status
 * could change between the read and the rejection write). A rejected
 * attempt writes its own AuditLog row and returns normally (never
 * throws) so the transaction commits that write for real - the same
 * catch-don't-rethrow discipline OutboxRelayService.process() already
 * established (Sprint 19): a durable "this was rejected, here is why"
 * record is itself a real, intended outcome, not an exception to
 * unwind.
 */
@Injectable()
export class CanonicalProductLifecycleService {
  constructor(private readonly auditLog: AuditLogService) {}

  async attemptTransition(
    tx: Prisma.TransactionClient,
    productId: string,
    toStatus: CanonicalProductStatus,
    actorId: string,
    correlationId: string,
  ): Promise<TransitionOutcome> {
    await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${productId} FOR UPDATE`;
    const product = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: productId },
    });
    const fromStatus = product.status;

    let rejectReason: string | null = null;
    if (!canTransitionCanonicalProduct(fromStatus, toStatus)) {
      rejectReason = `Cannot transition from ${fromStatus} to ${toStatus}`;
    } else if (toStatus === 'PENDING_REVIEW') {
      const variantCount = await tx.canonicalProductVariant.count({
        where: { canonicalProductId: productId },
      });
      if (variantCount === 0) {
        rejectReason =
          'Cannot submit for review with no variants - add at least one first';
      }
    } else if (toStatus === 'PUBLISHED') {
      if (product.isRestricted) {
        rejectReason = 'Cannot publish a restricted product';
      } else {
        const category = await tx.category.findUniqueOrThrow({
          where: { id: product.categoryId },
        });
        if (category.isRestricted) {
          rejectReason = 'Cannot publish under a restricted category';
        }
      }
    }

    if (rejectReason) {
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'canonical_product.status_transition_rejected',
          entityType: 'CanonicalProduct',
          entityId: productId,
          beforeState: { status: fromStatus },
          afterState: {
            status: fromStatus,
            attempted_to_status: toStatus,
            reject_reason: rejectReason,
          },
        },
        tx,
      );
      return { outcome: 'rejected', status: fromStatus, reason: rejectReason };
    }

    const updated = await tx.canonicalProduct.update({
      where: { id: productId },
      data: { status: toStatus },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'canonical_product.status_transition',
        entityType: 'CanonicalProduct',
        entityId: productId,
        beforeState: { status: fromStatus },
        afterState: { status: toStatus },
      },
      tx,
    );
    return { outcome: 'success', status: updated.status };
  }
}
