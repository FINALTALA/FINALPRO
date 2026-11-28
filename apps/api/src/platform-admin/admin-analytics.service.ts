import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '../../generated/prisma/client';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  localToday,
  parsePeriod,
  periodOf,
  REPORT_TIME_ZONE,
  ReportPeriod,
} from './analytics-period.util';

/**
 * VIA phase 4 - Dashboard and Analytics: the ONE shared reporting query
 * set; the dashboard, the analytics page and every export read it, so the
 * same filter always gives the same figures.
 *
 * Definitions (Codex):
 *  - Orders are BranchOrders (one store branch's part); a CustomerOrder is
 *    the parent checkout, counted separately as "checkouts".
 *  - Completed merchandise GMV: BranchOrders whose completedAt falls in
 *    the period; the immutable line snapshots (unitPrice x quantity) of
 *    lines not cancelled before completion. Delivery fees and in-store POS
 *    are never in it. It is NOT VIA revenue (no reconciled source exists).
 *  - Net completed merchandise value = that GMV minus the merchandise
 *    refunds recorded on those orders at/after completion (as of now).
 *    Refunds of lines cancelled before completion are not subtracted again
 *    - those lines were never in the GMV.
 *  - Refunds (cash view): rows recorded in the period, merchandise apart
 *    from delivery-fee refunds.
 *  - Returns are cases opened in the period, counted whether or not a
 *    refund was ever recorded.
 *  - Lines and refunds are aggregated separately before being combined.
 *  - Money is summed in SQL numeric and handled with decimal.js (ILS).
 */

export const TABLE_LIMIT = 50;
export const EXPORT_ROW_LIMIT = 1000;

type Money = string;
const ZERO = new Decimal(0);
const dec = (v: unknown): Decimal =>
  v === null || v === undefined ? ZERO : new Decimal(String(v));
const money = (v: unknown): Money => dec(v).toFixed(2);
const int = (v: unknown): number => Number(v ?? 0);

/** Percentage change, null when there is nothing to compare with. */
export function change(current: Decimal | number, previous: Decimal | number) {
  const c = new Decimal(String(current));
  const p = new Decimal(String(previous));
  if (p.isZero()) return null;
  return c.minus(p).div(p).times(100).toDecimalPlaces(1).toNumber();
}

export interface Overview {
  branch_orders: number;
  checkouts: number;
  completed_orders: number;
  completed_units: number;
  gmv: Money;
  later_merchandise_refunds: Money;
  net_completed: Money;
  merchandise_refunds: Money;
  delivery_fee_refunds: Money;
  refund_rows: number;
  returns_opened: number;
  cancelled_lines: number;
  cancelled_value: Money;
  cancelled_orders: number;
  buyers: number;
  registrations: number;
  pos_sales: number;
  pos_total: Money;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Shared figures

