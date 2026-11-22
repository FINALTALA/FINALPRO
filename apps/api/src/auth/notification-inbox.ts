import { NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma } from '../../generated/prisma/client';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { VendorMembership } from './vendor-membership.guard';

/**
 * TB-26: the notifications one context may see. List, unread count and
 * mark-read all use the SAME scope, so a notification of another context
 * is never listed, never counted and cannot be marked read by its id
 * (404, exactly like someone else's notification).
 *
 *  - shopping bell: CUSTOMER rows of the user;
 *  - store workspace, owner: STORE rows of the user for that store;
 *  - store workspace, employee: STORE rows of the user for that store and
 *    their own branch, plus the store-wide types listed in
 *    EMPLOYEE_STORE_WIDE_TYPES (none today - the store suspended /
 *    reactivated notices go to owners only);
 *  - platform workspace: PLATFORM rows of the user (an active
 *    PLATFORM_ADMIN only).
 */
export const EMPLOYEE_STORE_WIDE_TYPES: NotificationType[] = [];

export type InboxScope = Prisma.NotificationWhereInput;

export function customerScope(userId: string): InboxScope {
  return { recipientUserId: userId, audience: 'CUSTOMER' };
}

export function storeScope(
  userId: string,
  membership: VendorMembership,
): InboxScope {
  const base: InboxScope = {
    recipientUserId: userId,
    audience: 'STORE',
    vendorId: membership.vendorId,
  };
  if (membership.role === 'OWNER') return base;
  if (!membership.branchId) return { ...base, id: { in: [] } };
  return {
    ...base,
    OR: [
      { branchId: membership.branchId },
      { branchId: null, type: { in: EMPLOYEE_STORE_WIDE_TYPES } },
    ],
  };
}

export function platformScope(userId: string): InboxScope {
  return { recipientUserId: userId, audience: 'PLATFORM' };
}

export async function listInbox(
  prisma: PrismaService,
  scope: InboxScope,
  query: { cursor?: string; limit?: string; unreadOnly?: string },
) {
  const limit = parseLimit(query.limit, 100);
  const cursorParts = decodeCursor(query.cursor, [isIsoDateString, isUuidLike]);
  const where: Prisma.NotificationWhereInput = {
    AND: [
      scope,
      query.unreadOnly === 'true' ? { readAt: null } : {},
      cursorParts
        ? {
            OR: [
              { createdAt: { lt: new Date(cursorParts[0] as string) } },
              {
                createdAt: new Date(cursorParts[0] as string),
                id: { lt: cursorParts[1] as string },
              },
            ],
          }
        : {},
    ],
  };
  const rows = await prisma.notification.findMany({
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
      audience: n.audience,
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

export async function countUnread(prisma: PrismaService, scope: InboxScope) {
  const count = await prisma.notification.count({
    where: { AND: [scope, { readAt: null }] },
  });
  return { unread_count: count };
}

/** Idempotent for a row in scope; 404 for anything outside it. */
export async function markRead(
  prisma: PrismaService,
  scope: InboxScope,
  id: string,
) {
  const inScope: Prisma.NotificationWhereInput = { AND: [scope, { id }] };
  const result = await prisma.notification.updateMany({
    where: { AND: [inScope, { readAt: null }] },
    data: { readAt: new Date() },
  });
  if (result.count === 0) {
    const existing = await prisma.notification.findFirst({
      where: inScope,
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }
  }
  return { id, read: true };
}
