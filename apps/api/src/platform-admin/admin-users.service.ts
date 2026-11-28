import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRole, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';
import { lockVendorRowsSorted } from '../common/customer-account-lock.util';
import { maskPhone } from './admin-orders.service';

/**
 * VIA phase 3 - Users Management and the platform team, for PLATFORM_ADMIN.
 *
 * Reuses what exists: sessions die through User.sessionVersion (checked by
 * SessionAuthGuard on every request) plus SessionService.revokeAllForUser;
 * every action is an AuditLog row. The one new piece of state is the
 * platform suspension (User.suspendedAt/suspensionReason/suspendedById),
 * deliberately separate from the user's own deactivation.
 *
 * Rules:
 *  - PLATFORM_ADMIN accounts are protected: never suspended or signed out
 *    from here (the two equal administrators cannot lock each other out,
 *    nor themselves). Roles are never changed here.
 *  - store memberships are never changed; suspending the owner of an
 *    ACTIVE store needs an explicit confirmation;
 *  - lifting a suspension never lifts the user's own deactivation;
 *  - phones are masked in every response.
 */

export const ADMIN_USERS_PAGE_MAX = 50;
const AUDIT_LIMIT = 30;
const RECENT_ORDERS = 10;

export const USER_SUSPENDED_ACTION = 'user.suspended_by_platform';
export const USER_SUSPENSION_LIFTED_ACTION = 'user.suspension_lifted';
export const USER_SESSIONS_REVOKED_ACTION = 'user.sessions_revoked_by_platform';

export interface AdminUserListQuery {
  q?: string;
  role?: string;
  status?: string;
  cursor?: string;
  limit?: string;
}

type UserState = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
const stateOf = (u: {
  suspendedAt: Date | null;
  deactivatedAt: Date | null;
}): UserState =>
  u.suspendedAt ? 'SUSPENDED' : u.deactivatedAt ? 'DEACTIVATED' : 'ACTIVE';

const ROLES = [
  'customer',
  'store_owner',
  'store_employee',
  'PLATFORM_ADMIN',
  'VERIFICATION_REVIEWER',
] as const;
const STATES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;

