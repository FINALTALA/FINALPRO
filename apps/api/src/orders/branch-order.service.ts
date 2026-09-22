import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchOrderStatus, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
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
  constructor(private readonly auditLog: AuditLogService) {}

  /**
   * Locks the BranchOrder row first (`SELECT ... FOR UPDATE`), matching
   * this codebase's established "read fresh under the lock" pattern -
   * two concurrent transition attempts on the same row must never both
   * succeed from a state that only permits one of them to.
   */
  async transition(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    to: BranchOrderStatus,
    actorId: string,
    correlationId: string,
  ) {
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: BranchOrderStatus;
        fulfilmentMethod: string;
        paymentMethod: string;
      }[]
    >`SELECT id, status, "fulfilmentMethod", "paymentMethod" FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
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
      )
    ) {
      throw new ConflictException({
        code: 'INVALID_BRANCH_ORDER_TRANSITION',
        message: `Cannot move a ${current.fulfilmentMethod} branch order from ${current.status} to ${to}`,
      });
    }

    const updated = await tx.branchOrder.update({
      where: { id: branchOrderId },
      data: { status: to },
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
    return updated;
  }
}
