import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  generatePickupCode,
  isUniqueViolation,
  PICKUP_CODE_MAX_ATTEMPTS,
  resolveDeliveryFee,
} from '../checkout/checkout.service';
import {
  normalizeMinimumOrderValue,
  resolveDeliveryMinimumOrderValue,
} from '../checkout/minimum-order.util';
import { lockDeliveryWindowRow } from '../delivery-windows/delivery-window-locking.util';
import { toDecimal } from '../offers/pricing/effective-price.util';
import { AuditLogService } from '../audit/audit-log.service';
import {
  BranchOrderRefundInitiator,
  BranchOrderRefundReason,
  DeliveryZoneRegion,
  Prisma,
} from '../../generated/prisma/client';

export type AddressChangeUnsupportedReason =
  | 'ZONE_MISSING'
  | 'ZONE_NOT_SERVED'
  | 'FEE_WOULD_CHANGE'
  | 'BELOW_MINIMUM_ORDER_VALUE';

export type AddressChangeOutcome =
  | { kind: 'changed'; addressId: string }
  | { kind: 'unsupported'; reason: AddressChangeUnsupportedReason };

interface LockedOrderForAddressChange {
  id: string;
  vendorId: string;
  branchId: string;
  fulfilmentMethod: string;
  deliveryWindowId: string | null;
  subtotal: unknown;
  deliveryFee: unknown;
  paymentMethod: string;
  paymentTransactionId: string | null;
}

/**
 * Sprint 22 (PDR-029, review-round requirements): changes a PLACED
 * DELIVERY order's address, or - when the new address is "unsupported"
 * - converts the order to PICKUP instead. `BranchOrder.deliveryFee`/
 * `total`/`subtotal` are NEVER rewritten here, matching branch-order-
 * money.util.ts's own documented invariant - every financial effect
 * goes through the BranchOrderRefund ledger exactly like cancellation
 * does, never a direct column rewrite.
 */
@Injectable()
export class BranchOrderAddressChangeService {
  constructor(private readonly auditLog: AuditLogService) {}

  /**
   * Review-round requirement: the caller has ALREADY locked the
   * BranchOrder row (FOR UPDATE) and confirmed status === 'PLACED' -
   * "before preparation only" (PDR-029's own literal text) - before
   * calling this. Lock order inside this method: the CURRENT delivery
   * window (re-locked defensively, matching reschedule()'s own
   * discipline - the window itself never changes here, only the
   * address) -> the NEW address row, via an explicit
   * `SELECT ... FOR UPDATE`, never a plain findUnique.
   */
  async changeAddress(
    tx: Prisma.TransactionClient,
    order: LockedOrderForAddressChange,
    customerId: string,
    newAddressId: string,
    actorId: string,
    correlationId: string,
  ): Promise<AddressChangeOutcome> {
    if (order.fulfilmentMethod !== 'DELIVERY') {
      throw new ConflictException({
        code: 'ADDRESS_CHANGE_NOT_APPLICABLE',
        message: 'Only a DELIVERY branch order has an address to change',
      });
    }

    if (order.deliveryWindowId) {
      await lockDeliveryWindowRow(tx, order.deliveryWindowId);
    }

    // Explicit SELECT ... FOR UPDATE, never findUnique - then BOLA and
    // archival are both re-checked against THIS locked read, not a
    // separate, earlier, unlocked one.
    const lockedRows = await tx.$queryRaw<
      {
        id: string;
        customerId: string;
        archivedAt: Date | null;
        zone: string | null;
      }[]
    >`SELECT id, "customerId", "archivedAt", zone FROM addresses WHERE id = ${newAddressId} FOR UPDATE`;
    const lockedAddress = lockedRows[0];
    if (
      !lockedAddress ||
      lockedAddress.customerId !== customerId ||
      lockedAddress.archivedAt !== null
    ) {
      // BOLA: never confirm/deny an address belonging to someone else,
      // or an already-archived one, exists.
      throw new NotFoundException({
        code: 'ADDRESS_NOT_FOUND',
        message: 'Address not found',
      });
    }
    if (!lockedAddress.zone) {
      return { kind: 'unsupported', reason: 'ZONE_MISSING' };
    }

    const zoneSetting = await tx.vendorDeliveryZone.findUnique({
      where: {
        vendorId_region: {
          vendorId: order.vendorId,
          region: lockedAddress.zone as DeliveryZoneRegion,
        },
      },
    });
    const newDeliveryFee = resolveDeliveryFee(zoneSetting);
    if (newDeliveryFee === null) {
      return { kind: 'unsupported', reason: 'ZONE_NOT_SERVED' };
    }
    // Decision #1 (review-round, final): ANY fee difference - higher
    // OR lower - is "unsupported" for this endpoint. BranchOrder.
    // deliveryFee is immutable; there is no mechanism anywhere in this
    // codebase to collect an additional payment after confirm(), and
    // this sprint does not introduce one. A fee-neutral swap is the
    // only "simple" success path.
    if (newDeliveryFee !== Number(order.deliveryFee)) {
      return { kind: 'unsupported', reason: 'FEE_WOULD_CHANGE' };
    }

    const branch = await tx.storeBranch.findUniqueOrThrow({
      where: { id: order.branchId },
    });
    const branchMinimum = normalizeMinimumOrderValue(branch.minimumOrderValue);
    const effectiveMinimum = resolveDeliveryMinimumOrderValue(
      branchMinimum,
      normalizeMinimumOrderValue(zoneSetting?.minimumOrderValue),
    );
    if (
      effectiveMinimum !== null &&
      Number(order.subtotal) < effectiveMinimum
    ) {
      return { kind: 'unsupported', reason: 'BELOW_MINIMUM_ORDER_VALUE' };
    }

    // The branch itself is NEVER changed here - PDR-029's own "the
    // original branch is retained if still able to fulfil."
    await tx.branchOrder.update({
      where: { id: order.id },
      data: { addressId: newAddressId },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'branch_order.address_changed',
        entityType: 'BranchOrder',
        entityId: order.id,
        afterState: { address_id: newAddressId },
      },
      tx,
    );
    return { kind: 'changed', addressId: newAddressId };
  }

