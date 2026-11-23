import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { BlockWhenBranchArchived } from '../auth/branch-archived.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVE_BRANCH_ORDER_STATUSES,
  activeOrderStatusFilter,
} from '../orders/branch-order-state-machine';
import {
  BOOKING_HORIZON_DAYS,
  calendarDates,
  dateOnly,
  daysFromToday,
  localDateString,
} from '../checkout/delivery-calendar.util';
import { CreateDeliveryWindowExceptionDto } from './dto/create-delivery-window-exception.dto';
import { CreateDeliveryWindowDto } from './dto/create-delivery-window.dto';
import { UpdateDeliveryWindowDto } from './dto/update-delivery-window.dto';
import {
  DeliveryReasonDto,
  ISO_DATE,
  StopWindowBookingDto,
} from './dto/delivery-window-actions.dto';
import { lockDeliveryWindowRow } from './delivery-window-locking.util';
import {
  activeOrdersDetails,
  activeOrdersOnDate,
  lockBranchWindowRows,
} from './delivery-window-rules';
import { loadSlotStates } from './window-status';

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function windowDto(w: {
  id: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  capacity: number;
  pausedAt?: Date | null;
  pausedReason?: string | null;
}) {
  return {
    id: w.id,
    day_of_week: w.dayOfWeek,
    start_time: minutesToTime(w.startMinute),
    end_time: minutesToTime(w.endMinute),
    capacity: w.capacity,
    paused: Boolean(w.pausedAt),
    paused_at: w.pausedAt ? w.pausedAt.toISOString() : null,
    paused_reason: w.pausedReason ?? null,
  };
}

/** 'YYYY-MM-DD' path date -> the UTC-midnight Date a @db.Date stores (400 otherwise). */
function parseDayParam(raw: string): Date {
  if (
    !ISO_DATE.test(raw) ||
    Number.isNaN(new Date(`${raw}T00:00:00.000Z`).getTime())
  ) {
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: 'date must be YYYY-MM-DD',
    });
  }
  return dateOnly(raw);
}

function exceptionDto(e: {
  id: string;
  exceptionDate: Date;
  isClosed: boolean;
  capacityOverride: number | null;
  bookingStopped?: boolean;
  reason?: string | null;
}) {
  return {
    id: e.id,
    booking_stopped: e.bookingStopped ?? false,
    reason: e.reason ?? null,
    // toISOString().slice(0,10): the DB column is DATE (no time
    // component) - this avoids a timezone-shifted day when Node's own
    // local timezone differs from UTC.
    exception_date: e.exceptionDate.toISOString().slice(0, 10),
    is_closed: e.isClosed,
    capacity_override: e.capacityOverride,
  };
}

function isExclusionViolation(err: unknown, constraintName: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2039' &&
    err.message.includes(constraintName)
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003'
  );
}

