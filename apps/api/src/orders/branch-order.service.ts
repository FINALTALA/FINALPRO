import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchOrderStatus, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { canTransition } from './branch-order-state-machine';

/**
 * Sprint 9 (RB-ORD-001): the only path that may ever change
 * BranchOrder.status - guarded, transactional, audited. No controller
 * calls this yet (checkout/fulfilment actions that will are Sprint
 * 10-11); it exists now, fully unit-tested against a real (mocked-
 * Prisma) call shape, so those later sprints wire an action to an
 * already-correct, already-proven state machine instead of inventing
 * one under schedule pressure.
 */
@Injectable()
export class BranchOrderService {
  constructor(
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
  ) {}

  /**
   * Locks the BranchOrder row first (`SELECT ... FOR UPDATE`), matching
   * this codebase's established "read fresh under the lock" pattern -
   * two concurrent transition attempts on the same row must never both
   * succeed from a state that only permits one of them to.
   *
   * Sprint 11 (RB-FUL-002): `actorId` is now nullable - a system-
   * triggered transition (the 72h auto-confirm, see
   * FulfilmentReconciliationService) has no human actor, the same
   * `actorId: null` convention SubscriptionGateService's own lazy
   * ACTIVE->EXPIRED transition already established for this codebase.
   * `extraData` merges additional columns into this SAME atomic
   * `update()` call (e.g. `deliveredAt` alongside the SENT->DELIVERED
   * status write) - still the one and only place that ever writes
   * BranchOrder.status, just now able to carry a companion field
   * through the same lock/audit machinery instead of needing a second,
   * separate write outside of it.
   */
  async transition(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    to: BranchOrderStatus,
    actorId: string | null,
    correlationId: string,
    extraData?: Prisma.BranchOrderUpdateInput,
  ) {
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: BranchOrderStatus;
        fulfilmentMethod: string;
        paymentMethod: string;
        deliveryAttemptCount: number;
      }[]
    >`SELECT id, status, "fulfilmentMethod", "paymentMethod", "deliveryAttemptCount" FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const current = rows[0];
    if (!current) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found',
      });
    }
    if (
      !canTransition(
        current.status,
        to,
        current.fulfilmentMethod as Parameters<typeof canTransition>[2],
        current.paymentMethod as Parameters<typeof canTransition>[3],
        current.deliveryAttemptCount,
      )
    ) {
      throw new ConflictException({
        code: 'INVALID_BRANCH_ORDER_TRANSITION',
        message: `Cannot move a ${current.fulfilmentMethod} branch order from ${current.status} to ${to}`,
      });
    }

    // «إدارة طلبات الفرع v2» phase 2 (2026-11-24): the moment an order is
    // finally completed, on every path (they all pass here) - no backfill.
    const completed: Prisma.BranchOrderUpdateInput =
      to === 'COMPLETED' ? { completedAt: new Date() } : {};
    const updated = await tx.branchOrder.update({
      where: { id: branchOrderId },
      data: { ...completed, ...extraData, status: to },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'branch_order.status_changed',
        entityType: 'BranchOrder',
        entityId: branchOrderId,
        beforeState: { status: current.status },
        afterState: { status: to },
      },
      tx,
    );
    // PD-3 (decision 12): every path to COMPLETED (staff hand-over,
    // the customer's own confirmation, the 72h auto-confirm) passes
    // here, so the review invitation is written once, atomically with
    // the status change.
    if (to === 'COMPLETED') {
      const order = await tx.customerOrder.findUnique({
        where: { id: updated.customerOrderId },
        select: { customer: { select: { userId: true } } },
      });
      if (order) {
        await this.outbox.enqueue(
          {
            eventType: 'branch_order.review_invitation',
            audience: 'CUSTOMER',
            payload: {
              branch_order_id: branchOrderId,
              vendor_id: updated.vendorId,
              branch_id: updated.branchId,
              recipient_user_id: order.customer.userId,
            },
          },
          tx,
        );
      }
    }
    return updated;
  }
}