  /**
   * The customer's own explicit choice, once `changeAddress()` above
   * reports "unsupported" - never triggered automatically. Releases
   * the current delivery slot (deliveryWindowId/scheduledDate -> null,
   * which alone frees the capacity count - see
   * BranchOrderRescheduleService's own comment for why: it counts
   * non-terminal BranchOrder rows on that (window, date) pair, and
   * this order simply stops being one of them), issues a fresh
   * pickup code (same bounded-retry-on-collision loop checkout's own
   * confirm() uses), and refunds the delivery fee via the ledger -
   * ONLINE as a real BranchOrderRefund row (same shape
   * cancelWholeOrder() already writes for its own delivery-fee
   * refund); COD as the SAME reason/row (new write-path - cancellation
   * never needed this for COD, since a cancelled COD order has
   * nothing left to collect at all, but THIS order stays ACTIVE, so
   * writing this row is what makes computeAmountDue()'s own
   * `deliveryFeeRefunded` flag reduce the cash still due at pickup).
   * Caller has already locked the BranchOrder row and confirmed
   * status === 'PLACED', same as changeAddress() above.
   */
  async convertToPickup(
    tx: Prisma.TransactionClient,
    order: LockedOrderForAddressChange,
    actorId: string,
    correlationId: string,
  ) {
    if (order.fulfilmentMethod !== 'DELIVERY') {
      throw new ConflictException({
        code: 'ADDRESS_CHANGE_NOT_APPLICABLE',
        message: 'Only a DELIVERY branch order can be converted to pickup',
      });
    }

    let updated;
    for (let attempt = 0; attempt < PICKUP_CODE_MAX_ATTEMPTS; attempt++) {
      await tx.$executeRaw`SAVEPOINT pickup_conversion_attempt`;
      try {
        updated = await tx.branchOrder.update({
          where: { id: order.id },
          data: {
            fulfilmentMethod: 'PICKUP',
            addressId: null,
            deliveryWindowId: null,
            scheduledDate: null,
            pickupCode: generatePickupCode(),
          },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT pickup_conversion_attempt`;
        break;
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT pickup_conversion_attempt`;
        if (isUniqueViolation(err) && attempt < PICKUP_CODE_MAX_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    if (!updated) {
      throw new Error(
        'unreachable: pickup code retry loop exhausted without returning or throwing',
      );
    }

    if (order.deliveryFee !== null && Number(order.deliveryFee) > 0) {
      const isOnline = order.paymentMethod === 'ONLINE';
      await tx.branchOrderRefund.create({
        data: {
          branchOrderId: order.id,
          branchOrderItemId: null,
          // Non-null for ONLINE_GATEWAY, null for COD_CASH - never
          // inferred, same explicit convention this model's own
          // schema comment documents.
          paymentTransactionId: isOnline ? order.paymentTransactionId : null,
          amount: toDecimal(order.deliveryFee).toFixed(2),
          reason: BranchOrderRefundReason.DELIVERY_FEE,
          initiatedBy: BranchOrderRefundInitiator.CUSTOMER_REQUEST,
          approvedByUserId: actorId,
          method: isOnline ? 'ONLINE_GATEWAY' : 'COD_CASH',
        },
      });
    }

    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'branch_order.converted_to_pickup',
        entityType: 'BranchOrder',
        entityId: order.id,
        afterState: { pickup_code: updated.pickupCode },
      },
      tx,
    );
    return updated;
  }
}
