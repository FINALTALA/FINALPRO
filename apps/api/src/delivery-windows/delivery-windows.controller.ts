import {
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
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { CreateDeliveryWindowExceptionDto } from './dto/create-delivery-window-exception.dto';
import { CreateDeliveryWindowDto } from './dto/create-delivery-window.dto';
import { UpdateDeliveryWindowDto } from './dto/update-delivery-window.dto';

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
}) {
  return {
    id: w.id,
    day_of_week: w.dayOfWeek,
    start_time: minutesToTime(w.startMinute),
    end_time: minutesToTime(w.endMinute),
    capacity: w.capacity,
  };
}

function exceptionDto(e: {
  id: string;
  exceptionDate: Date;
  isClosed: boolean;
  capacityOverride: number | null;
}) {
  return {
    id: e.id,
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

  // PDR-024 (Codex review round 1 on commit e12d77a): "a slot that has
  // orders cannot be changed/deleted without resolving affected
  // orders." No HTTP endpoint attaches a BranchOrder to a window yet
  // (Sprint 10's checkout will), but the composite FK and this guard
  // both exist now, not deferred - a direct/seeded BranchOrder row can
  // already reference a window today, and this must already refuse to
  // touch it. "Active" = not yet terminal (COMPLETED/CANCELLED/
  // REFUNDED), the exact same definition branch-order-state-machine.ts
  // uses, imported rather than duplicated.
  private async assertNoActiveOrders(windowId: string): Promise<void> {
    const blocking = await this.prisma.branchOrder.findFirst({
      where: {
        deliveryWindowId: windowId,
        status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
      },
    });
    if (blocking) {
      throw new ConflictException({
        code: 'DELIVERY_WINDOW_HAS_ACTIVE_ORDERS',
        message:
          'This window has an active (non-terminal) branch order attached to it - resolve or reassign it before changing/deleting the window',
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
    const windows = await this.prisma.deliveryWindow.findMany({
      where: { vendorId, branchId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      include: { exceptions: { orderBy: { exceptionDate: 'asc' } } },
    });
    return windows.map((w) => ({
      ...windowDto(w),
      exceptions: w.exceptions.map(exceptionDto),
    }));
  }

  @Post()
  @HttpCode(201)
  @RequireVendorRole('OWNER')
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

        const overlapping = await tx.deliveryWindow.findFirst({
          where: {
            branchId,
            dayOfWeek: dto.day_of_week,
            startMinute: { lt: endMinute },
            endMinute: { gt: startMinute },
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
  async update(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDeliveryWindowDto,
    @Req() req: Request,
  ) {
    const existing = await this.requireWindow(vendorId, branchId, windowId);
    await this.assertNoActiveOrders(windowId);
    this.validateTimes(dto.start_time, dto.end_time);
    const startMinute = timeToMinutes(dto.start_time);
    const endMinute = timeToMinutes(dto.end_time);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:delivery_windows:' || ${vendorId} || ':' || ${branchId}))`;

        const overlapping = await tx.deliveryWindow.findFirst({
          where: {
            id: { not: windowId },
            branchId,
            dayOfWeek: dto.day_of_week,
            startMinute: { lt: endMinute },
            endMinute: { gt: startMinute },
          },
        });
        if (overlapping) {
          throw new ConflictException({
            code: 'DELIVERY_WINDOW_OVERLAP',
            message:
              'This window overlaps an existing window for the same branch and day',
          });
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
            action: 'delivery_window.updated',
            entityType: 'DeliveryWindow',
            entityId: windowId,
            beforeState: windowDto(existing),
            afterState: windowDto(updated),
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
  // resolving affected orders" - enforced by assertNoActiveOrders()
  // above (Codex review round 1 on commit e12d77a added the
  // deliveryWindowId FK and this check; previously this comment noted
  // nothing could reference a window yet, which is no longer true - a
  // direct/seeded BranchOrder row can). This deletion is still
  // deliberately explicit and two-step (its own exceptions first, then
  // the window itself), never a DB cascade, so it stays exactly as
  // auditable/controlled as every other deletion in this codebase (e.g.
  // StoreSectionsController's own section delete).
  @Delete(':windowId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async remove(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('windowId') windowId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const existing = await this.requireWindow(vendorId, branchId, windowId);
    await this.assertNoActiveOrders(windowId);
    await this.prisma.$transaction(async (tx) => {
      await tx.deliveryWindowException.deleteMany({ where: { windowId } });
      await tx.deliveryWindow.delete({ where: { id: windowId } });
    });
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
      const created = await this.prisma.deliveryWindowException.create({
        data: {
          vendorId,
          windowId,
          exceptionDate: new Date(dto.exception_date),
          isClosed,
          capacityOverride: isClosed ? null : dto.capacity_override,
        },
      });
      await this.auditLog.record({
        actorId: user.id,
        correlationId: req.correlationId,
        action: 'delivery_window_exception.created',
        entityType: 'DeliveryWindowException',
        entityId: created.id,
        afterState: exceptionDto(created),
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
}