function bad(message: string, code = 'INVALID_FILTER'): never {
  throw new BadRequestException({ code, message });
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sessions: SessionService,
  ) {}

  // ------------------------------------------------------------------
  // Reads

  async list(query: AdminUserListQuery) {
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? '25', 10) || 25, 1),
      ADMIN_USERS_PAGE_MAX,
    );
    const role =
      query.role && query.role !== 'all'
        ? (ROLES as readonly string[]).includes(query.role)
          ? query.role
          : bad('Unknown role')
        : undefined;
    const status =
      query.status && query.status !== 'all'
        ? (STATES as readonly string[]).includes(query.status)
          ? query.status
          : bad('Unknown status')
        : undefined;

    const and: Prisma.UserWhereInput[] = [];
    if (role === 'PLATFORM_ADMIN' || role === 'VERIFICATION_REVIEWER')
      and.push({ platformRole: role });
    if (role === 'customer')
      and.push({ platformRole: null, vendorUsers: { none: {} } });
    if (role === 'store_owner')
      and.push({ vendorUsers: { some: { role: 'OWNER' } } });
    if (role === 'store_employee')
      and.push({ vendorUsers: { some: { role: 'BRANCH_EMPLOYEE' } } });
    if (status === 'SUSPENDED') and.push({ suspendedAt: { not: null } });
    if (status === 'DEACTIVATED')
      and.push({ suspendedAt: null, deactivatedAt: { not: null } });
    if (status === 'ACTIVE')
      and.push({ suspendedAt: null, deactivatedAt: null });

    const q = query.q?.trim();
    if (q) {
      const digits = q.replace(/[^\d]/g, '');
      and.push({
        OR: [
          {
            customerProfile: {
              displayName: { contains: q, mode: 'insensitive' },
            },
          },
          // A phone is searched by its digits (at least 4), never shown whole.
          ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
          ...(/^[0-9a-f-]{8,36}$/i.test(q)
            ? [{ id: { startsWith: q.toLowerCase() } }]
            : []),
        ],
      });
    }
    if (query.cursor) {
      let c: { t: string; id: string };
      try {
        c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (typeof c.t !== 'string' || typeof c.id !== 'string')
          throw new Error();
      } catch {
        bad('Invalid cursor', 'INVALID_CURSOR');
      }
      const t = new Date(c.t);
      and.push({
        OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: c.id } }],
      });
    }

    const rows = await this.prisma.user.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        phone: true,
        platformRole: true,
        createdAt: true,
        suspendedAt: true,
        deactivatedAt: true,
        customerProfile: { select: { displayName: true } },
        vendorUsers: { select: { role: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((u) => ({
        id: u.id,
        display_name: u.customerProfile?.displayName ?? null,
        phone_masked: maskPhone(u.phone),
        platform_role: u.platformRole,
        status: stateOf(u),
        store_roles: [...new Set(u.vendorUsers.map((m) => m.role))],
        created_at: u.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ t: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  async detail(userId: string, viewerId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        platformRole: true,
        languagePref: true,
        phoneVerifiedAt: true,
        createdAt: true,
        deactivatedAt: true,
        suspendedAt: true,
        suspensionReason: true,
        suspendedById: true,
        customerProfile: {
          select: {
            id: true,
            displayName: true,
            _count: { select: { orders: true, reviews: true } },
          },
        },
        vendorUsers: {
          orderBy: { vendor: { displayName: 'asc' } },
          select: {
            role: true,
            status: true,
            branch: { select: { name: true } },
            vendor: {
              select: { id: true, displayName: true, status: true },
            },
          },
        },
      },
    });
    if (!u) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    const audit = await this.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: u.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_LIMIT,
      select: {
        id: true,
        action: true,
        actorId: true,
        occurredAt: true,
        actor: { select: { platformRole: true } },
      },
    });
    const isProtected = u.platformRole === PlatformRole.PLATFORM_ADMIN;
    const isSelf = u.id === viewerId;
    // The stores this account is the only enabled owner of (the suspend
    // action re-checks this under lock; this is for the screen).
    const soleOwnerOf: { store_id: string; store_name: string }[] = [];
    for (const m of u.vendorUsers) {
      if (
        m.role !== 'OWNER' ||
        m.status !== 'ACTIVE' ||
        m.vendor.status === 'CANCELLED'
      )
        continue;
      const others = await this.prisma.vendorUser.count({
        where: {
          vendorId: m.vendor.id,
          role: 'OWNER',
          status: 'ACTIVE',
          userId: { not: u.id },
          user: { deactivatedAt: null, suspendedAt: null },
        },
      });
      if (others === 0)
        soleOwnerOf.push({
          store_id: m.vendor.id,
          store_name: m.vendor.displayName,
        });
    }
    // Their own purchases (as a customer) - distinct from store work.
    const recentOrders = u.customerProfile
      ? await this.prisma.branchOrder.findMany({
          where: { customerOrder: { customerId: u.customerProfile.id } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: RECENT_ORDERS,
          select: {
            id: true,
            customerOrderId: true,
            status: true,
            total: true,
            createdAt: true,
            vendor: { select: { displayName: true } },
          },
        })
      : [];
    return {
      id: u.id,
      display_name: u.customerProfile?.displayName ?? null,
      phone_masked: maskPhone(u.phone),
      phone_verified: u.phoneVerifiedAt !== null,
      language: u.languagePref,
      platform_role: u.platformRole,
      status: stateOf(u),
      created_at: u.createdAt.toISOString(),
      deactivated_at: u.deactivatedAt?.toISOString() ?? null,
      suspension: u.suspendedAt
        ? {
            at: u.suspendedAt.toISOString(),
            reason: u.suspensionReason,
            by_self: u.suspendedById === viewerId,
          }
        : null,
      counts: {
        orders: u.customerProfile?._count.orders ?? 0,
        reviews: u.customerProfile?._count.reviews ?? 0,
      },
      memberships: u.vendorUsers.map((m) => ({
        store_id: m.vendor.id,
        store_name: m.vendor.displayName,
        store_status: m.vendor.status,
        role: m.role,
        status: m.status,
        branch_name: m.branch?.name ?? null,
      })),
      recent_orders: recentOrders.map((o) => ({
        id: o.id,
        number: o.id.slice(0, 8).toUpperCase(),
        customer_order_id: o.customerOrderId,
        status: o.status,
        total: Number(o.total),
        store_name: o.vendor.displayName,
        created_at: o.createdAt.toISOString(),
      })),
      history: audit.map((a) => ({
        id: a.id,
        action: a.action,
        at: a.occurredAt.toISOString(),
        actor:
          a.actorId === null
            ? 'SYSTEM'
            : a.actorId === u.id
              ? 'SELF'
              : a.actor?.platformRole
                ? 'PLATFORM'
                : 'OTHER',
      })),
      actions: {
        protected: isProtected,
        is_self: isSelf,
        sole_owner_of: soleOwnerOf,
        can_suspend: !isProtected && !u.suspendedAt && soleOwnerOf.length === 0,
        can_lift: !isProtected && u.suspendedAt !== null,
        can_force_sign_out: !isProtected,
      },
    };
  }

  /** The platform team: every account with a platform role (read-only - roles are not edited here). */
  async team() {
    const rows = await this.prisma.user.findMany({
      where: { platformRole: { not: null } },
      orderBy: [{ platformRole: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        phone: true,
        platformRole: true,
        createdAt: true,
        suspendedAt: true,
        deactivatedAt: true,
        customerProfile: { select: { displayName: true } },
        _count: { select: { vendorUsers: true } },
      },
    });
    return {
      members: rows.map((u) => ({
        id: u.id,
        display_name: u.customerProfile?.displayName ?? null,
        phone_masked: maskPhone(u.phone),
        platform_role: u.platformRole,
        status: stateOf(u),
        store_memberships: u._count.vendorUsers,
        created_at: u.createdAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------
  // Actions (each: the target row locked, re-checked, audited)

  async suspend(
    actorId: string,
    userId: string,
    reason: string,
    correlationId: string | undefined,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Lock order = the self-deactivation's own (customers.controller):
      // User -> every owned Vendor (sorted) -> decide -> write. So this
      // and a co-owner's suspension or deactivation serialize per store.
      const u = await this.lockTarget(tx, userId);
      if (u.suspendedAt) {
        throw new ConflictException({
          code: 'ALREADY_SUSPENDED',
          message: 'This account is already suspended',
        });
      }
      const ownedVendorIds = (
        await tx.vendorUser.findMany({
          where: { userId, role: 'OWNER', status: 'ACTIVE' },
          select: { vendorId: true },
        })
      ).map((m) => m.vendorId);
      const ownedStores: string[] = [];
      if (ownedVendorIds.length > 0) {
        await lockVendorRowsSorted(tx, ownedVendorIds);
        const soleOwnerOf: { store_id: string; store_name: string }[] = [];
        for (const vendorId of ownedVendorIds) {
          const vendor = await tx.vendor.findUniqueOrThrow({
            where: { id: vendorId },
            select: { id: true, displayName: true, status: true },
          });
          if (vendor.status === 'CANCELLED') continue;
          ownedStores.push(vendor.id);
          // Re-read under the vendor lock: the other ENABLED owners -
          // an ACTIVE owner membership of an account neither deactivated
          // by its holder nor suspended by the platform.
          const others = await tx.vendorUser.count({
            where: {
              vendorId,
              role: 'OWNER',
              status: 'ACTIVE',
              userId: { not: userId },
              user: { deactivatedAt: null, suspendedAt: null },
            },
          });
          if (others === 0) {
            soleOwnerOf.push({
              store_id: vendor.id,
              store_name: vendor.displayName,
            });
          }
        }
        if (soleOwnerOf.length > 0) {
          throw new ConflictException({
            code: 'SOLE_STORE_OWNER',
            message:
              'This account is the only enabled owner of a store that is not cancelled',
            details: soleOwnerOf,
          });
        }
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          suspendedAt: new Date(),
          suspensionReason: reason,
          suspendedById: actorId,
          sessionVersion: { increment: 1 },
        },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: USER_SUSPENDED_ACTION,
          entityType: 'User',
          entityId: userId,
          afterState: {
            reason,
            owned_stores: ownedStores,
          },
        },
        tx,
      );
    });
    await this.revokeSessions(userId);
    return { id: userId, status: 'SUSPENDED' as const };
  }

  async lift(
    actorId: string,
    userId: string,
    note: string,
    correlationId: string | undefined,
  ) {
    const status = await this.prisma.$transaction(async (tx) => {
      const u = await this.lockTarget(tx, userId);
      if (!u.suspendedAt) {
        throw new ConflictException({
          code: 'NOT_SUSPENDED',
          message: 'This account is not suspended',
        });
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          suspendedAt: null,
          suspensionReason: null,
          suspendedById: null,
        },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: USER_SUSPENSION_LIFTED_ACTION,
          entityType: 'User',
          entityId: userId,
          beforeState: {
            suspended_at: u.suspendedAt.toISOString(),
            reason: u.suspensionReason,
          },
          afterState: { note },
        },
        tx,
      );
      // The user's own deactivation, if any, stays.
      return stateOf({ suspendedAt: null, deactivatedAt: u.deactivatedAt });
    });
    return { id: userId, status };
  }

  async forceSignOut(
    actorId: string,
    userId: string,
    reason: string,
    correlationId: string | undefined,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTarget(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: USER_SESSIONS_REVOKED_ACTION,
          entityType: 'User',
          entityId: userId,
          afterState: { reason },
        },
        tx,
      );
    });
    await this.revokeSessions(userId);
    return { id: userId, signed_out: true };
  }

  /** Locks the target account and refuses a protected one. */
  private async lockTarget(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    const u = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        platformRole: true,
        suspendedAt: true,
        suspensionReason: true,
        deactivatedAt: true,
      },
    });
    if (u.platformRole === PlatformRole.PLATFORM_ADMIN) {
      throw new ForbiddenException({
        code: 'PROTECTED_ACCOUNT',
        message: 'Platform administrator accounts are protected',
      });
    }
    return u;
  }

  /**
   * The Redis keys too (best effort): the sessionVersion bump committed
   * above is what actually ends every session, on the very next request.
   */
  private async revokeSessions(userId: string) {
    try {
      await this.sessions.revokeAllForUser(userId);
    } catch (err) {
      this.logger.warn(
        `Sessions of ${userId} not removed from Redis (already invalid by sessionVersion): ${(err as Error).message}`,
      );
    }
  }
}
