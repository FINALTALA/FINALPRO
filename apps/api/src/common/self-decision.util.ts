import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

/**
 * TB-28: the person who placed an order may never act, as store staff or
 * as a platform administrator, on a return, a refund or any other
 * money decision of that same order - approving or rejecting a return,
 * deciding an escalated one, accepting the return/exchange code (which
 * refunds or hands over the replacement), approving a requested refund,
 * or a staff/administrator cancellation (which refunds an online
 * payment). Buying from one's own store stays allowed (shopping), and so
 * does fulfilling it (see auditSelfFulfilment); deciding about it does
 * not.
 *
 * Called inside the decision's transaction, after its row lock. The
 * order's customer never changes, so two parallel attempts both see the
 * same answer - and a refused attempt changes nothing.
 */
function selfDecisionForbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'SELF_DECISION_FORBIDDEN',
    message:
      'You placed this order - a cancellation, or a decision on its return or refund, must be made by someone else',
  });
}

export async function assertNotOwnBranchOrder(
  tx: Prisma.TransactionClient,
  branchOrderId: string,
  actorUserId: string,
): Promise<void> {
  const order = await tx.branchOrder.findUniqueOrThrow({
    where: { id: branchOrderId },
    select: {
      customerOrder: { select: { customer: { select: { userId: true } } } },
    },
  });
  if (order.customerOrder.customer.userId === actorUserId) {
    throw selfDecisionForbidden();
  }
}

export async function assertNotOwnReturn(
  tx: Prisma.TransactionClient,
  returnId: string,
  actorUserId: string,
): Promise<void> {
  const r = await tx.return.findUniqueOrThrow({
    where: { id: returnId },
    select: { branchOrderItem: { select: { branchOrderId: true } } },
  });
  await assertNotOwnBranchOrder(
    tx,
    r.branchOrderItem.branchOrderId,
    actorUserId,
  );
}

export type SelfFulfilmentStep =
  | 'START_PREPARATION'
  | 'MARK_SENT'
  | 'MARK_DELIVERED'
  | 'PICKUP_HANDOVER'
  | 'MARK_DELIVERY_FAILED'
  | 'RE_REQUEST_CONFIRMATION';

/**
 * TB-28 (product decision, 2026-11-15): a store member MAY fulfil their
 * own order - prepare, send, deliver, hand over, record the cash collected
 * for COD - as a normal sale, whoever they are and however many people
 * the store has (one rule for all). When the person acting is the order's
 * own customer, the step is recorded explicitly as a self-fulfilment
 * (audit `branch_order.self_fulfilment`, in the same transaction as the
 * step), on top of the usual status-change audit. Returns whether it was.
 */
export async function auditSelfFulfilment(
  tx: Prisma.TransactionClient,
  auditLog: AuditLogService,
  branchOrderId: string,
  actorUserId: string,
  step: SelfFulfilmentStep,
  correlationId: string,
): Promise<boolean> {
  const order = await tx.branchOrder.findUniqueOrThrow({
    where: { id: branchOrderId },
    select: {
      vendorId: true,
      branchId: true,
      customerOrder: { select: { customer: { select: { userId: true } } } },
    },
  });
  if (order.customerOrder.customer.userId !== actorUserId) return false;
  await auditLog.record(
    {
      actorId: actorUserId,
      correlationId,
      action: 'branch_order.self_fulfilment',
      entityType: 'BranchOrder',
      entityId: branchOrderId,
      afterState: {
        step,
        self_fulfilment: true,
        vendor_id: order.vendorId,
        branch_id: order.branchId,
      },
    },
    tx,
  );
  return true;
}
