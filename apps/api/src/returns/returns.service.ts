import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkReturnEligibility,
  computeReturnRefundAmount,
} from './return-policy.util';

const RETURN_CODE_MAX_ATTEMPTS = 10;
const VENDOR_REVIEW_SLA_HOURS = 48;
const DISPUTE_WINDOW_DAYS = 7;
const CODE_VALIDITY_DAYS = 7;

// Every status except these three blocks a second concurrent/duplicate
// Return for the same item - see Return's own partial unique index
// comment (migration SQL) for the exact reasoning, repeated here only
// so the application-layer courtesy pre-check (a clean 409 instead of
// a raw constraint-violation error) stays in sync with the DB-level
// guarantee.
const RESUBMISSION_ALLOWED_STATUSES = [
  'REJECTED_CLOSED',
  'EXPIRED',
  'CANCELLED_BY_CUSTOMER',
] as const;

function generateReturnCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function returnDto(r: {
  id: string;
  status: string;
  reason: string;
  reasonNote: string | null;
  photoUrls: string[];
  code: string | null;
  codeExpiresAt: Date | null;
  rejectedAt: Date | null;
  disputeDeadlineAt: Date | null;
  rejectionReason: string | null;
  escalatedAt: Date | null;
  receivingBranchId: string | null;
  receivedAt: Date | null;
  itemCondition: string | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reason_note: r.reasonNote,
    photo_urls: r.photoUrls,
    code: r.code,
    code_expires_at: r.codeExpiresAt,
    rejected_at: r.rejectedAt,
    dispute_deadline_at: r.disputeDeadlineAt,
    rejection_reason: r.rejectionReason,
    escalated_at: r.escalatedAt,
    receiving_branch_id: r.receivingBranchId,
    received_at: r.receivedAt,
    item_condition: r.itemCondition,
    created_at: r.createdAt,
  };
}

/**
 * Review-round requirement: redeem() is deliberately reachable by any
 * employee/owner of ANY branch of this vendor (PDR-031's cross-branch
 * acceptance) - but reason_note/photo_urls/rejection_reason/code are
 * only for the customer, the ORIGINATING branch's own staff, and
 * PLATFORM_ADMIN (same privacy convention as Sprint 20b's
 * internalStoreNote). The full returnDto() above must never be the
 * response to a redeem call - this is the only safe subset.
 */
function redeemResultDto(r: {
  id: string;
  status: string;
  receivingBranchId: string | null;
  receivedAt: Date | null;
  itemCondition: string | null;
}) {
  return {
    id: r.id,
    status: r.status,
    receiving_branch_id: r.receivingBranchId,
    received_at: r.receivedAt,
    item_condition: r.itemCondition,
  };
}

