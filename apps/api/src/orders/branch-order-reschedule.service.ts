import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { lockDeliveryWindowRow } from '../delivery-windows/delivery-window-locking.util';
import { BranchOrderService } from './branch-order.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from './branch-order-state-machine';

// Same tiny date-only helpers CheckoutService/slot-availability.util.ts
// already each keep their own private copy of, rather than a shared
// export - matching that same established convention here.
function utcDateOnly(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function parseDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

interface LockedOrderForReschedule {
  id: string;
  vendorId: string;
  branchId: string;
  status: string;
  fulfilmentMethod: string;
  slotMissedAt: Date | null;
  deliveryFailedAt: Date | null;
  deliveryAttemptCount: number;
}

/**
 * Sprint 20a (PDR-025/027, review-round requirement): reschedules an
 * EXISTING DELIVERY BranchOrder to a new (deliveryWindowId,
 * scheduledDate) - never just a bare status write. Reuses the exact
 * same lock-then-count-under-lock capacity mechanism
 * CheckoutService's own reserveDeliverySlotAlreadyLocked() uses
 * (lockDeliveryWindowRow() first, then count active
 * CheckoutReservationSlot + BranchOrder rows for that exact window/
 * date), so two customers racing for the last slot - whether one of
 * them is a fresh checkout and the other a reschedule, or both are
 * reschedules - serialize on the SAME row lock and the second always
 * sees the first's already-committed count.
 */
@Injectable()
export class BranchOrderRescheduleService {
  constructor(private readonly branchOrderService: BranchOrderService) {}

  /**
   * Assumes the caller has ALREADY locked the BranchOrder row and
   * confirmed it is eligible to reschedule (PLACED/PREPARING with
   * slotMissedAt set, or DELIVERY_FAILED with deliveryAttemptCount < 2
   * - see the two sweep-eligible entry points' own callers).
   */
  async reschedule(
    tx: Prisma.TransactionClient,
    order: LockedOrderForReschedule,
    newWindowId: string,
    newScheduledDateStr: string,
    actorId: string | null,
    correlationId: string,
  ): Promise<{ deliveryWindowId: string; scheduledDate: Date }> {
    if (order.fulfilmentMethod !== 'DELIVERY') {
      throw new ConflictException({
        code: 'RESCHEDULE_NOT_APPLICABLE',
        message: 'Only a DELIVERY branch order can be rescheduled',
      });
    }

    // Lock the TARGET window - same primitive checkout's own reserve()
    // uses, so a concurrent checkout reserve/confirm or another
    // reschedule on the SAME window serializes against this one.
    await lockDeliveryWindowRow(tx, newWindowId);

    // BOLA: the window must belong to the SAME vendor/branch as this
    // order - a crafted windowId from a different vendor/branch 404s
    // exactly like a nonexistent one (never confirms or denies it
    // exists to a non-eligible caller).
    const window = await tx.deliveryWindow.findUnique({
      where: { id: newWindowId },
    });
    if (
      !window ||
      window.vendorId !== order.vendorId ||
      window.branchId !== order.branchId
    ) {
      throw new NotFoundException({
        code: 'DELIVERY_WINDOW_NOT_FOUND',
        message: 'Delivery window not found for this branch',
      });
    }

    const scheduledDate = parseDateOnly(newScheduledDateStr);
    const today = utcDateOnly(new Date());
    const diffDays = Math.round(
      (scheduledDate.getTime() - today.getTime()) / 86_400_000,
    );
    if (diffDays < 0 || diffDays > 2) {
      throw new ConflictException({
        code: 'INVALID_SLOT_DATE',
        message: 'The slot date must be within the next three days',
      });
    }
    if (scheduledDate.getUTCDay() !== window.dayOfWeek) {
      throw new ConflictException({
        code: 'INVALID_SLOT_DATE',
        message: "This date does not match the window's day of week",
      });
    }

    const exception = await tx.deliveryWindowException.findUnique({
      where: {
        windowId_exceptionDate: {
          windowId: newWindowId,
          exceptionDate: scheduledDate,
        },
      },
    });
    if (exception?.isClosed) {
      throw new ConflictException({
        code: 'SLOT_CLOSED',
        message: 'This branch is closed on this date',
      });
    }
    const effectiveCapacity = exception?.capacityOverride ?? window.capacity;

    // Same capacity accounting as checkout's own reserve() - active
    // (unexpired) CheckoutReservationSlot rows plus active (non-
    // terminal) BranchOrder rows on this exact (window, date) pair -
    // EXCLUDING this order's own current row, which would otherwise
    // double-count itself against the NEW slot it does not occupy yet.
    const [activeReservationCount, activeOrderCount] = await Promise.all([
      tx.checkoutReservationSlot.count({
        where: {
          deliveryWindowId: newWindowId,
          scheduledDate,
          reservation: { expiresAt: { gt: new Date() } },
        },
      }),
      tx.branchOrder.count({
        where: {
          deliveryWindowId: newWindowId,
          scheduledDate,
          status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
          id: { not: order.id },
        },
      }),
    ]);
    if (activeReservationCount + activeOrderCount >= effectiveCapacity) {
      throw new ConflictException({
        code: 'SLOT_CAPACITY_EXCEEDED',
        message: 'This slot is now fully booked - choose another',
      });
    }

    // If rescheduling out of DELIVERY_FAILED, the status transition
    // itself (DELIVERY_FAILED->SENT) goes through BranchOrderService
    // so it re-validates under the SAME already-held lock and writes
    // the standard audit row - the window/date/clock fields below are
    // extraData merged into that SAME atomic update() call. For a
    // PLACED/PREPARING slot-missed reschedule, status does not change
    // at all - just the window/date/clock fields, via a plain update.
    const fieldData = {
      deliveryWindowId: newWindowId,
      scheduledDate,
      // The slot/failure clocks both reset - the new slot is a clean
      // start, whichever trigger brought the order here.
      slotMissedAt: null,
      deliveryFailedAt: null,
    };
    if (order.status === 'DELIVERY_FAILED') {
      await this.branchOrderService.transition(
        tx,
        order.id,
        'SENT',
        actorId,
        correlationId,
        fieldData,
      );
    } else {
      await tx.branchOrder.update({ where: { id: order.id }, data: fieldData });
    }

    return { deliveryWindowId: newWindowId, scheduledDate };
  }
}
