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
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { BlockWhenBranchArchived } from '../auth/branch-archived.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMinimumOrderValueDto } from './dto/update-minimum-order-value.dto';

function minimumOrderValueDto(value: unknown) {
  return { minimum_order_value: value != null ? Number(value) : null };
}

// Sprint 20b (FR-PRICE-006, FR-CART-003): the owner's own minimum
// order value for PICKUP at this branch, and the FALLBACK for a
// DELIVERY order whose destination zone has no override of its own -
// see DeliveryZoneMinimumOrderController's own comment for that half.
// Checked against the items-only subtotal of a branch-group at
// checkout, never delivery fee or any future tax/fee.
@Controller('vendors/:vendorId/branches/:branchId/minimum-order')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchMinimumOrderController {
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
    return branch;
  }

  @Get()
  async get(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    const branch = await this.requireBranch(vendorId, branchId);
    return minimumOrderValueDto(branch.minimumOrderValue);
  }

  // Idempotency-Key required (review-round convention, S20a): a
  // network retry of the exact same value must never write a second
  // AuditLog row. AuditLog itself is written only when the value
  // actually changes - a second genuine call with the SAME value
  // (different Idempotency-Key, not a replay) is a harmless no-op,
  // never spamming the audit trail either.
  @Put()
  @RequireVendorRole('OWNER')
  @BlockWhenBranchArchived()
  @UseInterceptors(IdempotencyInterceptor)
  async update(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMinimumOrderValueDto,
    @Req() req: Request,
  ) {
    const branch = await this.requireBranch(vendorId, branchId);
    const before =
      branch.minimumOrderValue != null
        ? Number(branch.minimumOrderValue)
        : null;
    const after = dto.minimum_order_value;

    if (before === after) {
      return minimumOrderValueDto(branch.minimumOrderValue);
    }

    const updated = await this.prisma.storeBranch.update({
      where: { id: branchId },
      data: { minimumOrderValue: dto.minimum_order_value },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_branch.minimum_order_value_updated',
      entityType: 'StoreBranch',
      entityId: branchId,
      beforeState: { minimum_order_value: before },
      afterState: { minimum_order_value: after },
    });
    return minimumOrderValueDto(updated.minimumOrderValue);
  }
}
