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
  vendor_status: string;
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
/**
 * The queue's rows - one per branch evidence and per warehouse evidence -
 * for one status, as the user may see them. Shared with the Approval
 * Center's counts (approval-center.controller.ts) so the two can never
 * disagree.
 *  - pending: what a reviewer can decide right now. A branch is decidable
 *    for an UNDER_REVIEW store (initial review) AND an ACTIVE one (a
 *    branch added later) - the two states VendorVerificationController
 *    accepts (phase 2A); archived branches never. Warehouse evidence is
 *    decided only during the initial review.
 *  - decided: past decisions.
 * A reviewer/admin never sees a store they are a member of (D4): they
 * could not act on it anyway.
 */
export function verificationQueueSql(
  status: 'pending' | 'decided',
  userId: string,
): Prisma.Sql {
  const branchStatus =
    status === 'pending'
      ? Prisma.sql`b."verificationStatus" = 'PENDING' AND v."status" IN ('UNDER_REVIEW', 'ACTIVE') AND b."archivedAt" IS NULL`
      : Prisma.sql`b."verificationStatus" <> 'PENDING'`;
  const warehouseStatus =
    status === 'pending'
      ? Prisma.sql`e."status" = 'PENDING' AND v."status" = 'UNDER_REVIEW'`
      : Prisma.sql`e."status" <> 'PENDING'`;
  return Prisma.sql`
        SELECT 'BRANCH'::text AS kind, b."id" AS item_id, b."vendorId" AS vendor_id,
               v."legalName" AS legal_name, v."storeType"::text AS store_type,
               v."status"::text AS vendor_status,
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
              WHERE vu."vendorId" = b."vendorId" AND vu."userId" = ${userId})
        UNION ALL
        SELECT 'WAREHOUSE'::text, e."id", e."vendorId",
               v."legalName", v."storeType"::text, v."status"::text,
               e."submittedAt", e."status"::text, e."reviewedAt", NULL::text
          FROM warehouse_verification_evidence e
          JOIN vendors v ON v."id" = e."vendorId"
         WHERE ${warehouseStatus}
           AND NOT EXISTS (
             SELECT 1 FROM vendor_users vu
              WHERE vu."vendorId" = e."vendorId" AND vu."userId" = ${userId})`;
}

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
    @Query('kind') kindRaw?: string,
  ) {
    const status = statusRaw ?? 'pending';
    if (status !== 'pending' && status !== 'decided') {
      throw new BadRequestException({
        code: 'INVALID_STATUS_FILTER',
        message: "status must be 'pending' (default) or 'decided'",
      });
    }
    // Phase 2B (Approval Center): an optional kind narrows the queue to one
    // evidence type; without it the queue is exactly what it always was.
    if (
      kindRaw !== undefined &&
      kindRaw !== 'BRANCH' &&
      kindRaw !== 'WAREHOUSE'
    ) {
      throw new BadRequestException({
        code: 'INVALID_KIND_FILTER',
        message: "kind must be 'BRANCH' or 'WAREHOUSE'",
      });
    }
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [
      isIsoDateString,
      (v) => v === 'BRANCH' || v === 'WAREHOUSE',
      isUuidLike,
    ]);

    const conds: Prisma.Sql[] = [];
    if (kindRaw) conds.push(Prisma.sql`q.kind = ${kindRaw}`);
    if (cursor)
      conds.push(
        Prisma.sql`(q.submitted_at, q.kind, q.item_id) > (${cursor[0] as string}::timestamp, ${cursor[1] as string}, ${cursor[2] as string})`,
      );
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<QueueRow[]>(Prisma.sql`
      SELECT * FROM (${verificationQueueSql(status, user.id)}) q
      ${where}
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
        // Phase 2A: UNDER_REVIEW (initial review) or ACTIVE (a late
        // branch of a live store) for a pending item.
        vendor_status: r.vendor_status,
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
