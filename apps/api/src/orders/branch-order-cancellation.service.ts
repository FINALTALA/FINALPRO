import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  BranchOrderRefundInitiator,
  BranchOrderRefundReason,
  BranchOrderStatus,
  Prisma,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { toDecimal } from '../offers/pricing/effective-price.util';
import { BranchOrderService } from './branch-order.service';
import { computeRemainingRefundable } from './branch-order-money.util';

// Money fields are `unknown` deliberately - every caller passes a
// Prisma-generated row whose Decimal fields need no conversion of
// their own before reaching toDecimal()/computeRemainingRefundable()
// (both already accept `unknown`, same convention as
// effective-price.util.ts's own PriceConfig).
interface LockedOrder {
  id: string;
  vendorId: string;
  branchId: string;
  customerOrderId: string;
  status: BranchOrderStatus;
  fulfilmentMethod: string;
  paymentMethod: string;
  deliveryAttemptCount: number;
  deliveryFee: unknown;
  total: unknown;
  paymentTransactionId: string | null;
}

interface ActiveItemRow {
  id: string;
  offerVariantId: string;
  quantity: number;
  unitPrice: unknown;
}

/**
 * Sprint 20a (PDR-028, FR-PAY-004): every cancellation/refund trigger
 * in this sprint - a customer's own pre-prep item/order cancel, a
 * staff cancel after prep, the PDR-025/027 48h-timeout sweeps, a
 * customer's post-second-failure refund request/staff approval, and
 * an admin's forced-cancel - routes through the two methods below.
 * BranchOrder.subtotal/deliveryFee/total are NEVER rewritten; every
 * "amount due/refunded/remaining" figure is computed on demand (see
 * branch-order-money.util.ts).
 *
 * Lock order, always: BranchOrder (by the caller, before either method
 * here is invoked) -> BranchOrderItem(s) being cancelled, sorted by id
 * -> the distinct BranchStock row(s) those items touch, sorted the
 * same way stock-lock.util.ts's own multi-row callers already sort.
 * Refund-row insertion needs no separate lock: @@unique(
 * branchOrderItemId) and the partial unique index on (branchOrderId)
 * WHERE reason='DELIVERY_FEE' make a duplicate insert fail at the DB
 * level, caught the same SAVEPOINT-protected way as every other
 * optimistic-insert-then-reuse pattern in this codebase (S17b's
 * MatchReportsService).
 */
@Injectable()
export class BranchOrderCancellationService {
  constructor(
    private readonly auditLog: AuditLogService,
    private readonly branchOrderService: BranchOrderService,
  ) {}

