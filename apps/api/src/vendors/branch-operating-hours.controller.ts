import {
  BadRequestException,
  Body,
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
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBranchOperatingHoursDto } from './dto/update-branch-operating-hours.dto';

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

// Sprint 18b (FR-VEND-006/FR-VPORTAL-009, informational only - product
// decision): never read by checkout/reserve - see
// branch-operating-hours.util.ts's own comment. No @BlockWhenSuspended
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
      orderBy: { dayOfWeek: 'asc' },
    });
    return { hours: rows.map(hoursDto) };
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

    const days = dto.hours.map((h) => h.day_of_week);
    if (new Set(days).size !== days.length) {
      throw new BadRequestException({
        code: 'DUPLICATE_DAY_OF_WEEK',
        message: 'Each day_of_week may only appear once',
      });
    }
    for (const h of dto.hours) {
      if (h.open_minute >= h.close_minute) {
        throw new BadRequestException({
          code: 'INVALID_HOURS_RANGE',
          message: 'open_minute must be less than close_minute',
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.branchOperatingHours.findMany({
        where: { vendorId, branchId },
        orderBy: { dayOfWeek: 'asc' },
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
        orderBy: { dayOfWeek: 'asc' },
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
    });
    return { hours: result.map(hoursDto) };
  }
}
