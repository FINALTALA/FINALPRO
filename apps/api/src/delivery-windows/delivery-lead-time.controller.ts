import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
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
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateDeliveryLeadTimeDto } from './dto/update-delivery-lead-time.dto';

function leadTimeDto(minutes: number) {
  return { delivery_lead_minutes: minutes };
}

// PD-5.1: a branch's preparation time before a delivery window - a
// window closer than this is neither offered (product page, comparison,
// cart, checkout quote) nor bookable (reserve/reschedule), see
// delivery-calendar.util.ts. Read: any member of the vendor
// (VendorMembershipGuard keeps a branch employee to their own branch).
// Write: OWNER only, audited, refused while the store is suspended or
// the branch archived. Same locked read-compare-write-audit shape as
// BranchMinimumOrderController.
@Controller('vendors/:vendorId/branches/:branchId/delivery-lead-time')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class DeliveryLeadTimeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async get(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
      select: { vendorId: true, deliveryLeadMinutes: true },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    return leadTimeDto(branch.deliveryLeadMinutes);
  }

  @Put()
  @RequireVendorRole('OWNER')
  @BlockWhenSuspended()
  @BlockWhenBranchArchived()
  @UseInterceptors(IdempotencyInterceptor)
  async update(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDeliveryLeadTimeDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM store_branches WHERE id = ${branchId} FOR UPDATE`;
      const branch = await tx.storeBranch.findUnique({
        where: { id: branchId },
        select: { vendorId: true, deliveryLeadMinutes: true },
      });
      if (!branch || branch.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'BRANCH_NOT_FOUND',
          message: 'Branch not found for this vendor',
        });
      }
      const before = branch.deliveryLeadMinutes;
      const after = dto.delivery_lead_minutes;
      if (before === after) return leadTimeDto(before);
      await tx.storeBranch.update({
        where: { id: branchId },
        data: { deliveryLeadMinutes: after },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_branch.delivery_lead_time_updated',
          entityType: 'StoreBranch',
          entityId: branchId,
          beforeState: { delivery_lead_minutes: before },
          afterState: { delivery_lead_minutes: after },
        },
        tx,
      );
      return leadTimeDto(after);
    });
  }
}