/**
 * Sprint 21 (EPIC-RET). The full Return lifecycle - submit, customer
 * cancel/dispute, vendor decide, vendor redeem, admin escalation
 * decision. See Return's own schema.prisma comment for the state
 * machine and the partial-unique-index invariants this service's own
 * pre-checks mirror (but never replace - the DB constraint is the
 * real guarantee under concurrency, these are only for a clean error
 * message on the common, non-racing path).
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
  ) {}

  // ============================================================
  // Customer-facing
  // ============================================================

  async submit(
    customerId: string,
    actorUserId: string,
    branchOrderId: string,
    itemId: string,
    dto: {
      reason: string;
      reason_note?: string;
      photo_urls?: string[];
    },
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branch_order_items WHERE id = ${itemId} FOR UPDATE`;
      const item = await tx.branchOrderItem.findUnique({
        where: { id: itemId },
        include: {
          branchOrder: {
            include: { customerOrder: { select: { customerId: true } } },
          },
        },
      });
      if (
        !item ||
        item.branchOrderId !== branchOrderId ||
        item.branchOrder.customerOrder.customerId !== customerId
      ) {
        throw new NotFoundException({
          code: 'BRANCH_ORDER_ITEM_NOT_FOUND',
          message: 'Order item not found',
        });
      }
      if (item.cancelledAt !== null) {
        throw new ConflictException({
          code: 'ITEM_CANCELLED_NOT_RETURNABLE',
          message:
            'A cancelled item was never delivered and cannot be returned',
        });
      }

      const order = item.branchOrder;
      const eligibility = checkReturnEligibility(
        {
          status: order.status,
          fulfilmentMethod: order.fulfilmentMethod,
          paymentMethod: order.paymentMethod,
          deliveredAt: order.deliveredAt,
          pickedUpAt: order.pickedUpAt,
          codCollectedAt: order.codCollectedAt,
          returnPolicySnapshotEnabled: order.returnPolicySnapshotEnabled,
          returnPolicySnapshotMode: order.returnPolicySnapshotMode,
          returnPolicySnapshotWindowDays: order.returnPolicySnapshotWindowDays,
        },
        new Date(),
      );
      if (!eligibility.eligible) {
        throw new ConflictException({
          code: 'NOT_ELIGIBLE_FOR_RETURN',
          message: `This item is not eligible for return (${eligibility.reasonCode})`,
          details: [{ reason_code: eligibility.reasonCode }],
        });
      }

      const openExisting = await tx.return.findFirst({
        where: {
          branchOrderItemId: itemId,
          status: { notIn: [...RESUBMISSION_ALLOWED_STATUSES] },
        },
      });
      if (openExisting) {
        throw new ConflictException({
          code: 'RETURN_ALREADY_EXISTS',
          message:
            'This item already has an open or completed return - see the partial unique index comment on Return for which statuses allow resubmission',
        });
      }

      const now = new Date();
      let created;
      try {
        created = await tx.return.create({
          data: {
            vendorId: item.vendorId,
            branchOrderItemId: itemId,
            reason: dto.reason as never,
            reasonNote: dto.reason_note ?? null,
            photoUrls: dto.photo_urls ?? [],
            status: 'REQUESTED',
            vendorReviewDueAt: new Date(
              now.getTime() + VENDOR_REVIEW_SLA_HOURS * 60 * 60 * 1000,
            ),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'RETURN_ALREADY_EXISTS',
            message: 'This item already has an open or completed return',
          });
        }
        throw err;
      }

      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.requested',
          entityType: 'Return',
          entityId: created.id,
          afterState: { branch_order_item_id: itemId, reason: dto.reason },
        },
        tx,
      );
      await this.notifyBranch(
        tx,
        order.vendorId,
        order.branchId,
        'return.requested',
        { return_id: created.id, branch_order_id: branchOrderId },
      );
      return returnDto(created);
    });
  }

  async cancel(
    customerId: string,
    actorUserId: string,
    returnId: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockAndRequireOwnReturn(tx, customerId, returnId);
      if (r.status !== 'REQUESTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_CANCELLABLE',
          message:
            'Only a return still pending the store decision (REQUESTED) can be cancelled by the customer',
        });
      }
      const updated = await tx.return.update({
        where: { id: returnId },
        data: { status: 'CANCELLED_BY_CUSTOMER' },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.cancelled_by_customer',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REQUESTED' },
          afterState: { status: 'CANCELLED_BY_CUSTOMER' },
        },
        tx,
      );
      return returnDto(updated);
    });
  }

  async dispute(
    customerId: string,
    actorUserId: string,
    returnId: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockAndRequireOwnReturn(tx, customerId, returnId);
      if (r.status !== 'REJECTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_DISPUTABLE',
          message:
            'Only a store-level rejection (REJECTED), not yet closed, can be disputed',
        });
      }
      if (!r.disputeDeadlineAt || new Date() > r.disputeDeadlineAt) {
        throw new ConflictException({
          code: 'DISPUTE_WINDOW_EXPIRED',
          message: 'The dispute window for this rejection has closed',
        });
      }
      const updated = await tx.return.update({
        where: { id: returnId },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.disputed',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REJECTED' },
          afterState: { status: 'ESCALATED' },
        },
        tx,
      );
      return returnDto(updated);
    });
  }

  /** List the customer's own returns, newest first - the minimal
   * read-only plumbing the Orders/Returns UI needs to show "this item
   * already has a return, here's its status" without a client-side
   * returnId cache. */
  async listOwnReturns(customerId: string) {
    const rows = await this.prisma.return.findMany({
      where: {
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        branchOrderItem: {
          select: {
            id: true,
            branchOrderId: true,
            offerVariant: {
              select: {
                vendorOffer: { select: { titleAr: true, titleEn: true } },
              },
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      ...returnDto(r),
      branch_order_id: r.branchOrderItem.branchOrderId,
      branch_order_item_id: r.branchOrderItem.id,
      title_ar: r.branchOrderItem.offerVariant.vendorOffer.titleAr,
      title_en: r.branchOrderItem.offerVariant.vendorOffer.titleEn,
    }));
  }

  async getOwnReturn(customerId: string, returnId: string) {
    const r = await this.prisma.return.findFirst({
      where: {
        id: returnId,
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
    });
    if (!r) {
      throw new NotFoundException({
        code: 'RETURN_NOT_FOUND',
        message: 'Return not found',
      });
    }
    return returnDto(r);
  }

  private async lockAndRequireOwnReturn(
    tx: Prisma.TransactionClient,
    customerId: string,
    returnId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
    const r = await tx.return.findFirst({
      where: {
        id: returnId,
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
    });
    if (!r) {
      throw new NotFoundException({
        code: 'RETURN_NOT_FOUND',
        message: 'Return not found',
      });
    }
    return r;
  }

  // ============================================================
  // Vendor/branch-facing
  // ============================================================

  async listForBranch(vendorId: string, branchId: string) {
    const rows = await this.prisma.return.findMany({
      where: {
        vendorId,
        branchOrderItem: { branchOrder: { branchId } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(returnDto);
  }

  // ============================================================
  // Admin-facing
  // ============================================================

  /** The admin escalation queue - ESCALATED only, the one status
   * resolveEscalation() actually acts on. */
  async listEscalated() {
    const rows = await this.prisma.return.findMany({
      where: { status: 'ESCALATED' },
      orderBy: { escalatedAt: 'asc' },
    });
    return rows.map(returnDto);
  }

  async decide(
    vendorId: string,
    branchId: string,
    returnId: string,
    actorUserId: string,
    correlationId: string,
    dto: { decision: 'approve' | 'reject'; rejection_reason?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
      const r = await tx.return.findFirst({
        where: {
          id: returnId,
          vendorId,
          branchOrderItem: { branchOrder: { branchId } },
        },
      });
      if (!r) {
        throw new NotFoundException({
          code: 'RETURN_NOT_FOUND',
          message: 'Return not found for this branch',
        });
      }
      if (r.status !== 'REQUESTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_DECIDABLE',
          message: 'Only a REQUESTED return can be approved/rejected',
        });
      }

      let updated;
      if (dto.decision === 'approve') {
        updated = await this.createCodeWithRetry(tx, returnId);
      } else {
        const now = new Date();
        updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'REJECTED',
            rejectedAt: now,
            disputeDeadlineAt: new Date(
              now.getTime() + DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
            ),
            rejectionReason: dto.rejection_reason,
          },
        });
      }
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action:
            dto.decision === 'approve' ? 'return.approved' : 'return.rejected',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REQUESTED' },
          afterState: { status: updated.status },
        },
        tx,
      );
      await this.notifyCustomerForReturn(
        tx,
        returnId,
        dto.decision === 'approve' ? 'return.approved' : 'return.rejected',
      );
      return returnDto(updated);
    });
  }

  private async createCodeWithRetry(
    tx: Prisma.TransactionClient,
    returnId: string,
  ) {
    const now = new Date();
    const codeExpiresAt = new Date(
      now.getTime() + CODE_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    for (let attempt = 0; attempt < RETURN_CODE_MAX_ATTEMPTS; attempt++) {
      await tx.$executeRaw`SAVEPOINT return_code_attempt`;
      try {
        const updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'APPROVED_AWAITING_DROPOFF',
            code: generateReturnCode(),
            codeExpiresAt,
          },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT return_code_attempt`;
        return updated;
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT return_code_attempt`;
        if (isUniqueViolation(err) && attempt < RETURN_CODE_MAX_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      'unreachable: return code retry loop exhausted without returning or throwing',
    );
  }

  /**
   * Sprint 21 (PDR-031 cross-branch acceptance). No `:branchId` in the
   * caller's own route (see VendorReturnsController's own comment) -
   * `VendorMembershipGuard` therefore never applies its branch-lock
   * check at all, so any OWNER/BRANCH_EMPLOYEE of this vendor reaches
   * here regardless of their own assigned branch. `receiving_branch_id`
   * is re-verified against `vendorId` explicitly below - the real
   * BOLA guarantee, not the guard.
   *
   * Lock order, fixed (Return -> BranchOrderItem -> BranchStock),
   * matching this codebase's own established deadlock-avoidance
   * discipline.
   */
  async redeem(
    vendorId: string,
    actorUserId: string,
    correlationId: string,
    dto: {
      code: string;
      receiving_branch_id: string;
      item_condition: 'RESELLABLE' | 'DAMAGED';
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.return.findFirst({
        where: {
          vendorId,
          code: dto.code,
          status: 'APPROVED_AWAITING_DROPOFF',
        },
        select: { id: true },
      });
      if (!candidate) {
        throw new ConflictException({
          code: 'INVALID_RETURN_CODE',
          message: 'This code is invalid, already used, or expired',
        });
      }

      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${candidate.id} FOR UPDATE`;
      const r = await tx.return.findUniqueOrThrow({
        where: { id: candidate.id },
        include: {
          branchOrderItem: { include: { branchOrder: true } },
        },
      });
      if (r.status !== 'APPROVED_AWAITING_DROPOFF' || r.code !== dto.code) {
        throw new ConflictException({
          code: 'INVALID_RETURN_CODE',
          message: 'This code is invalid, already used, or expired',
        });
      }
      if (!r.codeExpiresAt || new Date() > r.codeExpiresAt) {
        throw new ConflictException({
          code: 'RETURN_CODE_EXPIRED',
          message: 'This return code has expired',
        });
      }

      const branch = await tx.storeBranch.findFirst({
        where: { id: dto.receiving_branch_id, vendorId },
      });
      if (!branch) {
        throw new ForbiddenException({
          code: 'RECEIVING_BRANCH_NOT_IN_VENDOR',
          message: 'The receiving branch must belong to this vendor',
        });
      }

      await tx.$queryRaw`SELECT id FROM branch_order_items WHERE id = ${r.branchOrderItemId} FOR UPDATE`;
      const item = r.branchOrderItem;
      const order = item.branchOrder;

      const now = new Date();
      await tx.return.update({
        where: { id: r.id },
        data: {
          status: 'RECEIVED',
          receivingBranchId: dto.receiving_branch_id,
          receivedByUserId: actorUserId,
          receivedAt: now,
          itemCondition: dto.item_condition,
        },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.received',
          entityType: 'Return',
          entityId: r.id,
          afterState: {
            receiving_branch_id: dto.receiving_branch_id,
            item_condition: dto.item_condition,
          },
        },
        tx,
      );

      if (dto.item_condition === 'RESELLABLE') {
        await this.incrementBranchStockWithLock(
          tx,
          vendorId,
          dto.receiving_branch_id,
          item.offerVariantId,
          item.quantity,
        );
        const stock = await tx.branchStock.findUniqueOrThrow({
          where: {
            branchId_offerVariantId: {
              branchId: dto.receiving_branch_id,
              offerVariantId: item.offerVariantId,
            },
          },
        });
        await tx.stockMovement.create({
          data: {
            vendorId,
            branchId: dto.receiving_branch_id,
            offerVariantId: item.offerVariantId,
            quantityDelta: item.quantity,
            resultingQuantity: stock.quantity,
            reason: 'RETURN_RESTOCK',
            reasonNote: `Return ${r.id} - item received resellable`,
            actorId: actorUserId,
          },
        });
      }

      await tx.return.update({
        where: { id: r.id },
        data: { status: 'REFUND_PROCESSING' },
      });

      const amount = computeReturnRefundAmount(
        item.unitPrice,
        item.quantity,
        order.returnPolicySnapshotFeeIls,
      );
      const method: 'ONLINE_GATEWAY' | 'COD_CASH' =
        order.paymentMethod === 'ONLINE' ? 'ONLINE_GATEWAY' : 'COD_CASH';
      await tx.branchOrderRefund.create({
        data: {
          branchOrderId: order.id,
          branchOrderItemId: item.id,
          paymentTransactionId:
            method === 'ONLINE_GATEWAY' ? order.paymentTransactionId : null,
          amount: amount.toFixed(2),
          reason: 'ITEM_RETURNED',
          initiatedBy: 'STAFF',
          approvedByUserId: actorUserId,
          method,
          returnId: r.id,
        },
      });
      const finalReturn = await tx.return.update({
        where: { id: r.id },
        data: { status: 'REFUNDED' },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.refund_processed',
          entityType: 'Return',
          entityId: r.id,
          afterState: { amount: amount.toNumber(), method },
        },
        tx,
      );
      await this.notifyCustomerForReturn(tx, r.id, 'return.refunded');

      return redeemResultDto(finalReturn);
    });
  }

  private async incrementBranchStockWithLock(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    offerVariantId: string,
    incrementBy: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_stock:' || ${branchId} || ':' || ${offerVariantId}))`;
    const existing = await tx.branchStock.findUnique({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
    if (existing) {
      await tx.branchStock.update({
        where: { id: existing.id },
        data: { quantity: { increment: incrementBy } },
      });
    } else {
      await tx.branchStock.create({
        data: { vendorId, branchId, offerVariantId, quantity: incrementBy },
      });
    }
  }

  // ============================================================
  // Admin-facing (escalation resolution)
  // ============================================================

  async resolveEscalation(
    adminUserId: string,
    correlationId: string,
    returnId: string,
    dto: { decision: 'approve' | 'reject'; rejection_reason?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
      const r = await tx.return.findUnique({ where: { id: returnId } });
      if (!r) {
        throw new NotFoundException({
          code: 'RETURN_NOT_FOUND',
          message: 'Return not found',
        });
      }
      if (r.status !== 'ESCALATED') {
        throw new ConflictException({
          code: 'RETURN_NOT_ESCALATED',
          message: 'Only an ESCALATED return can receive an admin decision',
        });
      }

      let updated;
      if (dto.decision === 'approve') {
        updated = await this.createCodeWithRetry(tx, returnId);
      } else {
        updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'ADMIN_REJECTED',
            rejectionReason: dto.rejection_reason,
            escalationResolvedAt: new Date(),
            escalationResolvedByUserId: adminUserId,
          },
        });
      }
      await this.auditLog.record(
        {
          actorId: adminUserId,
          correlationId,
          action:
            dto.decision === 'approve'
              ? 'return.escalation_approved'
              : 'return.escalation_admin_rejected',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'ESCALATED' },
          afterState: { status: updated.status },
        },
        tx,
      );
      await this.notifyCustomerForReturn(
        tx,
        returnId,
        dto.decision === 'approve'
          ? 'return.approved'
          : 'return.admin_rejected',
      );
      return returnDto(updated);
    });
  }

  // ============================================================
  // Notification helpers - deep link/id only, NEVER reasonNote,
  // photoUrls, or rejectionReason (same privacy convention as Sprint
  // 20b's internalStoreNote/customerNote).
  // ============================================================

  private async notifyBranch(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipients = await tx.vendorUser.findMany({
      where: {
        vendorId,
        status: 'ACTIVE',
        OR: [{ role: 'OWNER' }, { role: 'BRANCH_EMPLOYEE', branchId }],
      },
      select: { userId: true },
    });
    for (const recipient of recipients) {
      await this.outbox.enqueue(
        {
          eventType,
          payload: { ...payload, recipient_user_id: recipient.userId },
        },
        tx,
      );
    }
  }

  private async notifyCustomerForReturn(
    tx: Prisma.TransactionClient,
    returnId: string,
    eventType: string,
  ): Promise<void> {
    const r = await tx.return.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        branchOrderItem: {
          include: {
            branchOrder: {
              include: {
                customerOrder: {
                  select: { customer: { select: { userId: true } } },
                },
              },
            },
          },
        },
      },
    });
    await this.outbox.enqueue(
      {
        eventType,
        payload: {
          return_id: returnId,
          recipient_user_id:
            r.branchOrderItem.branchOrder.customerOrder.customer.userId,
        },
      },
      tx,
    );
  }
}
