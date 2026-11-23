import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
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
import { BlockWhenBranchArchived } from '../auth/branch-archived.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { Prisma } from '../../generated/prisma/client';
import { loadOpeningStates } from '../common/branch-opening.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  HOURS_STEP_MINUTES,
  UpdateBranchOperatingHoursDto,
} from './dto/update-branch-operating-hours.dto';

const HOURS_ORDER = [
  { dayOfWeek: 'asc' as const },
  { openMinute: 'asc' as const },
];

function isExclusionViolation(err: unknown, constraintName: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2039' &&
    err.message.includes(constraintName)
  );
}

function hoursDto(row: {
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}) {
  return {
    day_of_week: row.dayOfWeek,
    open_minute: row.openMinute,
    close_minute: row.closeMinute,
  };
}

// Sprint 18b (FR-VEND-006/FR-VPORTAL-009) + «ساعات العمل والإغلاقات v1»:
// informational only - never read by checkout/reserve to refuse anything
// (see common/branch-opening.util.ts). GET is open to the branch's own
// employee (read-only tab); PUT is OWNER-only. No @BlockWhenSuspended
// on either route - "store configuration, staff and delivery setup"
// is already the established ALLOW category for a suspended vendor
// (vendor-route-classification.ts), and hours fit that exactly.
@Controller('vendors/:vendorId/branches/:branchId/operating-hours')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchOperatingHoursController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

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

  @Get()
  async getHours(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    await this.requireBranch(vendorId, branchId);
    const rows = await this.prisma.branchOperatingHours.findMany({
      where: { vendorId, branchId },
      orderBy: HOURS_ORDER,
    });
    // the live summary ("الآن: مفتوح حتى ... · يفتح مجدداً ...") - the same
    // rule the storefront uses, closures included
    const opening = (await loadOpeningStates(this.prisma, [branchId])).get(
      branchId,
    )!;
    return {
      hours: rows.map(hoursDto),
      opening: {
        open_now: opening.open_now,
        open_until: opening.open_until,
        next_open_at: opening.next_open_at,
      },
    };
  }

  // PUT replaces the whole week in one call - simplest correct
  // approach for a small, bounded 0-7 row set (a settings form the
  // owner edits all at once), rather than per-day CRUD.
  @Put()
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  async updateHours(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBranchOperatingHoursDto,
    @Req() req: Request,
  ) {
    await this.requireBranch(vendorId, branchId);

    for (const h of dto.hours) {
      if (h.open_minute >= h.close_minute) {
        throw new BadRequestException({
          code: 'INVALID_HOURS_RANGE',
          message: 'open_minute must be less than close_minute',
        });
      }
      if (
        h.open_minute % HOURS_STEP_MINUTES !== 0 ||
        h.close_minute % HOURS_STEP_MINUTES !== 0
      ) {
        throw new BadRequestException({
          code: 'INVALID_HOURS_STEP',
          message: `Times must be on a ${HOURS_STEP_MINUTES}-minute step`,
        });
      }
    }
    // same-day periods never overlap (touching is fine: [open, close))
    const sorted = [...dto.hours].sort(
      (a, b) => a.day_of_week - b.day_of_week || a.open_minute - b.open_minute,
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (
        prev.day_of_week === cur.day_of_week &&
        cur.open_minute < prev.close_minute
      ) {
        throw new BadRequestException({
          code: 'OVERLAPPING_PERIODS',
          message: 'Periods of the same day must not overlap',
          details: { day_of_week: cur.day_of_week },
        });
      }
    }

    const result = await this.prisma
      .$transaction(async (tx) => {
        const before = await tx.branchOperatingHours.findMany({
          where: { vendorId, branchId },
          orderBy: HOURS_ORDER,
        });
        await tx.branchOperatingHours.deleteMany({
          where: { vendorId, branchId },
        });
        if (dto.hours.length > 0) {
          await tx.branchOperatingHours.createMany({
            data: dto.hours.map((h) => ({
              vendorId,
              branchId,
              dayOfWeek: h.day_of_week,
              openMinute: h.open_minute,
              closeMinute: h.close_minute,
            })),
          });
        }
        const after = await tx.branchOperatingHours.findMany({
          where: { vendorId, branchId },
          orderBy: HOURS_ORDER,
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'store_branch.operating_hours_updated',
            entityType: 'StoreBranch',
            entityId: branchId,
            beforeState: { hours: before.map(hoursDto) },
            afterState: { hours: after.map(hoursDto) },
          },
          tx,
        );
        return after;
      })
      .catch((err: unknown) => {
        // a concurrent PUT slipped past the check above
        if (isExclusionViolation(err, 'branch_operating_hours_no_overlap')) {
          throw new ConflictException({
            code: 'OVERLAPPING_PERIODS',
            message: 'Periods of the same day must not overlap',
          });
        }
        throw err;
      });
    return { hours: result.map(hoursDto) };
  }
}