  /**
   * Cancels exactly one still-active item. If another item remains
   * active afterward, BranchOrder.status is left untouched entirely -
   * only this item's own cancelledAt/cancelledReason and (ONLINE) its
   * own refund row are written. If this was the LAST active item, the
   * whole order finalizes in the same transaction (delivery fee
   * refunded too, for ONLINE).
   *
   * Assumes the caller has ALREADY locked the BranchOrder row and
   * confirmed its status is PLACED or PREPARING.
   */
  async cancelSingleItem(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    itemId: string,
    actorId: string | null,
    initiatedBy: BranchOrderRefundInitiator,
    reasonText: string | null,
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    await this.lockItemRow(tx, itemId);
    const item = await tx.branchOrderItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    if (item.branchOrderId !== order.id) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_ITEM_NOT_FOUND',
        message: 'Item not found on this branch order',
      });
    }
    if (item.cancelledAt !== null) {
      throw new ConflictException({
        code: 'ITEM_ALREADY_CANCELLED',
        message: 'This item was already cancelled',
      });
    }

    return this.finalizeCancelledItems(
      tx,
      order,
      [{ id: item.id, offerVariantId: item.offerVariantId, quantity: item.quantity, unitPrice: item.unitPrice }],
      BranchOrderRefundReason.ITEM_CANCELLED,
      initiatedBy,
      actorId,
      reasonText,
      correlationId,
    );
  }

  /**
   * Cancels EVERY still-active item of this BranchOrder in one
   * transaction - "cancel the whole order" is implemented as exactly
   * this, never a separate lump-refund code path (see this service's
   * own top comment). Assumes the caller has already locked the
   * BranchOrder row and confirmed its status is PLACED or PREPARING.
   */
  async cancelWholeOrder(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    actorId: string | null,
    initiatedBy: BranchOrderRefundInitiator,
    reasonText: string | null,
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    const items = await this.lockActiveItemsSorted(tx, order.id);
    return this.finalizeCancelledItems(
      tx,
      order,
      items,
      BranchOrderRefundReason.ITEM_CANCELLED,
      initiatedBy,
      actorId,
      reasonText,
      correlationId,
    );
  }

  /**
   * PDR-025 (slot missed, 48h timeout) / PDR-027 (first delivery
   * failure, 48h timeout) - system-triggered, every still-active item
   * refunded/cancelled and the order finalized directly. Assumes the
   * caller has already locked the BranchOrder row, confirmed
   * eligibility, and picked the correct `reason`.
   */
  async finalizeTimeout(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    reason: 'SLOT_MISSED' | 'DELIVERY_FAILURE_TIMEOUT',
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    const items = await this.lockActiveItemsSorted(tx, order.id);
    return this.finalizeCancelledItems(
      tx,
      order,
      items,
      reason,
      BranchOrderRefundInitiator.SYSTEM,
      null,
      null,
      correlationId,
    );
  }

  /**
   * PDR-027, COD only: the SECOND failed delivery attempt finalizes
   * straight to CANCELLED (never rests at DELIVERY_FAILED - see the
   * state machine's own SENT->CANCELLED(COD, minDeliveryAttemptCount:1)
   * rule). Nothing was ever charged, so no refund row is created
   * (finalizeCancelledItems's own `isOnline` check already skips that
   * for COD) - but every still-active item IS marked cancelled and its
   * reserved stock released, exactly like any other closing
   * cancellation. Called from branch-orders-staff.controller.ts's own
   * markDeliveryFailed BEFORE the status transition itself (this
   * method performs that transition internally, via
   * finalizeCancelledItems).
   */
  async finalizeCodSecondDeliveryFailure(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    actorId: string,
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    const items = await this.lockActiveItemsSorted(tx, order.id);
    return this.finalizeCancelledItems(
      tx,
      order,
      items,
      BranchOrderRefundReason.DELIVERY_FAILED_TWICE,
      BranchOrderRefundInitiator.STAFF,
      actorId,
      null,
      correlationId,
      { deliveryAttemptCount: { increment: 1 }, deliveryFailedAt: null },
    );
  }

  /**
   * PDR-027: staff/owner approves a REFUND_REQUESTED order (reached
   * only after a second failed delivery attempt, ONLINE only). Every
   * still-active item is refunded + the delivery fee, same as any
   * other full-order finalization - the only difference is the
   * REFUND_REQUESTED->REFUNDED transition target instead of a
   * PLACED/PREPARING/DELIVERY_FAILED-rooted one.
   */
  async approveRequestedRefund(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    actorId: string,
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    const items = await this.lockActiveItemsSorted(tx, order.id);
    return this.finalizeCancelledItems(
      tx,
      order,
      items,
      BranchOrderRefundReason.DELIVERY_FAILED_TWICE,
      BranchOrderRefundInitiator.STAFF,
      actorId,
      null,
      correlationId,
    );
  }

  /**
   * PLATFORM_ADMIN forced cancel - any non-terminal status. COD closes
   * to CANCELLED with no refund (nothing was ever charged); ONLINE
   * refunds every active item + delivery fee and closes to REFUNDED,
   * in the SAME transaction - never a bare cancel that leaves an
   * ONLINE customer's money uncredited.
   */
  async adminForceCancel(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    actorId: string,
    reasonText: string,
    correlationId: string,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    const items = await this.lockActiveItemsSorted(tx, order.id);
    return this.finalizeCancelledItems(
      tx,
      order,
      items,
      BranchOrderRefundReason.ITEM_CANCELLED,
      BranchOrderRefundInitiator.PLATFORM_ADMIN,
      actorId,
      reasonText,
      correlationId,
    );
  }

  /**
   * PLATFORM_ADMIN manual refund - NOT tied to cancelling anything or
   * changing BranchOrder.status at all (e.g. correcting a dispute).
   * ONLINE only; the amount is ALWAYS the server-computed remaining
   * refundable figure (total - already refunded) - never a manually
   * entered one, and never exceeds it (the ceiling is structural, not
   * merely checked: this is the only place that ever reads it before
   * writing a row that must respect it).
   */
  async adminManualRefund(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    actorId: string,
    reasonText: string,
    correlationId: string,
  ): Promise<{ refundedAmount: Decimal }> {
    if (order.paymentMethod !== 'ONLINE') {
      throw new ConflictException({
        code: 'REFUND_NOT_APPLICABLE_FOR_COD',
        message: 'A COD order was never charged online - there is nothing to refund',
      });
    }
    const existingRefunds = await tx.branchOrderRefund.findMany({
      where: { branchOrderId: order.id },
      select: { amount: true },
    });
    const remaining = computeRemainingRefundable(order.total, existingRefunds);
    if (remaining.lessThanOrEqualTo(0)) {
      throw new ConflictException({
        code: 'NOTHING_LEFT_TO_REFUND',
        message: 'This branch order has already been fully refunded',
      });
    }
    await tx.branchOrderRefund.create({
      data: {
        branchOrderId: order.id,
        branchOrderItemId: null,
        paymentTransactionId: order.paymentTransactionId,
        amount: remaining.toFixed(2),
        reason: BranchOrderRefundReason.PLATFORM_ADMIN_MANUAL,
        initiatedBy: BranchOrderRefundInitiator.PLATFORM_ADMIN,
        approvedByUserId: actorId,
      },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'branch_order.admin_manual_refund',
        entityType: 'BranchOrder',
        entityId: order.id,
        afterState: { amount: remaining.toFixed(2), reason: reasonText },
      },
      tx,
    );
    return { refundedAmount: remaining };
  }

  // ---- shared internals ----

  private async lockItemRow(
    tx: Prisma.TransactionClient,
    itemId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM branch_order_items WHERE id = ${itemId} FOR UPDATE`;
  }

  private async lockActiveItemsSorted(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ): Promise<ActiveItemRow[]> {
    const ids = (
      await tx.branchOrderItem.findMany({
        where: { branchOrderId, cancelledAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((i) => i.id);
    const items: ActiveItemRow[] = [];
    for (const id of ids) {
      await this.lockItemRow(tx, id);
      const fresh = await tx.branchOrderItem.findUniqueOrThrow({
        where: { id },
      });
      // Re-check under lock - a concurrent cancellation of this exact
      // item (racing in between the unlocked discovery query above and
      // this lock) must never be double-counted.
      if (fresh.cancelledAt === null) {
        items.push({
          id: fresh.id,
          offerVariantId: fresh.offerVariantId,
          quantity: fresh.quantity,
          unitPrice: fresh.unitPrice,
        });
      }
    }
    return items;
  }

  private async lockStockRowsSorted(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    offerVariantIds: string[],
  ): Promise<void> {
    const sorted = [...new Set(offerVariantIds)].sort();
    for (const offerVariantId of sorted) {
      await tx.$queryRaw`SELECT id FROM branch_stock WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId} FOR UPDATE`;
    }
  }

  /**
   * The one place that actually writes cancelledAt/refund rows/stock
   * restoration/the final BranchOrder transition - every public method
   * above funnels into this with its own (reason, initiatedBy,
   * approvedByUserId) triple. `items` must already be locked (see
   * lockActiveItemsSorted) when calling for >1 item, or locked via
   * lockItemRow for the single-item case.
   */
  private async finalizeCancelledItems(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    items: ActiveItemRow[],
    reason: BranchOrderRefundReason,
    initiatedBy: BranchOrderRefundInitiator,
    actorId: string | null,
    reasonText: string | null,
    correlationId: string,
    extraTransitionData?: Record<string, unknown>,
  ): Promise<{ orderClosed: boolean; refundedAmount: Decimal }> {
    if (items.length === 0) {
      throw new ConflictException({
        code: 'NO_ACTIVE_ITEMS_TO_CANCEL',
        message: 'This branch order has no active items left to cancel',
      });
    }
    await this.lockStockRowsSorted(
      tx,
      order.vendorId,
      order.branchId,
      items.map((i) => i.offerVariantId),
    );

    const isOnline = order.paymentMethod === 'ONLINE';
    let refundedAmount = new Decimal(0);

    for (const item of items) {
      await tx.branchOrderItem.update({
        where: { id: item.id },
        data: { cancelledAt: new Date(), cancelledReason: reasonText },
      });
      // Caught by an e2e run, not by inspection: checkout's OWN confirm
      // step (checkout.service.ts, the sortedItems loop) decrements
      // BOTH quantity and reservedQuantity together at the moment an
      // order is placed - the temporary hold (reservedQuantity) is
      // released there, and quantity is permanently reduced (a real
      // sale, not just a hold). By the time a BranchOrder reaches
      // PLACED, reservedQuantity already carries none of this order's
      // contribution, so decrementing it further here drove it
      // negative and tripped BranchStock's own CHECK constraint on
      // every single cancellation. The correct inverse of checkout's
      // sale is to increment `quantity` back up - undoing the sale,
      // exactly symmetric to how it was removed - never touching
      // reservedQuantity, which has nothing to do with an already-
      // placed order.
      await tx.branchStock.updateMany({
        where: {
          vendorId: order.vendorId,
          branchId: order.branchId,
          offerVariantId: item.offerVariantId,
        },
        data: { quantity: { increment: item.quantity } },
      });
      if (isOnline) {
        const itemAmount = toDecimal(item.unitPrice).times(item.quantity);
        await tx.branchOrderRefund.create({
          data: {
            branchOrderId: order.id,
            branchOrderItemId: item.id,
            paymentTransactionId: order.paymentTransactionId,
            amount: itemAmount.toFixed(2),
            reason,
            initiatedBy,
            approvedByUserId: actorId,
          },
        });
        refundedAmount = refundedAmount.plus(itemAmount);
      }
    }

    // All active items are now cancelled - whole order closes.
    const remainingActive = await tx.branchOrderItem.count({
      where: { branchOrderId: order.id, cancelledAt: null },
    });
    const orderClosed = remainingActive === 0;

    if (!orderClosed) {
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'branch_order_item.cancelled',
          entityType: 'BranchOrder',
          entityId: order.id,
          afterState: {
            cancelled_item_ids: items.map((i) => i.id),
            reason: reasonText,
          },
        },
        tx,
      );
      return { orderClosed: false, refundedAmount };
    }

    if (
      isOnline &&
      order.fulfilmentMethod === 'DELIVERY' &&
      order.deliveryFee !== null
    ) {
      const feeAmount = toDecimal(order.deliveryFee);
      await tx.branchOrderRefund.create({
        data: {
          branchOrderId: order.id,
          branchOrderItemId: null,
          paymentTransactionId: order.paymentTransactionId,
          amount: feeAmount.toFixed(2),
          reason: BranchOrderRefundReason.DELIVERY_FEE,
          initiatedBy,
          approvedByUserId: actorId,
        },
      });
      refundedAmount = refundedAmount.plus(feeAmount);
    }

    const terminalStatus: BranchOrderStatus = isOnline
      ? 'REFUNDED'
      : 'CANCELLED';
    await this.branchOrderService.transition(
      tx,
      order.id,
      terminalStatus,
      actorId,
      correlationId,
      {
        ...(reasonText !== null ? { cancellationReason: reasonText } : {}),
        ...extraTransitionData,
      },
    );

    return { orderClosed: true, refundedAmount };
  }
}
