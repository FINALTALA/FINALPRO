import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from './current-user.decorator';
import {
  countUnread,
  InboxScope,
  listInbox,
  markRead,
  platformScope,
  storeScope,
} from './notification-inbox';
import { PlatformRoleGuard } from './platform-role.guard';
import { RequirePlatformRole } from './platform-role.decorator';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import { VendorMembershipGuard } from './vendor-membership.guard';

/**
 * TB-26: «إشعاراتي» inside a store workspace - STORE notifications of
 * this store only (an employee: their own branch only). The membership,
 * its role and branch come from VendorMembershipGuard (read fresh on
 * every request), never from the client.
 */
@Controller('vendors/:vendorId/notifications')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorNotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  private scope(user: AuthenticatedUser, req: Request): InboxScope {
    return storeScope(user.id, req.vendorMembership!);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return listInbox(this.prisma, this.scope(user, req), {
      cursor,
      limit,
      unreadOnly,
    });
  }

  @Get('unread-count')
  async unreadCount(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return countUnread(this.prisma, this.scope(user, req));
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return markRead(this.prisma, this.scope(user, req), id);
  }
}

/**
 * TB-26: «إشعاراتي» inside the platform workspace - PLATFORM
 * notifications only, for an active PLATFORM_ADMIN.
 */
@Controller('admin/notifications')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminNotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  /** A deactivated account sees none (the role guard reads the role
   * only) - same as TB-14's rule for platform alerts. */
  private async scope(user: AuthenticatedUser): Promise<InboxScope> {
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { deactivatedAt: true },
    });
    if (!u || u.deactivatedAt) return { id: { in: [] } };
    return platformScope(user.id);
  }

  @Get()
  @RequirePlatformRole('PLATFORM_ADMIN')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return listInbox(this.prisma, await this.scope(user), {
      cursor,
      limit,
      unreadOnly,
    });
  }

  @Get('unread-count')
  @RequirePlatformRole('PLATFORM_ADMIN')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return countUnread(this.prisma, await this.scope(user));
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePlatformRole('PLATFORM_ADMIN')
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return markRead(this.prisma, await this.scope(user), id);
  }
}
