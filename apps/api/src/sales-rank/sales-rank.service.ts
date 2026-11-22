import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ProductAudience,
  SalesRankScope,
  SalesRankTrigger,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  RankLine,
  RETURN_STATUSES_ITEM_KEPT,
  rankLines,
  windowFor,
} from './sales-rank.rules';

/** Serialises every rebuild: the scheduled job skips, an administrator waits. */
const LOCK_KEY = 'finalpro:sales_rank';
const RUN_HISTORY_DAYS = 30;
/** Follows a merge chain this far at most (merges are never cyclic). */
const MAX_MERGE_HOPS = 5;

interface SaleRow {
  itemId: string;
  quantity: number;
  vendorId: string;
  offerId: string;
  offerStatus: string;
  canonicalProductId: string | null;
  customerId: string;
  soldAt: Date;
  vendorStatus: string;
  storefrontPublished: boolean;
}

export interface SalesRankRunSummary {
  id: string;
  window_start: string;
  window_end: string;
  trigger: SalesRankTrigger;
  row_count: number;
  qualified_count: number;
  computed_at: string;
}

function runDto(r: {
  id: string;
  windowStart: Date;
  windowEnd: Date;
  trigger: SalesRankTrigger;
  rowCount: number;
  qualifiedCount: number;
  computedAt: Date;
}): SalesRankRunSummary {
  return {
    id: r.id,
    window_start: r.windowStart.toISOString(),
    window_end: r.windowEnd.toISOString(),
    trigger: r.trigger,
    row_count: r.rowCount,
    qualified_count: r.qualifiedCount,
    computed_at: r.computedAt.toISOString(),
  };
}

/**
 * PD-5.2: rebuilds the derived sales rank (SalesRankSnapshot) for the
 * 30-day window - all rows replaced in one transaction under an advisory
 * lock, so a rebuild is idempotent and two never interleave. Nothing
 * public reads orders for ranking; PD-5.3 will read these rows.
 */