// Sprint 9 (RB-FUL-001, PDR-022/024): owner-only setup for a branch's
// own delivery-slot calendar - recurring weekly windows plus dated
// exceptions. Deliberately setup-only: no customer-facing slot picker,
// no 10-minute reservation hold (both RB-ORD-002, Sprint 10, which
// "reserves a slot on RB-FUL-001's calendar" per the replan's own
// binding-order note).
//
// Owner-only throughout, per-method (not class-level) @RequireVendorRole
// ('OWNER') - VendorMembershipGuard reads it via Reflector.get(KEY,
// context.getHandler()), which never sees a class-level decorator (the
// same requirement already documented, and already gotten wrong more
// than once, on other controllers in this codebase - see their own
// comments). PDR-024's non-overlap requirement is enforced twice: an
// advisory-locked application-level pre-check for a clean 409 in the
// common case, and this migration's own hand-written btree_gist EXCLUDE
// constraint as the real, unconditional guarantee ("لا تعتمد على تحقق
// الواجهة") - isExclusionViolation() maps a rare race that slips past
// the pre-check to the same clean 409 instead of a raw 500.
@Controller('vendors/:vendorId/branches/:branchId/delivery-windows')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class DeliveryWindowsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // Same requireBranch() shape as InventoryController's own (Sprint 6)
  // - :branchId is a plain path param, never auto-validated against
  // :vendorId by any guard, so every route here checks it belongs to
  // this vendor before doing anything else (BOLA).
  private async requireBranch(vendorId: string, branchId: string) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
  }

  private async requireWindow(
    vendorId: string,
    branchId: string,
    windowId: string,
  ) {
    const window = await this.prisma.deliveryWindow.findUnique({
      where: { id: windowId },
    });
    if (
      !window ||
      window.vendorId !== vendorId ||
      window.branchId !== branchId
    ) {
      throw new NotFoundException({
        code: 'DELIVERY_WINDOW_NOT_FOUND',
        message: 'Delivery window not found for this branch',
      });
    }
    return window;
  }

  private validateTimes(startTime: string, endTime: string): void {
    const start = timeToMinutes(startTime);
    const end = timeToMinutes(endTime);
    if (end <= start) {
      throw new ConflictException({
        code: 'INVALID_WINDOW_TIME_RANGE',
        message: 'end_time must be after start_time',
      });
    }
  }

  // Sprint 10 (RB-ORD-002, PDR-024): a live (unexpired) checkout hold
  // on this window is just as real a reason to refuse an edit/delete as
  // an active BranchOrder - the customer mid-checkout was promised this
  // exact slot for 10 minutes; changing its time/capacity or deleting
  // it out from under that promise would break it just as surely as
  // deleting a window with a real order would. Must run AFTER
  // lockDeliveryWindowRow() and inside the same transaction, same as
  // assertNoActiveOrders() above - and for the same reason: the lock
  // is what stops a NEW reservation from attaching in the gap between
  // this check and the actual UPDATE/DELETE.
  private async assertNoActiveReservationSlots(
    tx: Prisma.TransactionClient,
    windowId: string,
  ): Promise<void> {
    const blocking = await tx.checkoutReservationSlot.findFirst({
      where: {
        deliveryWindowId: windowId,
        reservation: { expiresAt: { gt: new Date() } },
      },
    });
    if (blocking) {
      throw new ConflictException({
        code: 'DELIVERY_WINDOW_HAS_ACTIVE_RESERVATION',
        message:
          'A customer is currently mid-checkout with a live hold on this window - try again once their 10-minute hold expires',
      });
    }
  }

  // Codex review round 3 on commit 1febd9a (PDR-024): unlike update(),
  // a hard DELETE must never proceed if ANY BranchOrder - active OR
  // terminal - has ever referenced this window. The FK is ON DELETE
  // RESTRICT specifically so history is never silently lost; without
  // this check the DELETE would eventually hit that RESTRICT itself and
  // surface as a raw, uncaught 500 instead of an intentional 409 (the
  // isForeignKeyViolation() catch in remove() below is a backstop for
  // the same reason, not the primary guarantee). Deliberately simpler
  // than a full archive/retire feature: nothing in this sprint selects
  // windows for customers to book (that's Sprint 10), so there is
  // nothing yet that a "retire without deleting" action would actually
  // change - a window with any order history simply stays in place,
  // unconditionally, and this sprint does not invent an unused
  // is-retired flag ahead of the feature that would read it.
  private async assertNoOrderHistory(
    tx: Prisma.TransactionClient,
    windowId: string,
  ): Promise<void> {
    const anyOrder = await tx.branchOrder.findFirst({
      where: { deliveryWindowId: windowId },
    });
    if (anyOrder) {
      throw new ConflictException({
        code: 'DELIVERY_WINDOW_HAS_ORDER_HISTORY',
        message:
          "This window has at least one branch order (active or completed) in its history and can never be deleted - it must stay in place to preserve that order's history",
      });
    }
  }

  @Get()
  @RequireVendorRole('OWNER')
  async list(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    return this.templateOf(vendorId, branchId);
  }

  /**
   * The weekly template with what the owner needs to manage it: whether a
   * window has ANY order history (then it can only be paused, never
   * deleted, and its day/time never edited) and its exceptions.
   */
  private async templateOf(vendorId: string, branchId: string) {
    const windows = await this.prisma.deliveryWindow.findMany({
      where: { vendorId, branchId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      include: { exceptions: { orderBy: { exceptionDate: 'asc' } } },
    });
    const withHistory = await this.prisma.branchOrder.findMany({
      where: { deliveryWindowId: { in: windows.map((w) => w.id) } },
      select: { deliveryWindowId: true },
      distinct: ['deliveryWindowId'],
    });
    const used = new Set(withHistory.map((o) => o.deliveryWindowId));
    return windows.map((w) => ({
      ...windowDto(w),
      has_order_history: used.has(w.id),
      exceptions: w.exceptions.map(exceptionDto),
    }));
  }

  @Post()
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async create(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDeliveryWindowDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    this.validateTimes(dto.start_time, dto.end_time);
    const startMinute = timeToMinutes(dto.start_time);
    const endMinute = timeToMinutes(dto.end_time);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // PDR-024: atomic non-overlap under concurrency - advisory
        // lock keyed per (vendorId, branchId), same established
        // pattern as staff invites/store sections elsewhere in this
        // codebase, BEFORE the pre-check below so two concurrent
        // creates for the same branch never both pass it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_windows:' || ${vendorId} || ':' || ${branchId}))`;

        // «نوافذ التوصيل v1»: a paused window no longer holds its time
        // (the DB constraint excludes it too) - pause + create new is how
        // a used window's day/time is changed.
        const overlapping = await tx.deliveryWindow.findFirst({
          where: {
            branchId,
            dayOfWeek: dto.day_of_week,
            startMinute: { lt: endMinute },
            endMinute: { gt: startMinute },
            pausedAt: null,
          },
        });
        if (overlapping) {
          throw new ConflictException({
            code: 'DELIVERY_WINDOW_OVERLAP',
            message:
              'This window overlaps an existing window for the same branch and day',
          });
        }

        const created = await tx.deliveryWindow.create({
          data: {
            vendorId,
            branchId,
            dayOfWeek: dto.day_of_week,
            startMinute,
            endMinute,
            capacity: dto.capacity,
          },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'delivery_window.created',
            entityType: 'DeliveryWindow',
            entityId: created.id,
            afterState: windowDto(created),
          },
          tx,
        );
        return { ...windowDto(created), exceptions: [] };
      });
    } catch (err) {
      if (isExclusionViolation(err, 'delivery_windows_no_overlap')) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_OVERLAP',
          message:
            'This window overlaps an existing window for the same branch and day',
        });
      }
      throw err;
    }
  }

  @Put(':windowId')
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async update(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDeliveryWindowDto,
    @Req() req: Request,
  ) {
    const existing = await this.requireWindow(vendorId, branchId, windowId);
    this.validateTimes(dto.start_time, dto.end_time);
    const startMinute = timeToMinutes(dto.start_time);
    const endMinute = timeToMinutes(dto.end_time);
    const timeChanged =
      dto.day_of_week !== existing.dayOfWeek ||
      startMinute !== existing.startMinute ||
      endMinute !== existing.endMinute;
    const capacityChanged = dto.capacity !== existing.capacity;
    // «نوافذ التوصيل v1»: a capacity change is audited with its reason.
    if (capacityChanged && !dto.reason) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'A reason is required to change the capacity',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_windows:' || ${vendorId} || ':' || ${branchId}))`;
        await lockDeliveryWindowRow(tx, windowId);

        if (timeChanged) {
          // «نوافذ التوصيل v1»: the day/time of a window that has ANY
          // order in its history never changes (its orders - future and
          // past - were booked for THIS time). Pause it and create a new
          // window instead.
          const anyOrder = await tx.branchOrder.findFirst({
            where: { deliveryWindowId: windowId },
            select: { id: true },
          });
          if (anyOrder) {
            throw new ConflictException({
              code: 'DELIVERY_WINDOW_TIME_LOCKED',
              message:
                "This window has orders - its day and time can't change. Pause it and add a new window instead.",
            });
          }
          await this.assertNoActiveReservationSlots(tx, windowId);
          if (!existing.pausedAt) {
            const overlapping = await tx.deliveryWindow.findFirst({
              where: {
                id: { not: windowId },
                branchId,
                dayOfWeek: dto.day_of_week,
                startMinute: { lt: endMinute },
                endMinute: { gt: startMinute },
                pausedAt: null,
              },
            });
            if (overlapping) {
              throw new ConflictException({
                code: 'DELIVERY_WINDOW_OVERLAP',
                message:
                  'This window overlaps an existing window for the same branch and day',
              });
            }
          }
        }

        if (capacityChanged && dto.capacity < existing.capacity) {
          // «نوافذ التوصيل v1»: lowering never goes under what is already
          // taken on any upcoming date - active orders + live checkout
          // holds, the same count the window state uses (dates with their
          // own capacity override are not affected by this value).
          const today = dateOnly(localDateString(new Date()));
          const [orders, holds, overrides] = await Promise.all([
            tx.branchOrder.findMany({
              where: {
                deliveryWindowId: windowId,
                scheduledDate: { gte: today },
                status: activeOrderStatusFilter(),
              },
              select: { scheduledDate: true },
            }),
            tx.checkoutReservationSlot.findMany({
              where: {
                deliveryWindowId: windowId,
                scheduledDate: { gte: today },
                reservation: { expiresAt: { gt: new Date() } },
              },
              select: { scheduledDate: true },
            }),
            tx.deliveryWindowException.findMany({
              where: {
                windowId,
                exceptionDate: { gte: today },
                capacityOverride: { not: null },
              },
              select: { exceptionDate: true },
            }),
          ]);
          const skip = new Set(
            overrides.map((o) => o.exceptionDate.toISOString().slice(0, 10)),
          );
          const perDate = new Map<string, number>();
          for (const r of [...orders, ...holds]) {
            if (!r.scheduledDate) continue;
            const k = r.scheduledDate.toISOString().slice(0, 10);
            if (skip.has(k)) continue;
            perDate.set(k, (perDate.get(k) ?? 0) + 1);
          }
          let peak = 0;
          let peakDate: string | null = null;
          for (const [d, n] of perDate) {
            if (n > peak) {
              peak = n;
              peakDate = d;
            }
          }
          if (dto.capacity < peak) {
            throw new ConflictException({
              code: 'CAPACITY_BELOW_BOOKINGS',
              message: `The capacity can't go below ${peak}: ${peak} active order(s) and checkout hold(s) are already booked in this window on ${peakDate}.`,
              details: [
                { requested: dto.capacity, booked: peak, date: peakDate },
              ],
            });
          }
        }

        const updated = await tx.deliveryWindow.update({
          where: { id: windowId },
          data: {
            dayOfWeek: dto.day_of_week,
            startMinute,
            endMinute,
            capacity: dto.capacity,
          },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action:
              capacityChanged && !timeChanged
                ? 'delivery_window.capacity_changed'
                : 'delivery_window.updated',
            entityType: 'DeliveryWindow',
            entityId: windowId,
            beforeState: windowDto(existing),
            afterState: { ...windowDto(updated), reason: dto.reason ?? null },
          },
          tx,
        );
        return windowDto(updated);
      });
    } catch (err) {
      if (isExclusionViolation(err, 'delivery_windows_no_overlap')) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_OVERLAP',
          message:
            'This window overlaps an existing window for the same branch and day',
        });
      }
      throw err;
    }
  }

  // PDR-024: "a slot that has orders cannot be changed/deleted without
  // resolving affected orders" - a hard delete is stricter still, per
  // assertNoOrderHistory()'s own comment: ANY order (active or
  // terminal) blocks it permanently, never just the active ones. This
  // deletion is deliberately explicit and two-step (its own exceptions
  // first, then the window itself), never a DB cascade, so it stays
  // exactly as auditable/controlled as every other deletion in this
  // codebase (e.g. StoreSectionsController's own section delete).
  @Delete(':windowId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async remove(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const existing = await this.requireWindow(vendorId, branchId, windowId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockDeliveryWindowRow(tx, windowId);
        await this.assertNoOrderHistory(tx, windowId);
        await this.assertNoActiveReservationSlots(tx, windowId);
        await tx.deliveryWindowException.deleteMany({ where: { windowId } });
        await tx.deliveryWindow.delete({ where: { id: windowId } });
      });
    } catch (err) {
      // Backstop, not the primary guarantee (see
      // assertNoOrderHistory()'s own comment) - structurally shouldn't
      // fire given the row lock + check above, but a raw RESTRICT
      // violation must never reach the caller as an unhandled 500.
      if (isForeignKeyViolation(err)) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_HAS_ORDER_HISTORY',
          message:
            'This window has at least one branch order in its history and can never be deleted',
        });
      }
      throw err;
    }
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'delivery_window.deleted',
      entityType: 'DeliveryWindow',
      entityId: windowId,
      beforeState: windowDto(existing),
    });
    return { deleted: true };
  }

  @Post(':windowId/exceptions')
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async createException(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDeliveryWindowExceptionDto,
    @Req() req: Request,
  ) {
    await this.requireWindow(vendorId, branchId, windowId);
    const isClosed = dto.is_closed ?? false;
    // Cross-field rule class-validator's per-field decorators can't
    // express cleanly on their own - exactly one of "closed" or
    // "capacity override" per exception, backstopped by this
    // migration's own CHECK constraint on the row itself.
    if (isClosed && dto.capacity_override !== undefined) {
      throw new ConflictException({
        code: 'INVALID_EXCEPTION_COMBINATION',
        message: 'A closed exception cannot also set capacity_override',
      });
    }
    if (!isClosed && dto.capacity_override === undefined) {
      throw new ConflictException({
        code: 'INVALID_EXCEPTION_COMBINATION',
        message:
          'An exception must either close the window or set capacity_override',
      });
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const exceptionDate = new Date(dto.exception_date);
        if (isClosed) {
          // «نوافذ التوصيل v1»: a date is never closed on top of active
          // orders (same rule as closing a whole day) - under the window
          // lock reserve/confirm take, so no booking slips in meanwhile.
          await lockDeliveryWindowRow(tx, windowId);
          const onDate = (
            await activeOrdersOnDate(tx, vendorId, branchId, exceptionDate)
          ).filter((o) => o.deliveryWindowId === windowId);
          if (onDate.length > 0) {
            throw new ConflictException({
              code: 'DATE_HAS_ACTIVE_ORDERS',
              message: `This window has ${onDate.length} active order(s) on this date - it can't be closed. Stop new bookings instead, or handle the orders first.`,
              details: [activeOrdersDetails(onDate)],
            });
          }
        }
        const row = await tx.deliveryWindowException.create({
          data: {
            vendorId,
            windowId,
            exceptionDate,
            isClosed,
            capacityOverride: isClosed ? null : dto.capacity_override,
          },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'delivery_window_exception.created',
            entityType: 'DeliveryWindowException',
            entityId: row.id,
            afterState: exceptionDto(row),
          },
          tx,
        );
        return row;
      });
      return exceptionDto(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_EXCEPTION_ALREADY_EXISTS',
          message:
            'An exception already exists for this window on this date - edit it instead of creating a second one',
        });
      }
      throw err;
    }
  }

  @Delete(':windowId/exceptions/:exceptionId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async removeException(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @Param('exceptionId') exceptionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireWindow(vendorId, branchId, windowId);
    const existing = await this.prisma.deliveryWindowException.findUnique({
      where: { id: exceptionId },
    });
    if (!existing || existing.windowId !== windowId) {
      throw new NotFoundException({
        code: 'DELIVERY_WINDOW_EXCEPTION_NOT_FOUND',
        message: 'Exception not found for this window',
      });
    }
    await this.prisma.deliveryWindowException.delete({
      where: { id: exceptionId },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'delivery_window_exception.deleted',
      entityType: 'DeliveryWindowException',
      entityId: exceptionId,
      beforeState: exceptionDto(existing),
    });
    return { deleted: true };
  }

  // ==================================================================
  // «نوافذ التوصيل v1» - pause / resume, stop new bookings for a date,
  // close a whole day, and the branch's 7-day board. Every write is
  // OWNER-only (a branch employee gets 403), carries a reason and is
  // audited with the actor and the before/after values.
  // ==================================================================

  /** Pause a weekly window: no new bookings; history and orders stay. */
  @Post(':windowId/pause')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async pause(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeliveryReasonDto,
    @Req() req: Request,
  ) {
    await this.requireWindow(vendorId, branchId, windowId);
    return this.prisma.$transaction(async (tx) => {
      await lockDeliveryWindowRow(tx, windowId);
      const before = await tx.deliveryWindow.findUniqueOrThrow({
        where: { id: windowId },
      });
      if (before.pausedAt) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_ALREADY_PAUSED',
          message: 'This window is already paused',
        });
      }
      const after = await tx.deliveryWindow.update({
        where: { id: windowId },
        data: { pausedAt: new Date(), pausedReason: dto.reason },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'delivery_window.paused',
          entityType: 'DeliveryWindow',
          entityId: windowId,
          beforeState: windowDto(before),
          afterState: { ...windowDto(after), reason: dto.reason },
        },
        tx,
      );
      return windowDto(after);
    });
  }

  /** Resume a paused window (its time must not overlap an active window). */
  @Post(':windowId/resume')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async resume(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeliveryReasonDto,
    @Req() req: Request,
  ) {
    await this.requireWindow(vendorId, branchId, windowId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_windows:' || ${vendorId} || ':' || ${branchId}))`;
        await lockDeliveryWindowRow(tx, windowId);
        const before = await tx.deliveryWindow.findUniqueOrThrow({
          where: { id: windowId },
        });
        if (!before.pausedAt) {
          throw new ConflictException({
            code: 'DELIVERY_WINDOW_NOT_PAUSED',
            message: 'This window is not paused',
          });
        }
        const overlapping = await tx.deliveryWindow.findFirst({
          where: {
            id: { not: windowId },
            branchId,
            dayOfWeek: before.dayOfWeek,
            startMinute: { lt: before.endMinute },
            endMinute: { gt: before.startMinute },
            pausedAt: null,
          },
        });
        if (overlapping) {
          throw new ConflictException({
            code: 'DELIVERY_WINDOW_OVERLAP',
            message:
              'Another active window now uses this time - pause it first, or keep this one paused',
          });
        }
        const after = await tx.deliveryWindow.update({
          where: { id: windowId },
          data: { pausedAt: null, pausedReason: null },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'delivery_window.resumed',
            entityType: 'DeliveryWindow',
            entityId: windowId,
            beforeState: windowDto(before),
            afterState: { ...windowDto(after), reason: dto.reason },
          },
          tx,
        );
        return windowDto(after);
      });
    } catch (err) {
      if (isExclusionViolation(err, 'delivery_windows_no_overlap')) {
        throw new ConflictException({
          code: 'DELIVERY_WINDOW_OVERLAP',
          message:
            'Another active window now uses this time - pause it first, or keep this one paused',
        });
      }
      throw err;
    }
  }

  /** The date must be today or later (Palestine time). */
  private requireNotPast(date: Date): void {
    if (daysFromToday(date, new Date()) < 0) {
      throw new ConflictException({
        code: 'DATE_IN_PAST',
        message: 'This date has already passed',
      });
    }
  }

  /**
   * Upserts one (window, date) exception to a v1 kind. `stop`: new
   * bookings stopped (a closed date stays closed); `close`: closed.
   * Returns the before/after exception (null when nothing changed).
   */
  private async setDateKind(
    tx: Prisma.TransactionClient,
    vendorId: string,
    windowId: string,
    date: Date,
    kind: 'stop' | 'close',
    reason: string,
  ) {
    const before = await tx.deliveryWindowException.findUnique({
      where: { windowId_exceptionDate: { windowId, exceptionDate: date } },
    });
    if (kind === 'stop' && before?.isClosed) return null; // already closed
    if (kind === 'stop' && before?.bookingStopped) return null;
    if (kind === 'close' && before?.isClosed) return null;
    const data = {
      isClosed: kind === 'close',
      bookingStopped: kind === 'stop',
      capacityOverride: null,
      reason,
    };
    const after = before
      ? await tx.deliveryWindowException.update({
          where: { id: before.id },
          data,
        })
      : await tx.deliveryWindowException.create({
          data: { vendorId, windowId, exceptionDate: date, ...data },
        });
    return { before, after };
  }

  private async auditDateChange(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    req: Request,
    action: string,
    change: {
      before: Parameters<typeof exceptionDto>[0] | null;
      after: Parameters<typeof exceptionDto>[0] & { id: string };
    },
    reason: string,
  ) {
    await this.auditLog.record(
      {
        actorId: user.id,
        correlationId: req.correlationId,
        action,
        entityType: 'DeliveryWindowException',
        entityId: change.after.id,
        beforeState: change.before ? exceptionDto(change.before) : null,
        afterState: { ...exceptionDto(change.after), reason },
      },
      tx,
    );
  }

  /** Stop NEW bookings of one window on one date - its orders stay. */
  @Post(':windowId/stop-booking')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async stopWindowBooking(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StopWindowBookingDto,
    @Req() req: Request,
  ) {
    const window = await this.requireWindow(vendorId, branchId, windowId);
    const date = parseDayParam(dto.date);
    this.requireNotPast(date);
    if (date.getUTCDay() !== window.dayOfWeek) {
      throw new ConflictException({
        code: 'INVALID_SLOT_DATE',
        message: "This date does not match the window's day of week",
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await lockDeliveryWindowRow(tx, windowId);
      const change = await this.setDateKind(
        tx,
        vendorId,
        windowId,
        date,
        'stop',
        dto.reason,
      );
      if (change) {
        await this.auditDateChange(
          tx,
          user,
          req,
          'delivery_window.booking_stopped',
          change,
          dto.reason,
        );
      }
      return {
        date: dto.date,
        delivery_window_id: windowId,
        changed: Boolean(change),
      };
    });
  }

  /** Undo a booking stop / closure of one window on one date. */
  @Post(':windowId/reopen')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async reopenWindowDate(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StopWindowBookingDto,
    @Req() req: Request,
  ) {
    await this.requireWindow(vendorId, branchId, windowId);
    const date = parseDayParam(dto.date);
    this.requireNotPast(date);
    return this.prisma.$transaction(async (tx) => {
      await lockDeliveryWindowRow(tx, windowId);
      const reopened = await this.reopenExceptions(
        tx,
        user,
        req,
        [windowId],
        date,
        dto.reason,
      );
      return { date: dto.date, delivery_window_id: windowId, reopened };
    });
  }

  private async reopenExceptions(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    req: Request,
    windowIds: string[],
    date: Date,
    reason: string,
  ): Promise<number> {
    const rows = await tx.deliveryWindowException.findMany({
      where: {
        windowId: { in: windowIds },
        exceptionDate: date,
        OR: [{ isClosed: true }, { bookingStopped: true }],
      },
    });
    for (const row of rows) {
      await tx.deliveryWindowException.delete({ where: { id: row.id } });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'delivery_window.date_reopened',
          entityType: 'DeliveryWindowException',
          entityId: row.id,
          beforeState: exceptionDto(row),
          afterState: { reopened: true, reason },
        },
        tx,
      );
    }
    return rows.length;
  }

  /** Stop NEW bookings of every window of that day - orders stay. */
  @Post('days/:date/stop-booking')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async stopDayBooking(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('date') dateRaw: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeliveryReasonDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const date = parseDayParam(dateRaw);
    this.requireNotPast(date);
    return this.prisma.$transaction(async (tx) => {
      const rows = await lockBranchWindowRows(
        tx,
        vendorId,
        branchId,
        date.getUTCDay(),
      );
      let changed = 0;
      for (const { id } of rows) {
        const change = await this.setDateKind(
          tx,
          vendorId,
          id,
          date,
          'stop',
          dto.reason,
        );
        if (!change) continue;
        changed += 1;
        await this.auditDateChange(
          tx,
          user,
          req,
          'delivery_window.day_booking_stopped',
          change,
          dto.reason,
        );
      }
      return { date: dateRaw, windows: rows.length, changed };
    });
  }

  /**
   * Close a whole day: every window of that date. Refused while the day
   * has ANY active delivery order (the 409 lists them - date and window -
   * so the screen can open the branch orders filtered to them).
   */
  @Post('days/:date/close')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async closeDay(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('date') dateRaw: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeliveryReasonDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const date = parseDayParam(dateRaw);
    this.requireNotPast(date);
    return this.prisma.$transaction(async (tx) => {
      const rows = await lockBranchWindowRows(
        tx,
        vendorId,
        branchId,
        date.getUTCDay(),
      );
      const active = await activeOrdersOnDate(tx, vendorId, branchId, date);
      if (active.length > 0) {
        throw new ConflictException({
          code: 'DAY_HAS_ACTIVE_ORDERS',
          message: `This day has ${active.length} active delivery order(s) - it can't be closed. Stop new bookings instead, or handle the orders first.`,
          details: [activeOrdersDetails(active)],
        });
      }
      let changed = 0;
      for (const { id } of rows) {
        const change = await this.setDateKind(
          tx,
          vendorId,
          id,
          date,
          'close',
          dto.reason,
        );
        if (!change) continue;
        changed += 1;
        await this.auditDateChange(
          tx,
          user,
          req,
          'delivery_window.day_closed',
          change,
          dto.reason,
        );
      }
      return { date: dateRaw, windows: rows.length, changed };
    });
  }

  /** Reopen a whole day (removes its booking stops / closures). */
  @Post('days/:date/reopen')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async reopenDay(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('date') dateRaw: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeliveryReasonDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);
    const date = parseDayParam(dateRaw);
    this.requireNotPast(date);
    return this.prisma.$transaction(async (tx) => {
      const rows = await lockBranchWindowRows(
        tx,
        vendorId,
        branchId,
        date.getUTCDay(),
      );
      const reopened = await this.reopenExceptions(
        tx,
        user,
        req,
        rows.map((r) => r.id),
        date,
        dto.reason,
      );
      return { date: dateRaw, reopened };
    });
  }

  /**
   * The branch's 7-day board - the OWNER and the employee of THIS branch
   * (no @RequireVendorRole: VendorMembershipGuard lets an employee in for
   * their own branch only). Every state comes from window-status.ts, the
   * same one the shopper's slot list uses.
   */
  @Get('board')
  async board(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const now = new Date();
    const dates = calendarDates(now, BOOKING_HORIZON_DAYS);
    const [states, branch, template, byStatusRows] = await Promise.all([
      loadSlotStates(this.prisma, { vendorId, branchId, dates, now }),
      this.prisma.storeBranch.findUnique({
        where: { id: branchId },
        select: { deliveryLeadMinutes: true },
      }),
      this.templateOf(vendorId, branchId),
      this.prisma.branchOrder.findMany({
        where: {
          vendorId,
          branchId,
          scheduledDate: { in: dates },
          deliveryWindowId: { not: null },
          status: activeOrderStatusFilter(),
        },
        select: { deliveryWindowId: true, scheduledDate: true, status: true },
      }),
    ]);
    const byStatus = new Map<string, Record<string, number>>();
    for (const o of byStatusRows) {
      const k = `${o.deliveryWindowId}|${o.scheduledDate!.toISOString().slice(0, 10)}`;
      const m = byStatus.get(k) ?? {};
      m[o.status] = (m[o.status] ?? 0) + 1;
      byStatus.set(k, m);
    }
    const days = dates.map((d) => {
      const key = d.toISOString().slice(0, 10);
      const ws = states.filter((s) => s.date === key);
      const closed = ws.filter((s) => s.status === 'CLOSED');
      const dayStatus =
        ws.length === 0
          ? 'NO_WINDOWS'
          : ws.some((s) => s.status === 'OPEN')
            ? 'OPEN'
            : ws.every((s) => s.status === 'PAST')
              ? 'PAST'
              : closed.length === ws.length
                ? 'CLOSED'
                : 'NOT_BOOKABLE';
      return {
        date: key,
        day_of_week: d.getUTCDay(),
        status: dayStatus,
        closed_reason:
          dayStatus === 'CLOSED' ? (closed[0]?.reason ?? null) : null,
        closed_source:
          dayStatus === 'CLOSED' ? (closed[0]?.closedSource ?? null) : null,
        active_orders: ws.reduce((n, s) => n + s.activeOrders, 0),
        windows: ws.map((s) => ({
          window_id: s.windowId,
          start_time: minutesToTime(s.startMinute),
          end_time: minutesToTime(s.endMinute),
          status: s.status,
          reason: s.reason,
          closed_source: s.closedSource,
          capacity: s.capacity,
          booked: s.activeOrders,
          active_holds: s.activeHolds,
          remaining: s.remaining,
          booking_deadline: s.bookingDeadline.toISOString(),
          paused: s.paused,
          orders_by_status: Object.fromEntries(
            ACTIVE_BRANCH_ORDER_STATUSES.map((st) => [
              st,
              byStatus.get(`${s.windowId}|${s.date}`)?.[st] ?? 0,
            ]).filter(([, n]) => (n as number) > 0),
          ),
        })),
      };
    });
    return {
      branch_id: branchId,
      today: localDateString(now),
      horizon_days: BOOKING_HORIZON_DAYS,
      lead_minutes: branch?.deliveryLeadMinutes ?? 0,
      days,
      template,
    };
  }
}
