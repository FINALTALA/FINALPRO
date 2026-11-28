import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import {
  AdminOrderListQuery,
  AdminOrdersService,
} from './admin-orders.service';

/**
 * VIA phase 2D - Admin Orders (read-only). The actions stay where they
 * are: POST admin/branch-orders/:id/cancel and admin/returns.
 */
@Controller('admin/orders')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('vendor_id') vendorId?: string,
    @Query('fulfilment') fulfilment?: string,
    @Query('payment') payment?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('flag') flag?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const query: AdminOrderListQuery = {
      q,
      status,
      vendorId,
      fulfilment,
      payment,
      from,
      to,
      flag,
      cursor,
      limit,
    };
    return this.orders.list(query);
  }

  @Get(':branchOrderId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.detail(branchOrderId, user.id);
  }
}