  async overview(p: ReportPeriod): Promise<Overview> {
    const { start, end } = p;
    const [
      placed,
      lines,
      later,
      refunds,
      returns,
      cancelled,
      buyers,
      regs,
      pos,
    ] = await Promise.all([
      this.prisma.$queryRaw<
        { orders: bigint; checkouts: bigint; cancelled: bigint }[]
      >`
          SELECT count(*) AS orders,
                 count(DISTINCT "customerOrderId") AS checkouts,
                 count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled
            FROM branch_orders
           WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`,
      this.prisma.$queryRaw<{ orders: bigint; units: bigint; gmv: unknown }[]>`
          SELECT count(DISTINCT o.id) AS orders,
                 COALESCE(sum(i.quantity), 0) AS units,
                 COALESCE(sum(i."unitPrice" * i.quantity), 0) AS gmv
            FROM branch_orders o
            JOIN branch_order_items i ON i."branchOrderId" = o.id
           WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
             AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")`,
      this.prisma.$queryRaw<{ amount: unknown }[]>`
          SELECT COALESCE(sum(r.amount), 0) AS amount
            FROM branch_orders o
            JOIN branch_order_refunds r ON r."branchOrderId" = o.id
           WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
             AND r.reason <> 'DELIVERY_FEE'
             AND r."createdAt" >= o."completedAt"`,
      this.prisma.$queryRaw<{ merch: unknown; fee: unknown; n: bigint }[]>`
          SELECT COALESCE(sum(amount) FILTER (WHERE reason <> 'DELIVERY_FEE'), 0) AS merch,
                 COALESCE(sum(amount) FILTER (WHERE reason = 'DELIVERY_FEE'), 0) AS fee,
                 count(*) AS n
            FROM branch_order_refunds
           WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`,
      this.prisma.return.count({
        where: { createdAt: { gte: start, lt: end } },
      }),
      this.prisma.$queryRaw<{ n: bigint; value: unknown }[]>`
          SELECT count(*) AS n, COALESCE(sum("unitPrice" * quantity), 0) AS value
            FROM branch_order_items
           WHERE "cancelledAt" >= ${start} AND "cancelledAt" < ${end}`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(DISTINCT "customerId") AS n
            FROM customer_orders
           WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`,
      this.prisma.user.count({
        where: { createdAt: { gte: start, lt: end }, platformRole: null },
      }),
      this.prisma.$queryRaw<{ n: bigint; total: unknown }[]>`
          SELECT count(*) AS n, COALESCE(sum(total), 0) AS total
            FROM store_sales
           WHERE status = 'COMPLETED'
             AND "createdAt" >= ${start} AND "createdAt" < ${end}`,
    ]);
    const gmv = dec(lines[0]?.gmv);
    const laterRefunds = dec(later[0]?.amount);
    return {
      branch_orders: int(placed[0]?.orders),
      checkouts: int(placed[0]?.checkouts),
      completed_orders: int(lines[0]?.orders),
      completed_units: int(lines[0]?.units),
      gmv: gmv.toFixed(2),
      later_merchandise_refunds: laterRefunds.toFixed(2),
      net_completed: gmv.minus(laterRefunds).toFixed(2),
      merchandise_refunds: money(refunds[0]?.merch),
      delivery_fee_refunds: money(refunds[0]?.fee),
      refund_rows: int(refunds[0]?.n),
      returns_opened: returns,
      cancelled_lines: int(cancelled[0]?.n),
      cancelled_value: money(cancelled[0]?.value),
      cancelled_orders: int(placed[0]?.cancelled),
      buyers: int(buyers[0]?.n),
      registrations: regs,
      pos_sales: int(pos[0]?.n),
      pos_total: money(pos[0]?.total),
    };
  }

  /** One row per local day: orders placed, checkouts, completed GMV (and POS, separately). */
  async daily(p: ReportPeriod) {
    const { start, end } = p;
    const day = (col: string) =>
      Prisma.raw(
        `to_char(("${col}" AT TIME ZONE 'UTC') AT TIME ZONE '${REPORT_TIME_ZONE}', 'YYYY-MM-DD')`,
      );
    const [placed, completed, pos] = await Promise.all([
      this.prisma.$queryRaw<
        { day: string; orders: bigint; checkouts: bigint }[]
      >`
        SELECT ${day('createdAt')} AS day, count(*) AS orders,
               count(DISTINCT "customerOrderId") AS checkouts
          FROM branch_orders
         WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
         GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; orders: bigint; gmv: unknown }[]>`
        SELECT to_char((o."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TIME_ZONE}, 'YYYY-MM-DD') AS day,
               count(DISTINCT o.id) AS orders,
               COALESCE(sum(i."unitPrice" * i.quantity), 0) AS gmv
          FROM branch_orders o
          JOIN branch_order_items i ON i."branchOrderId" = o.id
         WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
           AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")
         GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; n: bigint; total: unknown }[]>`
        SELECT ${day('createdAt')} AS day, count(*) AS n, COALESCE(sum(total), 0) AS total
          FROM store_sales
         WHERE status = 'COMPLETED' AND "createdAt" >= ${start} AND "createdAt" < ${end}
         GROUP BY 1`,
    ]);
    const byDay = <T extends { day: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.day, r]));
    const pl = byDay(placed);
    const co = byDay(completed);
    const ps = byDay(pos);
    const out: {
      day: string;
      branch_orders: number;
      checkouts: number;
      completed_orders: number;
      gmv: Money;
      pos_sales: number;
      pos_total: Money;
    }[] = [];
    for (let i = 0; i < p.days; i++) {
      const d = addDays(p.from, i);
      out.push({
        day: d,
        branch_orders: int(pl.get(d)?.orders),
        checkouts: int(pl.get(d)?.checkouts),
        completed_orders: int(co.get(d)?.orders),
        gmv: money(co.get(d)?.gmv),
        pos_sales: int(ps.get(d)?.n),
        pos_total: money(ps.get(d)?.total),
      });
    }
    return out;
  }

  /** The CURRENT status of the branch orders placed in the period. */
  async statusBreakdown(p: ReportPeriod) {
    const rows = await this.prisma.branchOrder.groupBy({
      by: ['status'],
      where: { createdAt: { gte: p.start, lt: p.end } },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ status: r.status, count: r._count._all }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  }

  async returnsBreakdown(p: ReportPeriod) {
    const rows = await this.prisma.return.groupBy({
      by: ['status', 'desiredOutcome'],
      where: { createdAt: { gte: p.start, lt: p.end } },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({
        status: r.status,
        outcome: r.desiredOutcome,
        count: r._count._all,
      }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.status.localeCompare(b.status) ||
          a.outcome.localeCompare(b.outcome),
      );
  }

  /** Refunds recorded in the period by reason (merchandise vs delivery fee kept apart). */
  async refundsBreakdown(p: ReportPeriod) {
    const rows = await this.prisma.$queryRaw<
      { reason: string; n: bigint; amount: unknown }[]
    >`
      SELECT reason::text AS reason, count(*) AS n, COALESCE(sum(amount), 0) AS amount
        FROM branch_order_refunds
       WHERE "createdAt" >= ${p.start} AND "createdAt" < ${p.end}
       GROUP BY 1 ORDER BY 1`;
    return rows.map((r) => ({
      reason: r.reason,
      kind: r.reason === 'DELIVERY_FEE' ? 'DELIVERY_FEE' : 'MERCHANDISE',
      count: int(r.n),
      amount: money(r.amount),
    }));
  }

  /** Per store: orders placed, completed GMV, later merchandise refunds, returns, vs the previous period's GMV. */
  async stores(p: ReportPeriod, prev: ReportPeriod, limit = TABLE_LIMIT) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        status: string;
        placed: bigint;
        completed: bigint;
        gmv: unknown;
        later_refunds: unknown;
        returns: bigint;
        prev_gmv: unknown;
      }[]
    >`
      WITH placed AS (
        SELECT "vendorId", count(*) AS n FROM branch_orders
         WHERE "createdAt" >= ${p.start} AND "createdAt" < ${p.end}
         GROUP BY 1),
      lines AS (
        SELECT o."vendorId", count(DISTINCT o.id) AS orders,
               sum(i."unitPrice" * i.quantity) AS gmv
          FROM branch_orders o JOIN branch_order_items i ON i."branchOrderId" = o.id
         WHERE o."completedAt" >= ${p.start} AND o."completedAt" < ${p.end}
           AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")
         GROUP BY 1),
      later AS (
        SELECT o."vendorId", sum(r.amount) AS amount
          FROM branch_orders o JOIN branch_order_refunds r ON r."branchOrderId" = o.id
         WHERE o."completedAt" >= ${p.start} AND o."completedAt" < ${p.end}
           AND r.reason <> 'DELIVERY_FEE' AND r."createdAt" >= o."completedAt"
         GROUP BY 1),
      rets AS (
        SELECT "vendorId", count(*) AS n FROM returns
         WHERE "createdAt" >= ${p.start} AND "createdAt" < ${p.end}
         GROUP BY 1),
      prev AS (
        SELECT o."vendorId", sum(i."unitPrice" * i.quantity) AS gmv
          FROM branch_orders o JOIN branch_order_items i ON i."branchOrderId" = o.id
         WHERE o."completedAt" >= ${prev.start} AND o."completedAt" < ${prev.end}
           AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")
         GROUP BY 1)
      SELECT v.id, v."displayName" AS name, v.status::text AS status,
             COALESCE(placed.n, 0) AS placed,
             COALESCE(lines.orders, 0) AS completed,
             COALESCE(lines.gmv, 0) AS gmv,
             COALESCE(later.amount, 0) AS later_refunds,
             COALESCE(rets.n, 0) AS returns,
             COALESCE(prev.gmv, 0) AS prev_gmv
        FROM vendors v
        LEFT JOIN placed ON placed."vendorId" = v.id
        LEFT JOIN lines ON lines."vendorId" = v.id
        LEFT JOIN later ON later."vendorId" = v.id
        LEFT JOIN rets ON rets."vendorId" = v.id
        LEFT JOIN prev ON prev."vendorId" = v.id
       WHERE placed.n IS NOT NULL OR lines.orders IS NOT NULL
          OR rets.n IS NOT NULL OR prev.gmv IS NOT NULL
       ORDER BY COALESCE(lines.gmv, 0) DESC, COALESCE(placed.n, 0) DESC, v.id
       LIMIT ${limit}`;
    return rows.map((r) => {
      const gmv = dec(r.gmv);
      const later = dec(r.later_refunds);
      return {
        store_id: r.id,
        store_name: r.name,
        store_status: r.status,
        branch_orders: int(r.placed),
        completed_orders: int(r.completed),
        gmv: gmv.toFixed(2),
        net_completed: gmv.minus(later).toFixed(2),
        returns_opened: int(r.returns),
        previous_gmv: money(r.prev_gmv),
        gmv_change_pct: change(gmv, dec(r.prev_gmv)),
      };
    });
  }

  /** Per listing (VendorOffer) and per canonical product: completed units and GMV. */
  async products(p: ReportPeriod, limit = TABLE_LIMIT) {
    const offers = await this.prisma.$queryRaw<
      {
        id: string;
        title_ar: string;
        title_en: string | null;
        store: string;
        units: bigint;
        orders: bigint;
        gmv: unknown;
      }[]
    >`
      SELECT f.id, f."titleAr" AS title_ar, f."titleEn" AS title_en,
             v."displayName" AS store,
             sum(i.quantity) AS units, count(DISTINCT o.id) AS orders,
             sum(i."unitPrice" * i.quantity) AS gmv
        FROM branch_orders o
        JOIN branch_order_items i ON i."branchOrderId" = o.id
        JOIN offer_variants ov ON ov.id = i."offerVariantId"
        JOIN vendor_offers f ON f.id = ov."vendorOfferId"
        JOIN vendors v ON v.id = f."vendorId"
       WHERE o."completedAt" >= ${p.start} AND o."completedAt" < ${p.end}
         AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")
       GROUP BY f.id, f."titleAr", f."titleEn", v."displayName"
       ORDER BY gmv DESC, units DESC, f.id
       LIMIT ${limit}`;
    const canonical = await this.prisma.$queryRaw<
      {
        id: string;
        name_ar: string | null;
        name_en: string | null;
        model: string;
        stores: bigint;
        units: bigint;
        gmv: unknown;
      }[]
    >`
      SELECT c.id, c."canonicalNameAr" AS name_ar, c."canonicalNameEn" AS name_en,
             c."modelName" AS model,
             count(DISTINCT o."vendorId") AS stores,
             sum(i.quantity) AS units,
             sum(i."unitPrice" * i.quantity) AS gmv
        FROM branch_orders o
        JOIN branch_order_items i ON i."branchOrderId" = o.id
        JOIN offer_variants ov ON ov.id = i."offerVariantId"
        JOIN vendor_offers f ON f.id = ov."vendorOfferId"
        JOIN canonical_products c ON c.id = f."canonicalProductId"
       WHERE o."completedAt" >= ${p.start} AND o."completedAt" < ${p.end}
         AND (i."cancelledAt" IS NULL OR i."cancelledAt" >= o."completedAt")
       GROUP BY c.id, c."canonicalNameAr", c."canonicalNameEn", c."modelName"
       ORDER BY gmv DESC, units DESC, c.id
       LIMIT ${limit}`;
    return {
      offers: offers.map((r) => ({
        offer_id: r.id,
        title_ar: r.title_ar,
        title_en: r.title_en,
        store_name: r.store,
        units: int(r.units),
        branch_orders: int(r.orders),
        gmv: money(r.gmv),
      })),
      canonical: canonical.map((r) => ({
        canonical_product_id: r.id,
        name_ar: r.name_ar ?? r.model,
        name_en: r.name_en ?? r.model,
        stores: int(r.stores),
        units: int(r.units),
        gmv: money(r.gmv),
      })),
    };
  }

  /**
   * Customers: registrations; buyers (distinct customers with a checkout);
   * returning buyers = had a COMPLETED checkout before the period; repeat
   * buyers = 2+ distinct checkouts (CustomerOrders, not branches) in it.
   */
  async customers(p: ReportPeriod) {
    const [row] = await this.prisma.$queryRaw<
      {
        buyers: bigint;
        checkouts: bigint;
        returning: bigint;
        repeat: bigint;
      }[]
    >`
      WITH b AS (
        SELECT "customerId", count(*) AS checkouts
          FROM customer_orders
         WHERE "createdAt" >= ${p.start} AND "createdAt" < ${p.end}
         GROUP BY 1)
      SELECT count(*) AS buyers,
             COALESCE(sum(checkouts), 0) AS checkouts,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM customer_orders c2
                 JOIN branch_orders o2 ON o2."customerOrderId" = c2.id
                WHERE c2."customerId" = b."customerId"
                  AND c2."createdAt" < ${p.start}
                  AND o2."completedAt" IS NOT NULL
                  AND o2."completedAt" < ${p.start})) AS returning,
             count(*) FILTER (WHERE checkouts >= 2) AS repeat
        FROM b`;
    const registrations = await this.prisma.user.count({
      where: { createdAt: { gte: p.start, lt: p.end }, platformRole: null },
    });
    const buyers = int(row?.buyers);
    const returning = int(row?.returning);
    return {
      registrations,
      buyers,
      checkouts: int(row?.checkouts),
      new_buyers: buyers - returning,
      returning_buyers: returning,
      repeat_buyers_in_period: int(row?.repeat),
    };
  }

  /** In-store POS - its own channel, never in marketplace figures. */
  async pos(p: ReportPeriod, limit = TABLE_LIMIT) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        sales: bigint;
        total: unknown;
        voided: bigint;
      }[]
    >`
      SELECT v.id, v."displayName" AS name,
             count(*) FILTER (WHERE s.status = 'COMPLETED') AS sales,
             COALESCE(sum(s.total) FILTER (WHERE s.status = 'COMPLETED'), 0) AS total,
             count(*) FILTER (WHERE s.status = 'VOIDED') AS voided
        FROM store_sales s JOIN vendors v ON v.id = s."vendorId"
       WHERE s."createdAt" >= ${p.start} AND s."createdAt" < ${p.end}
       GROUP BY v.id, v."displayName"
       ORDER BY total DESC, sales DESC, v.id
       LIMIT ${limit}`;
    return rows.map((r) => ({
      store_id: r.id,
      store_name: r.name,
      sales: int(r.sales),
      total: money(r.total),
      voided: int(r.voided),
    }));
  }

  // ------------------------------------------------------------------
  // Endpoints' shapes

  meta(p: ReportPeriod, prev: ReportPeriod) {
    return {
      from: p.from,
      to: p.to,
      days: p.days,
      time_zone: REPORT_TIME_ZONE,
      interval_utc: { start: p.start.toISOString(), end: p.end.toISOString() },
      previous: {
        from: prev.from,
        to: prev.to,
        interval_utc: {
          start: prev.start.toISOString(),
          end: prev.end.toISOString(),
        },
      },
      currency: 'ILS',
      generated_at: new Date().toISOString(),
      via_revenue: null,
    };
  }

  async report(fromRaw?: string, toRaw?: string) {
    const { current, previous } = parsePeriod(fromRaw, toRaw);
    const [
      now,
      before,
      daily,
      statuses,
      returns,
      refunds,
      stores,
      products,
      customers,
      pos,
    ] = await Promise.all([
      this.overview(current),
      this.overview(previous),
      this.daily(current),
      this.statusBreakdown(current),
      this.returnsBreakdown(current),
      this.refundsBreakdown(current),
      this.stores(current, previous),
      this.products(current),
      this.customers(current),
      this.pos(current),
    ]);
    const changes: Record<string, number | null> = {};
    for (const k of Object.keys(now) as (keyof Overview)[]) {
      changes[k] = change(dec(now[k]), dec(before[k]));
    }
    return {
      meta: this.meta(current, previous),
      overview: now,
      previous_overview: before,
      change_pct: changes,
      daily,
      status_breakdown: statuses,
      returns_breakdown: returns,
      refunds_breakdown: refunds,
      stores,
      products,
      customers,
      pos,
    };
  }

  /** Current state (not period-bound), the last 30 days with comparison, recent admin activity. */
  async dashboard() {
    const enabled = {
      suspendedAt: null,
      deactivatedAt: null,
      platformRole: null,
    };
    const [
      registered,
      active,
      published,
      customers,
      owners,
      enabledAccounts,
      publicOffers,
      canonical,
      statuses,
      openReturns,
      recent,
    ] = await Promise.all([
      this.prisma.vendor.count(),
      this.prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      this.prisma.vendor.count({
        where: { status: 'ACTIVE', storefrontPublished: true },
      }),
      this.prisma.user.count({
        where: { ...enabled, customerProfile: { isNot: null } },
      }),
      this.prisma.user.count({
        where: {
          ...enabled,
          vendorUsers: { some: { role: 'OWNER', status: 'ACTIVE' } },
        },
      }),
      this.prisma.user.count({
        where: {
          ...enabled,
          OR: [
            { customerProfile: { isNot: null } },
            { vendorUsers: { some: { role: 'OWNER', status: 'ACTIVE' } } },
          ],
        },
      }),
      // The existing public eligibility: ACTIVE, not under a platform
      // hold, in a live (ACTIVE + published) store.
      this.prisma.vendorOffer.count({
        where: {
          ...PUBLIC_OFFER,
          vendor: { status: 'ACTIVE', storefrontPublished: true },
        },
      }),
      this.prisma.canonicalProduct.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.branchOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.return.count({
        where: {
          status: {
            in: [
              'REQUESTED',
              'APPROVED_AWAITING_DROPOFF',
              'RECEIVED',
              'REFUND_PROCESSING',
              'ESCALATED',
            ],
          },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { actor: { platformRole: { not: null } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          occurredAt: true,
          actor: { select: { platformRole: true } },
        },
      }),
    ]);
    const to = localToday();
    const { current, previous } = parsePeriod(addDays(to, -29), to);
    const [last30, prev30, daily] = await Promise.all([
      this.overview(current),
      this.overview(previous),
      this.daily(current),
    ]);
    return {
      meta: this.meta(current, previous),
      stores: { registered, active, published },
      accounts: {
        enabled_customers: customers,
        enabled_store_owners: owners,
        enabled_distinct: enabledAccounts,
      },
      catalog: {
        public_offers: publicOffers,
        published_canonical_products: canonical,
      },
      orders_by_status: statuses
        .map((s) => ({ status: s.status, count: s._count._all }))
        .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
      orders_total: statuses.reduce((n, s) => n + s._count._all, 0),
      open_returns: openReturns,
      last_30_days: last30,
      previous_30_days: prev30,
      change_pct: Object.fromEntries(
        (Object.keys(last30) as (keyof Overview)[]).map((k) => [
          k,
          change(dec(last30[k]), dec(prev30[k])),
        ]),
      ),
      daily,
      recent_admin_activity: recent.map((a) => ({
        id: a.id,
        action: a.action,
        entity_type: a.entityType,
        entity_id: a.entityId,
        at: a.occurredAt.toISOString(),
        actor_role: a.actor?.platformRole ?? null,
      })),
    };
  }

  /** Exports: the same queries, a larger stable row cap. */
  async exportSection(section: string, fromRaw?: string, toRaw?: string) {
    const { current, previous } = parsePeriod(fromRaw, toRaw);
    const meta = this.meta(current, previous);
    const L = EXPORT_ROW_LIMIT;
    switch (section) {
      case 'overview': {
        const [now, before] = await Promise.all([
          this.overview(current),
          this.overview(previous),
        ]);
        return {
          meta,
          channel: 'MARKETPLACE + POS (separate rows)',
          columns: ['metric', 'current', 'previous', 'change_pct'],
          rows: (Object.keys(now) as (keyof Overview)[]).map((k) => [
            k,
            String(now[k]),
            String(before[k]),
            change(dec(now[k]), dec(before[k]))?.toString() ?? '',
          ]),
        };
      }
      case 'daily': {
        const rows = await this.daily(current);
        return {
          meta,
          channel: 'MARKETPLACE (pos_* columns: IN-STORE POS)',
          columns: [
            'day',
            'branch_orders',
            'checkouts',
            'completed_orders',
            'gmv',
            'pos_sales',
            'pos_total',
          ],
          rows: rows.map((r) =>
            [
              r.day,
              r.branch_orders,
              r.checkouts,
              r.completed_orders,
              r.gmv,
              r.pos_sales,
              r.pos_total,
            ].map(String),
          ),
        };
      }
      case 'stores': {
        const rows = await this.stores(current, previous, L);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: [
            'store_id',
            'store_name',
            'store_status',
            'branch_orders',
            'completed_orders',
            'gmv',
            'net_completed',
            'returns_opened',
            'previous_gmv',
            'gmv_change_pct',
          ],
          rows: rows.map((r) => [
            r.store_id,
            r.store_name,
            r.store_status,
            String(r.branch_orders),
            String(r.completed_orders),
            r.gmv,
            r.net_completed,
            String(r.returns_opened),
            r.previous_gmv,
            r.gmv_change_pct?.toString() ?? '',
          ]),
        };
      }
      case 'products': {
        const { offers } = await this.products(current, L);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: [
            'offer_id',
            'title_ar',
            'title_en',
            'store_name',
            'units',
            'branch_orders',
            'gmv',
          ],
          rows: offers.map((r) => [
            r.offer_id,
            r.title_ar,
            r.title_en ?? '',
            r.store_name,
            String(r.units),
            String(r.branch_orders),
            r.gmv,
          ]),
        };
      }
      case 'canonical': {
        const { canonical } = await this.products(current, L);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: [
            'canonical_product_id',
            'name_ar',
            'name_en',
            'stores',
            'units',
            'gmv',
          ],
          rows: canonical.map((r) => [
            r.canonical_product_id,
            r.name_ar,
            r.name_en,
            String(r.stores),
            String(r.units),
            r.gmv,
          ]),
        };
      }
      case 'refunds': {
        const rows = await this.refundsBreakdown(current);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: ['reason', 'kind', 'count', 'amount'],
          rows: rows.map((r) => [r.reason, r.kind, String(r.count), r.amount]),
        };
      }
      case 'returns': {
        const rows = await this.returnsBreakdown(current);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: ['status', 'outcome', 'count'],
          rows: rows.map((r) => [r.status, r.outcome, String(r.count)]),
        };
      }
      case 'customers': {
        const c = await this.customers(current);
        return {
          meta,
          channel: 'MARKETPLACE',
          columns: ['metric', 'value'],
          rows: Object.entries(c).map(([k, v]) => [k, String(v)]),
        };
      }
      case 'pos': {
        const rows = await this.pos(current, L);
        return {
          meta,
          channel: 'IN-STORE POS',
          columns: ['store_id', 'store_name', 'sales', 'total', 'voided'],
          rows: rows.map((r) => [
            r.store_id,
            r.store_name,
            String(r.sales),
            r.total,
            String(r.voided),
          ]),
        };
      }
      default:
        return null;
    }
  }
}

export { periodOf, localToday };
