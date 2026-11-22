import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import {
  countUnread,
  customerScope,
  listInbox,
  markRead,
} from './notification-inbox';
import { WorkspaceNeutral } from './workspace-session';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sprint 4 (RB-ROLE-005, PDR-008): the workspace/role switcher's data
 * source - "one account may be a customer and also hold store-owner or
 * branch-employee roles." Every authenticated user always has an
 * implicit `customer` workspace (no self-service way to lose that);
 * each `VendorUser` row they hold adds one more entry. Deliberately
 * read-only and self-scoped only (no `:vendorId` param) - it needs no
 * `VendorMembershipGuard`, since a user listing their own memberships
 * can never be a BOLA vector.
 */
@Controller('me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('workspaces')
  @WorkspaceNeutral()
  async workspaces(@CurrentUser() user: AuthenticatedUser) {
    const memberships = await this.prisma.vendorUser.findMany({
      where: { userId: user.id },
      include: { vendor: true, branch: true },
    });
    // Sprint 16: platform staff get one extra, read-only entry so the web
    // app can show the admin workspace. Self-scoped like the rest of this
    // endpoint; a user with no platform role gets no such entry.
    const self = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { platformRole: true },
    });

    return {
      workspaces: [
        { type: 'customer' as const },
        ...(self?.platformRole
          ? [{ type: 'platform' as const, role: self.platformRole }]
          : []),
        ...memberships.map((m) => ({
          type: 'vendor' as const,
          vendor_id: m.vendorId,
          vendor_legal_name: m.vendor.legalName,
          // This is a public identifier, not a management capability. It
          // lets an employee enter the store's customer-facing page first;
          // their branch tools remain available only through their own
          // authenticated workspace and guards.
          storefront_slug: m.vendor.slug,
          role: m.role,
          branch_id: m.branchId,
          branch_name: m.branch?.name ?? null,
          // Sprint 18b (G-IN-05): a suspended membership is NOT hidden
          // from this list - the person needs to know why their
          // branch workspace no longer works. The web app renders this
          // one as a disabled card with the reason, never a normal
          // actionable link (product decision) - every actual route
          // for this vendor still refuses it server-side regardless
          // (VendorMembershipGuard), this is UX only.
          status: m.status,
        })),
      ],
    };
  }

  // Sprint 19 (FR-NOTIF-008, G-NO-02): self-scoped only - a user
  // listing/reading/marking only their own Notification rows can never be
  // a BOLA vector. `data` is already the safe, whitelisted structural
  // fields OutboxRelayService's own buildSafeData() produced. Opaque
  // keyset cursor on (createdAt, id) DESC; default 20/max 100.
  //
  // TB-26: this is the SHOPPING bell: it lists, counts and marks CUSTOMER
  // notifications only - store notifications are read in the store
  // workspace (GET /vendors/:vendorId/notifications) and platform alerts
  // in the platform workspace (GET /admin/notifications).
  //
  // Always - NOT behind workspace_scoping_enabled. (The flag-off fallback
  // that returned every notification of the user here was the cause of a
  // STORE «المخزون منخفض» showing in an owner's shopping bell on a
  // database where the flag was never switched on. The store and platform
  // inboxes never depended on the flag; the flag still gates only the
  // workspace-token requirement of store and platform routes.)
  @Get('notifications')
  async listNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return listInbox(this.prisma, this.bellScope(user.id), {
      cursor,
      limit,
      unreadOnly,
    });
  }

  @Get('notifications/unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return countUnread(this.prisma, this.bellScope(user.id));
  }

  // Idempotent: marking an already-read notification read again is a
  // benign no-op; a notification outside this bell's scope (someone
  // else's, or another context's) 404s - existence is never confirmed.
  @Post('notifications/:id/read')
  @HttpCode(200)
  async markNotificationRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return markRead(this.prisma, this.bellScope(user.id), id);
  }

  private bellScope(userId: string) {
    return customerScope(userId);
  }
}
