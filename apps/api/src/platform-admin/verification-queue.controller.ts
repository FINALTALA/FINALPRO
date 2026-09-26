import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma, PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';

interface QueueRow {
  kind: 'BRANCH' | 'WAREHOUSE';
  item_id: string;
  vendor_id: string;
  legal_name: string;
  store_type: string;
  submitted_at: Date;
  status: string;
  reviewed_at: Date | null;
  branch_name: string | null;
}

// Sprint 16 (FR-VEND-003, G-AD-01): the reviewer's work queue - the
// only way to find verification items awaiting a decision.
//
// A LIST, so it deliberately carries no evidence at all: no lat/lng,
// no photo, no address note. Those are released only by the two
// single-item, audited evidence reads (branch and warehouse), and only
// while an item is PENDING.
//
// Order is fixed and total: submitted_at, then kind ('BRANCH' before
// 'WAREHOUSE'), then item_id, ascending. Keyset-paginated with an
// opaque cursor over exactly those three keys, so a page boundary can
// never skip or repeat an item, whatever else is submitted meanwhile.
@Controller('admin/verification-queue')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class VerificationQueueController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePlatformRole(
    PlatformRole.VERIFICATION_REVIEWER,
    PlatformRole.PLATFORM_ADMIN,
  )
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') statusRaw?: string,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const status = statusRaw ?? 'pending';
    if (status !== 'pending' && status !== 'decided') {
      throw new BadRequestException({
        code: 'INVALID_STATUS_FILTER',
        message: "status must be 'pending' (default) or 'decided'",
      });
    }
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [
      isIsoDateString,
      (v) => v === 'BRANCH' || v === 'WAREHOUSE',
      isUuidLike,
    ]);

    const branchStatus =
      status === 'pending'
        ? Prisma.sql`b."verificationStatus" = 'PENDING' AND v."status" = 'UNDER_REVIEW'`
        : Prisma.sql`b."verificationStatus" <> 'PENDING'`;
    const warehouseStatus =
      status === 'pending'
        ? Prisma.sql`e."status" = 'PENDING' AND v."status" = 'UNDER_REVIEW'`
        : Prisma.sql`e."status" <> 'PENDING'`;
    const cursorCond = cursor
      ? Prisma.sql`WHERE (q.submitted_at, q.kind, q.item_id) > (${cursor[0] as string}::timestamp, ${cursor[1] as string}, ${cursor[2] as string})`
      : Prisma.empty;

    // A reviewer/admin never sees a store they are a member of (D4):
    // they could not act on it anyway.
    const rows = await this.prisma.$queryRaw<QueueRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT 'BRANCH'::text AS kind, b."id" AS item_id, b."vendorId" AS vendor_id,
               v."legalName" AS legal_name, v."storeType"::text AS store_type,
               b."evidenceSubmittedAt" AS submitted_at,
               b."verificationStatus"::text AS status,
               b."reviewedAt" AS reviewed_at, b."name" AS branch_name
          FROM store_branches b
          JOIN vendors v ON v."id" = b."vendorId"
         WHERE b."isPhysical" = TRUE
           AND b."evidenceRevision" >= 1
           AND b."evidenceSubmittedAt" IS NOT NULL
           AND ${branchStatus}
           AND NOT EXISTS (
             SELECT 1 FROM vendor_users vu
              WHERE vu."vendorId" = b."vendorId" AND vu."userId" = ${user.id})
        UNION ALL
        SELECT 'WAREHOUSE'::text, e."id", e."vendorId",
               v."legalName", v."storeType"::text,
               e."submittedAt", e."status"::text, e."reviewedAt", NULL::text
          FROM warehouse_verification_evidence e
          JOIN vendors v ON v."id" = e."vendorId"
         WHERE ${warehouseStatus}
           AND NOT EXISTS (
             SELECT 1 FROM vendor_users vu
              WHERE vu."vendorId" = e."vendorId" AND vu."userId" = ${user.id})
      ) q
      ${cursorCond}
      ORDER BY q.submitted_at ASC, q.kind ASC, q.item_id ASC
      LIMIT ${limit + 1}
    `);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        kind: r.kind,
        item_id: r.item_id,
        vendor_id: r.vendor_id,
        legal_name: r.legal_name,
        store_type: r.store_type,
        submitted_at: r.submitted_at.toISOString(),
        ...(r.kind === 'BRANCH' ? { branch_name: r.branch_name } : {}),
        ...(status === 'decided'
          ? {
              status: r.status,
              reviewed_at: r.reviewed_at?.toISOString() ?? null,
            }
          : {}),
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([
              last.submitted_at.toISOString(),
              last.kind,
              last.item_id,
            ])
          : null,
    };
  }
}
