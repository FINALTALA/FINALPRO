import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { Prisma, PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { verificationQueueSql } from './verification-queue.controller';

/**
 * VIA Control Center phase 2B - the Approval Center's counts.
 *
 * An inbox only: it never decides, never copies a request and never stores
 * anything. Each source keeps its own list, record and decision; this
 * answers "how many items can I decide right now, and since when", using
 * exactly the condition the source's own list uses:
 *
 *  source                  list it mirrors                                   who
 *  BRANCH_VERIFICATION     GET /admin/verification-queue?kind=BRANCH          both staff roles
 *  WAREHOUSE_VERIFICATION  GET /admin/verification-queue?kind=WAREHOUSE       both staff roles
 *  NAME_CHANGE             GET /canonical-products/name-change-requests       PLATFORM_ADMIN
 *  BRAND_REQUEST           GET /admin/brand-requests?status=PENDING           PLATFORM_ADMIN
 *  REPORTED_REVIEW         GET /admin/reviews/reported                        PLATFORM_ADMIN
 *  ESCALATED_RETURN        GET /admin/returns                                 PLATFORM_ADMIN
 *  SIZE_GUIDE_REQUEST      GET /admin/size-guide-requests?status=PENDING      PLATFORM_ADMIN
 *
 * Every count is of one source's own records (one row per sourceRecordId),
 * so nothing is counted twice; a reported review counts once however many
 * reports it has. A source the role may not use is left out entirely. The
 * existing conflict rules decide what is "mine to decide": verification
 * never shows a store the user belongs to (D4), and an escalated return
 * on an order the user placed is not theirs to decide (TB-28) - those are
 * reported apart as `excluded_self`, never in `pending`.
 *
 * Each source is counted on its own: one that fails is UNAVAILABLE (with
 * no number) and the total is marked partial; an available source with
 * nothing waiting is AVAILABLE with 0.
 */

export const APPROVAL_SOURCES = [
  'BRANCH_VERIFICATION',
  'WAREHOUSE_VERIFICATION',
  'NAME_CHANGE',
  'BRAND_REQUEST',
  'REPORTED_REVIEW',
  'ESCALATED_RETURN',
  'SIZE_GUIDE_REQUEST',
] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

const REVIEWER_SOURCES: readonly ApprovalSource[] = [
  'BRANCH_VERIFICATION',
  'WAREHOUSE_VERIFICATION',
];

interface SourceCount {
  pending: number;
  oldest_at: Date | null;
  excluded_self?: number;
}

export interface ApprovalSourceSummary {
  source: ApprovalSource;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  pending: number | null;
  oldest_at: string | null;
  excluded_self?: number;
}

@Controller('admin/approval-center')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class ApprovalCenterController {
  private readonly logger = new Logger(ApprovalCenterController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  @RequirePlatformRole(
    PlatformRole.VERIFICATION_REVIEWER,
    PlatformRole.PLATFORM_ADMIN,
  )
  async summary(@CurrentUser() user: AuthenticatedUser) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { platformRole: true },
    });
    const role =
      me.platformRole === PlatformRole.PLATFORM_ADMIN
        ? PlatformRole.PLATFORM_ADMIN
        : PlatformRole.VERIFICATION_REVIEWER;
    const sources: readonly ApprovalSource[] =
      role === PlatformRole.PLATFORM_ADMIN
        ? APPROVAL_SOURCES
        : REVIEWER_SOURCES;

    // The two verification sources share one read of the queue.
    let verification: Promise<Map<string, SourceCount>> | null = null;
    const verificationCounts = () =>
      (verification ??= this.countVerification(user.id));

    const settled = await Promise.allSettled(
      sources.map((source) => this.count(source, user.id, verificationCounts)),
    );
    const items: ApprovalSourceSummary[] = sources.map((source, i) => {
      const r = settled[i];
      if (r.status === 'rejected') {
        this.logger.error(
          `Approval Center: counting ${source} failed`,
          r.reason instanceof Error ? r.reason.stack : String(r.reason),
        );
        return {
          source,
          status: 'UNAVAILABLE',
          pending: null,
          oldest_at: null,
        };
      }
      return {
        source,
        status: 'AVAILABLE',
        pending: r.value.pending,
        oldest_at: r.value.oldest_at?.toISOString() ?? null,
        ...(r.value.excluded_self !== undefined
          ? { excluded_self: r.value.excluded_self }
          : {}),
      };
    });

    return {
      role,
      generated_at: new Date().toISOString(),
      sources: items,
      total: items.reduce((sum, s) => sum + (s.pending ?? 0), 0),
      partial: items.some((s) => s.status === 'UNAVAILABLE'),
    };
  }

  private async count(
    source: ApprovalSource,
    userId: string,
    verificationCounts: () => Promise<Map<string, SourceCount>>,
  ): Promise<SourceCount> {
    switch (source) {
      case 'BRANCH_VERIFICATION':
        return (
          (await verificationCounts()).get('BRANCH') ?? {
            pending: 0,
            oldest_at: null,
          }
        );
      case 'WAREHOUSE_VERIFICATION':
        return (
          (await verificationCounts()).get('WAREHOUSE') ?? {
            pending: 0,
            oldest_at: null,
          }
        );
      case 'NAME_CHANGE': {
        const where = { status: 'PENDING' as const };
        const [pending, oldest] = await Promise.all([
          this.prisma.canonicalNameChangeRequest.count({ where }),
          this.prisma.canonicalNameChangeRequest.aggregate({
            where,
            _min: { createdAt: true },
          }),
        ]);
        return { pending, oldest_at: oldest._min.createdAt };
      }
      case 'BRAND_REQUEST': {
        const where = { status: 'PENDING' as const };
        const [pending, oldest] = await Promise.all([
          this.prisma.brandRequest.count({ where }),
          this.prisma.brandRequest.aggregate({
            where,
            _min: { createdAt: true },
          }),
        ]);
        return { pending, oldest_at: oldest._min.createdAt };
      }
      case 'REPORTED_REVIEW': {
        // One per review (the decision target), however many reports.
        const [pending, oldest] = await Promise.all([
          this.prisma.review.count({
            where: {
              deletedAt: null,
              reports: { some: { status: 'PENDING' } },
            },
          }),
          this.prisma.reviewReport.aggregate({
            where: { status: 'PENDING', review: { deletedAt: null } },
            _min: { createdAt: true },
          }),
        ]);
        return { pending, oldest_at: oldest._min.createdAt };
      }
      case 'ESCALATED_RETURN': {
        // TB-28: never a decision on a return of an order one placed.
        const own: Prisma.ReturnWhereInput = {
          branchOrderItem: {
            branchOrder: { customerOrder: { customer: { userId } } },
          },
        };
        const mine: Prisma.ReturnWhereInput = {
          status: 'ESCALATED',
          NOT: own,
        };
        const [pending, excluded, oldest] = await Promise.all([
          this.prisma.return.count({ where: mine }),
          this.prisma.return.count({
            where: { status: 'ESCALATED', ...own },
          }),
          this.prisma.return.aggregate({
            where: mine,
            _min: { escalatedAt: true },
          }),
        ]);
        return {
          pending,
          oldest_at: oldest._min.escalatedAt,
          excluded_self: excluded,
        };
      }
      case 'SIZE_GUIDE_REQUEST': {
        const where = { status: 'PENDING' as const };
        const [pending, oldest] = await Promise.all([
          this.prisma.sizeGuideRequest.count({ where }),
          this.prisma.sizeGuideRequest.aggregate({
            where,
            _min: { createdAt: true },
          }),
        ]);
        return { pending, oldest_at: oldest._min.createdAt };
      }
    }
  }

  private async countVerification(
    userId: string,
  ): Promise<Map<string, SourceCount>> {
    const rows = await this.prisma.$queryRaw<
      { kind: string; n: bigint; oldest: Date | null }[]
    >(Prisma.sql`
      SELECT q.kind, COUNT(*) AS n, MIN(q.submitted_at) AS oldest
        FROM (${verificationQueueSql('pending', userId)}) q
       GROUP BY q.kind
    `);
    return new Map(
      rows.map((r) => [r.kind, { pending: Number(r.n), oldest_at: r.oldest }]),
    );
  }
}
