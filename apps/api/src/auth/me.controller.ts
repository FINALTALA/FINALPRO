import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, SessionAuthGuard } from './session-auth.guard';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { Prisma } from '../../generated/prisma/client';
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

  // Sprint 19 (FR-NOTIF-008, G-NO-02): self-scoped only, exactly like
  // workspaces() above - a user listing/reading/marking only their own
  // Notification rows can never be a BOLA vector, so no extra guard is
  // needed beyond SessionAuthGuard. `data` is already the safe,
  // whitelisted structural fields OutboxRelayService's own
  // buildSafeData() produced - never anything beyond that passes
  // through this far. Opaque keyset cursor on (createdAt, id) DESC,
  // matching cursor.util.ts's own established convention; default
  // 20/max 100 (SRS-H1-10).
  @Get('notifications')
  async listNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    const limit = parseLimit(limitRaw, 100);
    const cursorParts = decodeCursor(cursor, [isIsoDateString, isUuidLike]);

    const where: Prisma.NotificationWhereInput = {
      recipientUserId: user.id,
      ...(unreadOnly === 'true' ? { readAt: null } : {}),
      ...(cursorParts
        ? {
            OR: [
              { createdAt: { lt: new Date(cursorParts[0] as string) } },
              {
                createdAt: new Date(cursorParts[0] as string),
                id: { lt: cursorParts[1] as string },
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((n) => ({
        id: n.id,
        type: n.type,
        data: n.data,
        target_type: n.targetType,
        target_id: n.targetId,
        vendor_id: n.vendorId,
        branch_id: n.branchId,
        read_at: n.readAt?.toISOString() ?? null,
        created_at: n.createdAt.toISOString(),
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  @Get('notifications/unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    const count = await this.prisma.notification.count({
      where: { recipientUserId: user.id, readAt: null },
    });
    return { unread_count: count };
  }

  // Idempotent: marking an already-read notification read again is a
  // benign no-op, not an error - only a notification that does not
  // belong to this user 404s (BOLA: existence is never confirmed or
  // denied to a non-owner, same convention every other cross-tenant
  // lookup in this codebase already uses).
  @Post('notifications/:id/read')
  @HttpCode(200)
  async markNotificationRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const result = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const existing = await this.prisma.notification.findUnique({
        where: { id },
        select: { recipientUserId: true },
      });
      if (!existing || existing.recipientUserId !== user.id) {
        throw new NotFoundException({
          code: 'NOTIFICATION_NOT_FOUND',
          message: 'Notification not found',
        });
      }
      // Belongs to this user, already read - idempotent no-op.
    }
    return { id, read: true };
  }
}
