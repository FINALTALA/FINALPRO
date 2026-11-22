import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { BlockWhenBranchArchived } from '../auth/branch-archived.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentVendorMembership } from '../auth/current-vendor-membership.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import {
  VendorMembership,
  VendorMembershipGuard,
} from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { CreateStoreSaleDto, VoidStoreSaleDto } from './dto/store-pos.dto';
import { requireCashierEnabled } from './store-pos.flags';
import { StoreSalesService } from './store-sales.service';

/**
 * «بيع من المحل» - the cashier (owner, or the branch's own employee: the
 * membership guard refuses an employee any other branch's :branchId) and
 * «مبيعات المحل». A sale is a stock write: blocked while the store is
 * suspended or the branch archived, like every stock movement.
 */
@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StoreSalesController {
  constructor(
    private readonly sales: StoreSalesService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  /** The cashier screen's start: may this person sell, and at which branches (404 FEATURE_DISABLED while off). */
  @Get('cashier')
  async start(
    @Param('vendorId') vendorId: string,
    @CurrentVendorMembership() membership: VendorMembership,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.start(vendorId, membership, user.id);
  }

  /** ?code= - a scanned or typed code (a product barcode, or a legacy SIB- label). */
  @BlockWhenBranchArchived()
  @Get('branches/:branchId/cashier/lookup')
  async lookup(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query('code') code?: string,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.lookup(vendorId, branchId, code);
  }

  @BlockWhenSuspended()
  @BlockWhenBranchArchived()
  @Post('branches/:branchId/store-sales')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Body() dto: CreateStoreSaleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.create(
      vendorId,
      branchId,
      dto,
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
    );
  }

  /** ?branch_id=&from=YYYY-MM-DD&to=YYYY-MM-DD&status=&cursor=&limit= (an employee: own branch only). */
  @Get('store-sales')
  async list(
    @Param('vendorId') vendorId: string,
    @CurrentVendorMembership() membership: VendorMembership,
    @Query('branch_id') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.list(vendorId, membership, {
      branch_id: branchId,
      from,
      to,
      status,
      cursor,
      limit,
    });
  }

  @Get('store-sales/:saleId')
  async get(
    @Param('vendorId') vendorId: string,
    @Param('saleId') saleId: string,
    @CurrentVendorMembership() membership: VendorMembership,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.get(vendorId, membership, saleId);
  }

  /** The owner cancels a WHOLE sale, on its own day, with a reason. */
  @BlockWhenSuspended()
  @RequireVendorRole('OWNER')
  @Post('store-sales/:saleId/void')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async void(
    @Param('vendorId') vendorId: string,
    @Param('saleId') saleId: string,
    @Body() dto: VoidStoreSaleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.sales.void(
      vendorId,
      saleId,
      dto.reason,
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
    );
  }
}