@Injectable()
export class SalesRankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The qualifying sale lines of the window (filters: sales-rank.rules.ts). */
  private async saleRows(
    tx: Prisma.TransactionClient,
    start: Date,
    end: Date,
  ): Promise<SaleRow[]> {
    const kept = Prisma.join(RETURN_STATUSES_ITEM_KEPT.map((s) => s));
    return tx.$queryRaw<SaleRow[]>`
      SELECT i.id AS "itemId",
             i.quantity,
             i."vendorId",
             ov."vendorOfferId" AS "offerId",
             vo.status::text AS "offerStatus",
             vo."canonicalProductId",
             co."customerId",
             COALESCE(o."deliveredAt", o."pickedUpAt") AS "soldAt",
             v.status::text AS "vendorStatus",
             v."storefrontPublished"
        FROM branch_order_items i
        JOIN branch_orders o ON o.id = i."branchOrderId"
        JOIN customer_orders co ON co.id = o."customerOrderId"
        JOIN offer_variants ov ON ov.id = i."offerVariantId"
        JOIN vendor_offers vo ON vo.id = ov."vendorOfferId"
        JOIN vendors v ON v.id = i."vendorId"
       WHERE o.status = 'COMPLETED'
         AND i."cancelledAt" IS NULL
         AND COALESCE(o."deliveredAt", o."pickedUpAt") > ${start}
         AND COALESCE(o."deliveredAt", o."pickedUpAt") <= ${end}
         AND v.status <> 'SUSPENDED'
         AND NOT EXISTS (
               SELECT 1 FROM branch_order_refunds r
                WHERE r."branchOrderItemId" = i.id)
         AND NOT EXISTS (
               SELECT 1 FROM returns rt
                WHERE rt."branchOrderItemId" = i.id
                  AND rt.status::text NOT IN (${kept}))
         AND NOT EXISTS (
               SELECT 1 FROM vendor_users vu
                 JOIN customer_profiles cp ON cp."userId" = vu."userId"
                WHERE vu."vendorId" = i."vendorId"
                  AND cp.id = co."customerId")`;
  }

  /** Each offer's taxonomy scopes: its (category, audience) pairs that exist. */
  private async offerScopes(
    tx: Prisma.TransactionClient,
    offerIds: string[],
  ): Promise<
    Map<string, { categoryCode: string; audience: ProductAudience }[]>
  > {
    const [offers, pairs] = await Promise.all([
      tx.vendorOffer.findMany({
        where: { id: { in: offerIds } },
        select: {
          id: true,
          audiences: { select: { audience: true } },
          categories: { select: { categoryCode: true } },
        },
      }),
      tx.taxonomyCategoryAudience.findMany({
        select: { categoryCode: true, audience: true },
      }),
    ]);
    const valid = new Set(pairs.map((p) => `${p.categoryCode}|${p.audience}`));
    return new Map(
      offers.map((o) => [
        o.id,
        o.categories.flatMap((c) =>
          o.audiences
            .filter((a) => valid.has(`${c.categoryCode}|${a.audience}`))
            .map((a) => ({
              categoryCode: c.categoryCode,
              audience: a.audience,
            })),
        ),
      ]),
    );
  }

  /** A canonical product's live identity: follows merges, PUBLISHED only. */
  private async canonicalTargets(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<Map<string, string>> {
    const known = new Map<
      string,
      { status: string; mergedIntoId: string | null }
    >();
    let pending = [...new Set(ids)];
    for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.length; hop++) {
      const rows = await tx.canonicalProduct.findMany({
        where: { id: { in: pending } },
        select: { id: true, status: true, mergedIntoId: true },
      });
      for (const r of rows) known.set(r.id, r);
      pending = rows
        .map((r) => r.mergedIntoId)
        .filter((m): m is string => !!m && !known.has(m));
    }
    const result = new Map<string, string>();
    for (const id of new Set(ids)) {
      let current = id;
      for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
        const row = known.get(current);
        if (!row) break;
        if (row.status === 'PUBLISHED') {
          result.set(id, current);
          break;
        }
        if (row.status !== 'MERGED' || !row.mergedIntoId) break;
        current = row.mergedIntoId;
      }
    }
    return result;
  }

  /**
   * Rebuilds the whole window. `skipIfBusy` (the scheduled job) returns
   * null instead of waiting when another rebuild holds the lock.
   */
  async rebuild(options: {
    trigger: SalesRankTrigger;
    actorId?: string;
    correlationId?: string;
    now?: Date;
    skipIfBusy?: boolean;
  }): Promise<SalesRankRunSummary | null> {
    const now = options.now ?? new Date();
    const { start, end } = windowFor(now);
    return this.prisma.$transaction(
      async (tx) => {
        if (options.skipIfBusy) {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
          if (!locked) return null;
        } else {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
        }

        const rows = await this.saleRows(tx, start, end);
        const scopes = await this.offerScopes(tx, [
          ...new Set(rows.map((r) => r.offerId)),
        ]);
        const canonical = await this.canonicalTargets(
          tx,
          rows
            .map((r) => r.canonicalProductId)
            .filter((id): id is string => !!id),
        );

        const offerLines: RankLine[] = [];
        const canonicalLines: RankLine[] = [];
        const offerVendor = new Map<string, string>();
        for (const r of rows) {
          const pairs = scopes.get(r.offerId) ?? [];
          const base = {
            quantity: r.quantity,
            customerId: r.customerId,
            soldAt: r.soldAt,
          };
          // OFFER scope: only a listing a shopper can see now.
          if (
            r.offerStatus === 'ACTIVE' &&
            r.vendorStatus === 'ACTIVE' &&
            r.storefrontPublished
          ) {
            offerVendor.set(r.offerId, r.vendorId);
            for (const p of pairs)
              offerLines.push({ ...base, ...p, targetId: r.offerId });
          }
          // CANONICAL scope: the product's real sales over every store.
          const target = r.canonicalProductId
            ? canonical.get(r.canonicalProductId)
            : undefined;
          if (target)
            for (const p of pairs)
              canonicalLines.push({ ...base, ...p, targetId: target });
        }

        const entries = [
          ...rankLines(offerLines).map((e) => ({
            e,
            scope: 'OFFER' as SalesRankScope,
          })),
          ...rankLines(canonicalLines).map((e) => ({
            e,
            scope: 'CANONICAL' as SalesRankScope,
          })),
        ];

        await tx.salesRankSnapshot.deleteMany({});
        const run = await tx.salesRankRun.create({
          data: {
            windowStart: start,
            windowEnd: end,
            trigger: options.trigger,
            triggeredById:
              options.trigger === 'ADMIN' ? options.actorId! : null,
            rowCount: entries.length,
            qualifiedCount: entries.filter((x) => x.e.qualified).length,
            computedAt: now,
          },
        });
        if (entries.length) {
          await tx.salesRankSnapshot.createMany({
            data: entries.map(({ e, scope }) => ({
              runId: run.id,
              scope,
              vendorId: scope === 'OFFER' ? offerVendor.get(e.targetId)! : null,
              vendorOfferId: scope === 'OFFER' ? e.targetId : null,
              canonicalProductId: scope === 'CANONICAL' ? e.targetId : null,
              categoryCode: e.categoryCode,
              audience: e.audience,
              units: e.units,
              customers: e.customers,
              firstSoldAt: e.firstSoldAt,
              rank: e.rank,
              qualifiedRank: e.qualifiedRank,
              qualified: e.qualified,
            })),
          });
        }
        await tx.salesRankRun.deleteMany({
          where: {
            id: { not: run.id },
            computedAt: {
              lt: new Date(now.getTime() - RUN_HISTORY_DAYS * 86_400_000),
            },
          },
        });
        if (options.trigger === 'ADMIN') {
          await this.audit.record(
            {
              actorId: options.actorId!,
              correlationId: options.correlationId,
              action: 'sales_rank.recomputed',
              entityType: 'SalesRankRun',
              entityId: run.id,
              afterState: {
                window_start: start.toISOString(),
                window_end: end.toISOString(),
                row_count: run.rowCount,
                qualified_count: run.qualifiedCount,
              },
            },
            tx,
          );
        }
        return runDto(run);
      },
      { timeout: 120_000, maxWait: 120_000 },
    );
  }

  /** The administrator's view of the latest run (exact numbers - admin only). */
  async adminView(filter: {
    scope?: SalesRankScope;
    categoryCode?: string;
    audience?: ProductAudience;
    qualified?: boolean;
    take: number;
  }) {
    const run = await this.prisma.salesRankRun.findFirst({
      orderBy: { computedAt: 'desc' },
    });
    if (!run) return { run: null, entries: [] };
    const rows = await this.prisma.salesRankSnapshot.findMany({
      where: {
        runId: run.id,
        ...(filter.scope ? { scope: filter.scope } : {}),
        ...(filter.categoryCode ? { categoryCode: filter.categoryCode } : {}),
        ...(filter.audience ? { audience: filter.audience } : {}),
        ...(filter.qualified !== undefined
          ? { qualified: filter.qualified }
          : {}),
      },
      orderBy: [
        { scope: 'asc' },
        { categoryCode: 'asc' },
        { audience: 'asc' },
        { rank: 'asc' },
      ],
      take: filter.take,
      include: {
        vendorOffer: {
          select: {
            titleAr: true,
            status: true,
            vendor: {
              select: { slug: true, displayName: true, legalName: true },
            },
          },
        },
        canonicalProduct: {
          select: { canonicalNameAr: true, modelName: true, status: true },
        },
      },
    });
    return {
      run: runDto(run),
      entries: rows.map((r) => ({
        scope: r.scope,
        category_code: r.categoryCode,
        audience: r.audience,
        rank: r.rank,
        qualified: r.qualified,
        qualified_rank: r.qualifiedRank,
        units: r.units,
        customers: r.customers,
        first_sold_at: r.firstSoldAt.toISOString(),
        offer: r.vendorOffer
          ? {
              id: r.vendorOfferId,
              title: r.vendorOffer.titleAr,
              status: r.vendorOffer.status,
              store:
                r.vendorOffer.vendor.displayName ??
                r.vendorOffer.vendor.legalName,
              store_slug: r.vendorOffer.vendor.slug,
            }
          : null,
        canonical_product: r.canonicalProduct
          ? {
              id: r.canonicalProductId,
              name:
                r.canonicalProduct.canonicalNameAr ??
                r.canonicalProduct.modelName,
              status: r.canonicalProduct.status,
            }
          : null,
      })),
    };
  }
}
