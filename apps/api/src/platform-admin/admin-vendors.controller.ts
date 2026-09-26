import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PlatformRole,
  Prisma,
  VendorStatus,
} from '../../generated/prisma/client';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';
import {
  ReactivateVendorDto,
  SuspendVendorDto,
} from './dto/vendor-suspension.dto';
import { assertNoPlatformVendorConflict } from './vendor-conflict.util';

const VENDOR_STATUSES = Object.values(VendorStatus) as string[];

function suspensionDto(s: {
  id: string;
  vendorId: string;
  reasonCode: string;
  reason: string;
  suspendedBy: string;
  suspendedAt: Date;
  reactivatedBy: string | null;
  reactivatedAt: Date | null;
  reactivationReason: string | null;
}) {
  return {
    id: s.id,
    vendor_id: s.vendorId,
    reason_code: s.reasonCode,
    reason: s.reason,
    suspended_by: s.suspendedBy,
    suspended_at: s.suspendedAt.toISOString(),
    reactivated_by: s.reactivatedBy,
    reactivated_at: s.reactivatedAt?.toISOString() ?? null,
    reactivation_reason: s.reactivationReason,
  };
}

// Sprint 16 (FR-VEND-009, G-AD-02): the platform ADMIN's vendor list,
// detail and suspend/reactivate. PLATFORM_ADMIN only - a
// VERIFICATION_REVIEWER decides evidence but never suspends a store.
//
// Suspension is an explicit admin action with a captured reason
// (BR-017 second sentence); nothing here suspends automatically. It
// changes ONLY vendor.status (ACTIVE <-> SUSPENDED): every public
// surface, the cart and checkout already gate on status === 'ACTIVE',
// and order-fulfilment routes never look at it, so in-flight orders
// keep moving (L-23). Catalog-mutating vendor routes are blocked by
// @BlockWhenSuspended (see vendor-route-classification.ts).
@Controller('admin/vendors')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminVendorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  // Order: created_at, then id, ascending. Opaque keyset cursor.
  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') statusRaw?: string,
    @Query('q') qRaw?: string,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (statusRaw !== undefined && !VENDOR_STATUSES.includes(statusRaw)) {
      throw new BadRequestException({
        code: 'INVALID_STATUS_FILTER',
        message: `status must be one of ${VENDOR_STATUSES.join(', ')}`,
      });
    }
    const q = qRaw?.trim();
    if (q !== undefined && q.length > 0 && q.length < 2) {
      throw new BadRequestException({
        code: 'INVALID_SEARCH',
        message: 'q must be at least 2 characters',
      });
    }
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [isIsoDateString, isUuidLike]);

    const and: Prisma.VendorWhereInput[] = [];
    if (statusRaw) and.push({ status: statusRaw as VendorStatus });
    // Prisma's `contains` does not escape LIKE wildcards, so `%` and `_`
    // would otherwise act as wildcards (q=%% would match every vendor).
    // Postgres' default LIKE escape character is the backslash.
    if (q) {
      and.push({
        legalName: {
          contains: q.replace(/[\\%_]/g, '\\$&'),
          mode: 'insensitive',
        },
      });
    }
    if (cursor) {
      const t = new Date(cursor[0] as string);
      and.push({
        OR: [
          { createdAt: { gt: t } },
          { createdAt: t, id: { gt: cursor[1] as string } },
        ],
      });
    }

    const rows = await this.prisma.vendor.findMany({
      where: and.length ? { AND: and } : undefined,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        legalName: true,
        storeType: true,
        status: true,
        createdAt: true,
        vendorUsers: { where: { userId: user.id }, select: { id: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((v) => ({
        id: v.id,
        legal_name: v.legalName,
        store_type: v.storeType,
        status: v.status,
        created_at: v.createdAt.toISOString(),
        is_member: v.vendorUsers.length > 0,
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  @Get(':vendorId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vendorId') vendorId: string,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        vendorUsers: { where: { userId: user.id }, select: { id: true } },
      },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    const [suspensions, activeOrders] = await Promise.all([
      this.prisma.vendorSuspension.findMany({
        where: { vendorId },
        orderBy: [{ suspendedAt: 'desc' }, { id: 'asc' }],
        take: 50,
      }),
      this.prisma.branchOrder.count({
        where: {
          vendorId,
          status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
        },
      }),
    ]);
    return {
      id: vendor.id,
      legal_name: vendor.legalName,
      store_type: vendor.storeType,
      status: vendor.status,
      created_at: vendor.createdAt.toISOString(),
      is_member: vendor.vendorUsers.length > 0,
      active_branch_orders_count: activeOrders,
      suspensions: suspensions.map(suspensionDto),
    };
  }

  @Post(':vendorId/suspend')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async suspend(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SuspendVendorDto,
    @Req() req: Request,
  ) {
    await this.assertVendorExists(vendorId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;
      // First check under the vendor lock (D4) - see
      // assertNoPlatformVendorConflict.
      await assertNoPlatformVendorConflict(tx, user.id, vendorId);

      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      if (vendor.status === 'SUSPENDED') {
        throw new ConflictException({
          code: 'VENDOR_ALREADY_SUSPENDED',
          message: 'This vendor is already suspended',
        });
      }
      if (vendor.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'VENDOR_NOT_ACTIVE',
          message: 'Only an ACTIVE vendor can be suspended',
        });
      }

      const suspension = await tx.vendorSuspension.create({
        data: {
          vendorId,
          reasonCode: dto.reason_code,
          reason: dto.reason,
          suspendedBy: user.id,
        },
      });
      await tx.vendor.update({
        where: { id: vendorId },
        data: { status: 'SUSPENDED' },
      });

      // The free-text reason lives only in vendor_suspensions. Neither
      // the AuditLog row nor the outbox payload carries it: both are
      // broader-trust surfaces (audit viewer in S25, notification
      // consumers in S19). reason_code is a fixed enum, safe to carry.
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor.suspended',
          entityType: 'Vendor',
          entityId: vendorId,
          beforeState: { status: 'ACTIVE' },
          afterState: {
            status: 'SUSPENDED',
            suspension_id: suspension.id,
            reason_code: suspension.reasonCode,
          },
        },
        tx,
      );
      await this.outbox.enqueue(
        {
          eventType: 'vendor.suspended',
          payload: {
            vendor_id: vendorId,
            suspension_id: suspension.id,
            reason_code: suspension.reasonCode,
            occurred_at: suspension.suspendedAt.toISOString(),
          },
        },
        tx,
      );

      const body = suspensionDto(suspension);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  @Post(':vendorId/reactivate')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async reactivate(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReactivateVendorDto,
    @Req() req: Request,
  ) {
    await this.assertVendorExists(vendorId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;
      await assertNoPlatformVendorConflict(tx, user.id, vendorId);

      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      if (vendor.status !== 'SUSPENDED') {
        throw new ConflictException({
          code: 'VENDOR_NOT_SUSPENDED',
          message: 'Only a SUSPENDED vendor can be reactivated',
        });
      }
      const open = await tx.vendorSuspension.findFirst({
        where: { vendorId, reactivatedAt: null },
      });
      if (!open) {
        throw new ConflictException({
          code: 'SUSPENSION_RECORD_MISSING',
          message:
            'This vendor is SUSPENDED but has no open suspension record - resolve it manually',
        });
      }

      const closed = await tx.vendorSuspension.update({
        where: { id: open.id },
        data: {
          reactivatedBy: user.id,
          reactivatedAt: new Date(),
          reactivationReason: dto.reason,
        },
      });
      await tx.vendor.update({
        where: { id: vendorId },
        data: { status: 'ACTIVE' },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor.reactivated',
          entityType: 'Vendor',
          entityId: vendorId,
          beforeState: { status: 'SUSPENDED' },
          afterState: { status: 'ACTIVE', suspension_id: closed.id },
        },
        tx,
      );
      await this.outbox.enqueue(
        {
          eventType: 'vendor.reactivated',
          payload: {
            vendor_id: vendorId,
            suspension_id: closed.id,
            occurred_at: closed.reactivatedAt!.toISOString(),
          },
        },
        tx,
      );

      const body = suspensionDto(closed);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  private async assertVendorExists(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
  }
}
