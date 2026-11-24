import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ActorSnapshot, readActorSnapshot } from '../audit/audit-actor-context';
import { VendorMembership } from '../auth/vendor-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeAmountDue,
  computeAmountRefunded,
} from './branch-order-money.util';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): the branch's order queue, one order's
 * details and its timeline - READ ONLY. Nothing here changes a status,
 * stock, money or a notification; every action stays on the existing
 * BranchOrdersStaffController endpoints with their own checks.
 *
 * Tabs are views of the REAL statuses (no new state):
 *   new = PLACED · preparing = PREPARING · with_courier = SENT ·
 *   awaiting_confirmation = DELIVERED with no open «لم يصل» report ·
 *   attention = DELIVERY_FAILED, REFUND_REQUESTED, or DELIVERED with an
 *   open report · done = COMPLETED, CANCELLED, REFUNDED (and the transient
 *   PICKED_UP) · active = everything but done (the default).
 *
 * The due time of an order is its delivery slot's start - exactly the
 * expression the fulfilment sweeps use ((scheduledDate AT TIME ZONE 'UTC')
 * + startMinute). A pickup order has no slot, so no due time. «متأخر» =
 * still PLACED/PREPARING after its slot started (the moment the
 * slot-missed sweep would act on it).
 */

export const QUEUE_TABS = [
  'active',
  'new',
  'preparing',
  'with_courier',
  'awaiting_confirmation',
  'attention',
  'done',
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const QUEUE_SORTS = ['priority', 'newest'] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

export interface QueueQuery {
  tab?: QueueTab;
  method?: 'PICKUP' | 'DELIVERY';
  late?: boolean;
  q?: string;
  /** «نوافذ التوصيل v1»: one delivery date / window (from the 7-day board). */
  date?: string;
  window?: string;
  /** owner, all branches: narrow to one branch */
  branch?: string;
  sort?: QueueSort;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TIMELINE_LIMIT = 200;

const ORDER_STATUSES = new Set([
  'PLACED',
  'PREPARING',
  'SENT',
  'DELIVERED',
  'PICKED_UP',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'DELIVERY_FAILED',
  'REFUND_REQUESTED',
]);

const BUCKET = Prisma.sql`CASE
    WHEN bo.status = 'PLACED' THEN 'new'
    WHEN bo.status = 'PREPARING' THEN 'preparing'
    WHEN bo.status = 'SENT' THEN 'with_courier'
    WHEN bo.status = 'DELIVERED' AND bo."notReceivedReportedAt" IS NULL THEN 'awaiting_confirmation'
    WHEN bo.status IN ('DELIVERED', 'DELIVERY_FAILED', 'REFUND_REQUESTED') THEN 'attention'
    ELSE 'done'
  END`;
const DUE_AT = Prisma.sql`CASE
    WHEN bo."scheduledDate" IS NOT NULL AND dw.id IS NOT NULL
    THEN (bo."scheduledDate" AT TIME ZONE 'UTC') + (dw."startMinute" || ' minutes')::interval
  END`;
const IS_LATE = Prisma.sql`(q.bucket IN ('new', 'preparing') AND q.due_at IS NOT NULL AND q.due_at < now())`;

/** «سارة أحمد» -> «سارة أ.»: the list never shows a full name. */
export function shortName(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${Array.from(parts[1])[0]}.`;
}

/** The search box: an order number (the first characters of its id, as the
 * customer sees it at checkout), the last 4 digits of the phone, or the
 * 6-digit pickup code. Anything else matches nothing. */
function searchCondition(raw: string | undefined): Prisma.Sql | null {
  const q = (raw ?? '')
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  if (!q) return null;
  const parts: Prisma.Sql[] = [];
  if (/^[0-9a-f-]{4,36}$/.test(q)) {
    parts.push(Prisma.sql`lower(bo.id) LIKE ${`${q}%`}`);
  }
  if (/^\d{4}$/.test(q)) {
    parts.push(Prisma.sql`u.phone LIKE ${`%${q}`}`);
  }
  if (/^\d{6}$/.test(q)) {
    parts.push(
      Prisma.sql`(bo."fulfilmentMethod" = 'PICKUP' AND bo."pickupCode" = ${q})`,
    );
  }
  if (parts.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

type Viewer = { userId: string; membership: VendorMembership };
const isOwner = (v: Viewer) => v.membership.role === 'OWNER';

@Injectable()
export class BranchOrderQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: FulfilmentReconciliationService,
  ) {}

  async requireBranch(vendorId: string, branchId: string) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
      select: { id: true, vendorId: true, name: true },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    return branch;
  }

  // ------------------------------------------------------------------
  // The queue
  // ------------------------------------------------------------------

  /**
   * The queue of one branch, or - branchId null, the OWNER only (the caller
   * enforces it) - of every branch of the store (optionally narrowed by
   * query.branch). Rows always carry their branch; the all-branches scope
   * also returns each branch's active count for the branch filter.
   */
  async list(
    vendorId: string,
    branchId: string | null,
    viewer: Viewer,
    query: QueueQuery,
    correlationId: string,
  ) {
    if (branchId) await this.requireBranch(vendorId, branchId);
    else if (!isOwner(viewer)) {
      throw new ForbiddenException({
        code: 'QUEUE_ALL_BRANCHES_OWNER_ONLY',
        message: 'Only the store owner can list the orders of every branch',
      });
    }
    if (!branchId && query.branch)
      await this.requireBranch(vendorId, query.branch);
    const scopeBranch = branchId ?? query.branch ?? null;
    const tab: QueueTab = query.tab ?? 'active';
    const sort: QueueSort =
      query.sort ?? (tab === 'done' ? 'newest' : 'priority');
    if (query.sort === 'newest' && !isOwner(viewer)) {
      throw new ForbiddenException({
        code: 'QUEUE_SORT_OWNER_ONLY',
        message: 'Only the store owner can list the newest orders first',
      });
    }
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = query.cursor ? Number(query.cursor) : 0;

    // The existing lazy reconciliation of delivered orders (48h reminder /
    // 72h auto-confirm), the SAME call the old branch list makes on every
    // load - kept so opening this queue instead of the old list never
    // delays those customer notifications. Nothing else here writes.
    const delivered = await this.prisma.branchOrder.findMany({
      where: {
        vendorId,
        ...(scopeBranch ? { branchId: scopeBranch } : {}),
        status: 'DELIVERED',
        deliveredAt: { not: null },
      },
      select: { id: true },
    });
    if (delivered.length > 0) {
      await this.reconciliation.reconcileMany(
        delivered.map((d) => d.id),
        correlationId,
      );
    }

    const filters: Prisma.Sql[] = [Prisma.sql`bo."vendorId" = ${vendorId}`];
    if (query.date) {
      filters.push(Prisma.sql`bo."scheduledDate" = ${query.date}::date`);
    }
    if (query.window) {
      filters.push(Prisma.sql`bo."deliveryWindowId" = ${query.window}`);
    }
    if (query.method) {
      filters.push(Prisma.sql`bo."fulfilmentMethod"::text = ${query.method}`);
    }
    const search = searchCondition(query.q);
    if (search) filters.push(search);
    // the branch filter last: the all-branches counts per branch use the
    // same filters without it
    const otherFilters = [...filters];
    if (scopeBranch) {
      filters.push(Prisma.sql`bo."branchId" = ${scopeBranch}`);
    }
    const base = Prisma.sql`
      SELECT bo.id, bo."createdAt" AS created_at, ${BUCKET} AS bucket, ${DUE_AT} AS due_at
      FROM branch_orders bo
      LEFT JOIN delivery_windows dw ON dw.id = bo."deliveryWindowId"
      JOIN customer_orders co ON co.id = bo."customerOrderId"
      JOIN customer_profiles cp ON cp.id = co."customerId"
      JOIN users u ON u.id = cp."userId"
      WHERE ${Prisma.join(filters, ' AND ')}`;

    const tabCond =
      tab === 'active'
        ? Prisma.sql`q.bucket <> 'done'`
        : Prisma.sql`q.bucket = ${tab}`;
    const lateCond = query.late ? Prisma.sql`AND ${IS_LATE}` : Prisma.empty;
    const orderBy =
      sort === 'newest'
        ? Prisma.sql`q.created_at DESC, q.id DESC`
        : Prisma.sql`${IS_LATE} DESC,
            CASE WHEN ${IS_LATE} THEN q.due_at END ASC,
            CASE WHEN q.due_at >= now() THEN q.due_at END ASC NULLS LAST,
            q.created_at ASC, q.id ASC`;

    const page = await this.prisma.$queryRaw<
      { id: string; due_at: Date | null; is_late: boolean }[]
    >`WITH q AS (${base})
      SELECT q.id, q.due_at, ${IS_LATE} AS is_late FROM q
      WHERE ${tabCond} ${lateCond}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1} OFFSET ${offset}`;
    const countRows = await this.prisma.$queryRaw<
      { bucket: string; n: number; late: number }[]
    >`WITH q AS (${base})
      SELECT q.bucket, count(*)::int AS n,
        (count(*) FILTER (WHERE ${IS_LATE}))::int AS late
      FROM q GROUP BY q.bucket`;

    const counts: Record<QueueTab | 'late', number> = {
      active: 0,
      new: 0,
      preparing: 0,
      with_courier: 0,
      awaiting_confirmation: 0,
      attention: 0,
      done: 0,
      late: 0,
    };
    for (const r of countRows) {
      if (r.bucket in counts) counts[r.bucket as QueueTab] = r.n;
      if (r.bucket !== 'done') counts.active += r.n;
      counts.late += r.late;
    }

    // all branches: each branch's active (not done) orders, for the filter
    let branchCounts: { branch_id: string; active: number }[] | undefined;
    if (!branchId) {
      const perBranch = await this.prisma.$queryRaw<
        { branch_id: string; n: number }[]
      >`SELECT bo."branchId" AS branch_id, count(*)::int AS n
        FROM branch_orders bo
        LEFT JOIN delivery_windows dw ON dw.id = bo."deliveryWindowId"
        JOIN customer_orders co ON co.id = bo."customerOrderId"
        JOIN customer_profiles cp ON cp.id = co."customerId"
        JOIN users u ON u.id = cp."userId"
        WHERE ${Prisma.join(otherFilters, ' AND ')} AND ${BUCKET} <> 'done'
        GROUP BY bo."branchId"`;
      branchCounts = perBranch.map((r) => ({
        branch_id: r.branch_id,
        active: r.n,
      }));
    }

    const shown = page.slice(0, limit);
    const meta = new Map(shown.map((r) => [r.id, r]));
    const rows = await this.prisma.branchOrder.findMany({
      where: { id: { in: shown.map((r) => r.id) } },
      include: {
        customerOrder: {
          select: {
            customer: {
              select: { displayName: true, user: { select: { phone: true } } },
            },
          },
        },
        items: {
          select: { unitPrice: true, quantity: true, cancelledAt: true },
        },
        refunds: { select: { amount: true, reason: true } },
        deliveryWindow: { select: { startMinute: true, endMinute: true } },
        branch: { select: { name: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const owner = isOwner(viewer);
    const items = shown.flatMap((s) => {
      const o = byId.get(s.id);
      if (!o) return [];
      const m = meta.get(s.id)!;
      const phone = o.customerOrder.customer.user.phone;
      return [
        {
          id: o.id,
          number: o.id.slice(0, 8),
          branch_id: o.branchId,
          branch_name: o.branch.name,
          status: o.status,
          bucket: bucketOf(o.status, o.notReceivedReportedAt),
          fulfilment_method: o.fulfilmentMethod,
          payment_method: o.paymentMethod,
          created_at: o.createdAt.toISOString(),
          scheduled_date: isoDate(o.scheduledDate),
          window: o.deliveryWindow
            ? {
                start_minute: o.deliveryWindow.startMinute,
                end_minute: o.deliveryWindow.endMinute,
              }
            : null,
          due_at: m.due_at ? new Date(m.due_at).toISOString() : null,
          is_late: m.is_late,
          customer_short: shortName(o.customerOrder.customer.displayName),
          phone_last4: phone.slice(-4),
          item_count: pieceCount(
            o.items.map((i) => ({
              quantity: i.quantity,
              cancelled: i.cancelledAt !== null,
            })),
          ),
          ...(owner ? { total: Number(o.total) } : {}),
          amount_due: amountDueOf(o),
          has_open_not_received_report: o.notReceivedReportedAt !== null,
        },
      ];
    });
    return {
      items,
      next_cursor: page.length > limit ? String(offset + limit) : null,
      counts,
      ...(branchCounts ? { branch_counts: branchCounts } : {}),
      scope: branchId ? 'branch' : 'all',
      tab,
      sort,
    };
  }

  // ------------------------------------------------------------------
  // One order
  // ------------------------------------------------------------------

  private async requireOrder(
    vendorId: string,
    branchId: string,
    branchOrderId: string,
  ) {
    const order = await this.prisma.branchOrder.findUnique({
      where: { id: branchOrderId },
      include: {
        customerOrder: {
          select: {
            customer: {
              select: {
                displayName: true,
                userId: true,
                user: { select: { phone: true } },
              },
            },
          },
        },
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            offerVariant: {
              select: {
                sizeCode: true,
                vendorOffer: { select: { titleAr: true, titleEn: true } },
              },
            },
          },
        },
        refunds: { select: { amount: true, reason: true } },
        deliveryWindow: {
          select: { startMinute: true, endMinute: true, dayOfWeek: true },
        },
      },
    });
    // the same rule as every staff action: an order of another vendor or
    // branch does not exist here (never a hint that it exists elsewhere)
    if (!order || order.vendorId !== vendorId || order.branchId !== branchId) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found for this branch',
      });
    }
    return order;
  }

  async detail(
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    viewer: Viewer,
  ) {
    await this.requireBranch(vendorId, branchId);
    const o = await this.requireOrder(vendorId, branchId, branchOrderId);
    const owner = isOwner(viewer);
    const media = await this.prisma.offerVariantMedia.findMany({
      where: {
        vendorId,
        offerVariantId: { in: o.items.map((i) => i.offerVariantId) },
        kind: 'PRIMARY',
        mediaType: 'IMAGE',
      },
      orderBy: { sortOrder: 'asc' },
      select: { offerVariantId: true, url: true },
    });
    const imageBy = new Map<string, string>();
    for (const m of media) {
      if (!imageBy.has(m.offerVariantId)) imageBy.set(m.offerVariantId, m.url);
    }
    const ownOrder = o.customerOrder.customer.userId === viewer.userId;
    const amountDue = amountDueOf(o);
    const items = o.items.map((i) => ({
      id: i.id,
      title_ar: i.titleArSnapshot ?? i.offerVariant.vendorOffer.titleAr,
      title_en: i.titleEnSnapshot ?? i.offerVariant.vendorOffer.titleEn,
      color_name_ar: i.colorNameArSnapshot ?? i.colorLabelSnapshot ?? null,
      color_name_en: i.colorNameEnSnapshot ?? i.colorLabelSnapshot ?? null,
      color_hex: i.colorHexSnapshot ?? null,
      size_label:
        i.sizeLabelSnapshot ?? i.sizeCodeSnapshot ?? i.offerVariant.sizeCode,
      quantity: i.quantity,
      cancelled: i.cancelledAt !== null,
      image_url: imageBy.get(i.offerVariantId) ?? null,
      ...(owner
        ? {
            unit_price: Number(i.unitPrice),
            line_total: Number(i.unitPrice) * i.quantity,
          }
        : {}),
    }));
    return {
      id: o.id,
      number: o.id.slice(0, 8),
      status: o.status,
      bucket: bucketOf(o.status, o.notReceivedReportedAt),
      fulfilment_method: o.fulfilmentMethod,
      payment_method: o.paymentMethod,
      created_at: o.createdAt.toISOString(),
      scheduled_date: isoDate(o.scheduledDate),
      window: o.deliveryWindow
        ? {
            day_of_week: o.deliveryWindow.dayOfWeek,
            start_minute: o.deliveryWindow.startMinute,
            end_minute: o.deliveryWindow.endMinute,
          }
        : null,
      due_at: dueAt(o.scheduledDate, o.deliveryWindow?.startMinute ?? null),
      is_late: isLate(
        o.status,
        dueAt(o.scheduledDate, o.deliveryWindow?.startMinute ?? null),
      ),
      // the same as both roles' lists show today (RB-ORD-004: no address)
      customer: {
        name: o.customerOrder.customer.displayName,
        phone: o.customerOrder.customer.user.phone,
      },
      items,
      item_count: pieceCount(items),
      payment: owner
        ? {
            method: o.paymentMethod,
            subtotal: Number(o.subtotal),
            delivery_fee: o.deliveryFee !== null ? Number(o.deliveryFee) : null,
            total: Number(o.total),
            refunded: computeAmountRefunded(o.refunds).toNumber(),
            amount_due: amountDue,
            cod_collected_amount:
              o.codCollectedAmount !== null
                ? Number(o.codCollectedAmount)
                : null,
          }
        : {
            method: o.paymentMethod,
            amount_due: amountDue,
            cod_collected_amount:
              o.codCollectedAmount !== null
                ? Number(o.codCollectedAmount)
                : null,
          },
      customer_note: o.customerNote,
      internal_store_note: o.internalStoreNote,
      not_received: owner
        ? {
            open: o.notReceivedReportedAt !== null,
            reported_at: o.notReceivedReportedAt?.toISOString() ?? null,
            reason: o.notReceivedReason,
          }
        : { open: o.notReceivedReportedAt !== null },
      ...(owner ? { cancellation_reason: o.cancellationReason } : {}),
      delivery_attempt_count: o.deliveryAttemptCount,
      is_own_order: ownOrder,
      actions: allowedActions(o, ownOrder),
    };
  }

  // ------------------------------------------------------------------
  // The timeline
  // ------------------------------------------------------------------

  async timeline(
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    viewer: Viewer,
  ) {
    await this.requireBranch(vendorId, branchId);
    const o = await this.requireOrder(vendorId, branchId, branchOrderId);
    const owner = isOwner(viewer);
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: 'BranchOrder', entityId: o.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_LIMIT + 1,
      select: {
        id: true,
        actorId: true,
        action: true,
        beforeState: true,
        afterState: true,
        occurredAt: true,
        actor: {
          select: { customerProfile: { select: { displayName: true } } },
        },
      },
    });
    const customerUserId = o.customerOrder.customer.userId;
    const snapshots = new Map(
      rows.map((r) => [r.id, readActorSnapshot(r.afterState)]),
    );
    const branchIds = [
      ...new Set(
        [...snapshots.values()]
          .map((s) => s?.branch_id)
          .filter((b): b is string => Boolean(b)),
      ),
    ];
    const branches =
      owner && branchIds.length
        ? await this.prisma.storeBranch.findMany({
            where: { vendorId, id: { in: branchIds } },
            select: { id: true, name: true },
          })
        : [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // the reason of the closing (or failed-delivery) step, owner only - the
    // same field the owner's list already shows
    let reasonGiven = false;
    const items = rows.slice(0, TIMELINE_LIMIT).flatMap((r) => {
      const kind = eventKind(r.action);
      if (!kind) return [];
      if (!owner && (kind === 'self_fulfilment' || kind === 'integrity'))
        return [];
      const snap = snapshots.get(r.id) ?? null;
      const before = statusOf(r.beforeState);
      const after = statusOf(r.afterState);
      let reason: string | null = null;
      if (
        owner &&
        !reasonGiven &&
        kind === 'status' &&
        (after === 'CANCELLED' || after === 'DELIVERY_FAILED') &&
        o.cancellationReason
      ) {
        reason = o.cancellationReason;
        reasonGiven = true;
      }
      return [
        {
          id: r.id,
          at: r.occurredAt.toISOString(),
          kind,
          from_status: kind === 'status' ? before : null,
          to_status: kind === 'status' ? after : null,
          actor: actorView({
            actorId: r.actorId,
            customerUserId,
            snapshot: snap,
            currentName: r.actor?.customerProfile?.displayName ?? null,
            viewer,
            orderBranchId: o.branchId,
            branchName,
          }),
          ...(reason ? { reason } : {}),
        },
      ];
    });
    return { items, truncated: rows.length > TIMELINE_LIMIT };
  }
}

// ----------------------------------------------------------------------
// helpers (pure)
// ----------------------------------------------------------------------

function bucketOf(
  status: string,
  notReceivedReportedAt: Date | null,
): QueueTab {
  switch (status) {
    case 'PLACED':
      return 'new';
    case 'PREPARING':
      return 'preparing';
    case 'SENT':
      return 'with_courier';
    case 'DELIVERED':
      return notReceivedReportedAt ? 'attention' : 'awaiting_confirmation';
    case 'DELIVERY_FAILED':
    case 'REFUND_REQUESTED':
      return 'attention';
    default:
      return 'done';
  }
}

/** The slot's start - the same instant as the sweeps' SQL expression. */
function dueAt(
  scheduledDate: Date | null,
  startMinute: number | null,
): string | null {
  if (!scheduledDate || startMinute === null) return null;
  const day = Date.UTC(
    scheduledDate.getUTCFullYear(),
    scheduledDate.getUTCMonth(),
    scheduledDate.getUTCDate(),
  );
  return new Date(day + startMinute * 60_000).toISOString();
}

function isLate(status: string, due: string | null): boolean {
  return (
    (status === 'PLACED' || status === 'PREPARING') &&
    due !== null &&
    new Date(due).getTime() < Date.now()
  );
}

/** The pieces still in the order; a fully cancelled order counts what it had
 * (never «0 pieces»). */
function pieceCount(items: { quantity: number; cancelled: boolean }[]): number {
  const active = items
    .filter((i) => !i.cancelled)
    .reduce((n, i) => n + i.quantity, 0);
  return active > 0 ? active : items.reduce((n, i) => n + i.quantity, 0);
}

function amountDueOf(o: {
  paymentMethod: string;
  total: unknown;
  deliveryFee: unknown;
  items: { unitPrice: unknown; quantity: number; cancelledAt: Date | null }[];
  refunds: { reason: string }[];
}): number | null {
  if (o.paymentMethod !== 'COD') return null;
  return computeAmountDue(
    o.total,
    o.items,
    o.refunds.some((r) => r.reason === 'DELIVERY_FEE'),
    o.deliveryFee,
  ).toNumber();
}

export interface QueueAction {
  key:
    | 'start_preparation'
    | 'mark_sent'
    | 'pickup_handover'
    | 'mark_delivered'
    | 'mark_delivery_failed'
    | 'rerequest_confirmation'
    | 'approve_refund'
    | 'cancel'
    | 'internal_note';
  primary?: boolean;
  /** cancel: whether the server requires a reason (after preparation started). */
  reason?: 'optional' | 'required';
  /** mark_delivery_failed: this attempt closes the order (COD, second failure). */
  closes_order?: boolean;
}

/**
 * The next steps the existing endpoints accept for this order - the same
 * conditions each of them checks (status, method, payment, attempts, an
 * open report, «not your own order» where it applies). The server decides
 * again on every action; this only keeps the screen from offering a step
 * that would be refused.
 */
export function allowedActions(
  o: {
    status: string;
    fulfilmentMethod: string;
    paymentMethod: string;
    deliveryAttemptCount: number;
    notReceivedReportedAt: Date | null;
  },
  ownOrder: boolean,
): QueueAction[] {
  const a: QueueAction[] = [];
  switch (o.status) {
    case 'PLACED':
      a.push({ key: 'start_preparation', primary: true });
      if (!ownOrder) a.push({ key: 'cancel', reason: 'optional' });
      break;
    case 'PREPARING':
      if (o.fulfilmentMethod === 'DELIVERY')
        a.push({ key: 'mark_sent', primary: true });
      if (o.fulfilmentMethod === 'PICKUP')
        a.push({ key: 'pickup_handover', primary: true });
      if (!ownOrder) a.push({ key: 'cancel', reason: 'required' });
      break;
    case 'SENT':
      a.push({ key: 'mark_delivered', primary: true });
      a.push({
        key: 'mark_delivery_failed',
        closes_order: o.paymentMethod === 'COD' && o.deliveryAttemptCount >= 1,
      });
      break;
    case 'DELIVERED':
      if (o.notReceivedReportedAt)
        a.push({ key: 'rerequest_confirmation', primary: true });
      break;
    case 'REFUND_REQUESTED':
      if (!ownOrder) a.push({ key: 'approve_refund', primary: true });
      break;
    default:
      break;
  }
  a.push({ key: 'internal_note' });
  return a;
}

type EventKind =
  | 'created'
  | 'status'
  | 'internal_note'
  | 'not_received'
  | 'confirmation_rerequested'
  | 'address_changed'
  | 'converted_to_pickup'
  | 'item_cancelled'
  | 'self_fulfilment'
  | 'integrity';

/** A closed list: an audit action not named here is never shown. */
function eventKind(action: string): EventKind | null {
  switch (action) {
    case 'branch_order.created':
      return 'created';
    case 'branch_order.status_changed':
      return 'status';
    case 'branch_order.internal_note_updated':
      return 'internal_note';
    case 'branch_order.not_received_reported':
      return 'not_received';
    case 'branch_order.confirmation_rerequested':
      return 'confirmation_rerequested';
    case 'branch_order.address_changed':
      return 'address_changed';
    case 'branch_order.converted_to_pickup':
      return 'converted_to_pickup';
    case 'branch_order_item.cancelled':
      return 'item_cancelled';
    case 'branch_order.self_fulfilment':
      return 'self_fulfilment';
    default:
      return action.startsWith('branch_order.integrity') ? 'integrity' : null;
  }
}

function statusOf(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const s = (state as Record<string, unknown>).status;
  return typeof s === 'string' && ORDER_STATUSES.has(s) ? s : null;
}

type ActorView =
  | { kind: 'system' }
  | { kind: 'customer' }
  | { kind: 'owner'; name: string | null }
  | {
      kind: 'employee';
      name: string | null;
      branch_name?: string | null;
      other_branch?: boolean;
    }
  | { kind: 'employee_other_branch' }
  | { kind: 'platform' }
  | { kind: 'unrecorded'; name?: string | null };

/**
 * Who did it, as this viewer may see it. The snapshot (role and branch AT
 * THAT MOMENT) decides; without one (an older row) the role is
 * «غير مسجّل» - never guessed from today's membership. An employee never
 * sees the name of someone from another branch, nor of an unrecorded actor.
 */
export function actorView(args: {
  actorId: string | null;
  customerUserId: string;
  snapshot: ActorSnapshot | null;
  currentName: string | null;
  viewer: Viewer;
  orderBranchId: string;
  branchName: Map<string, string>;
}): ActorView {
  const { actorId, snapshot: snap, viewer } = args;
  const owner = isOwner(viewer);
  if (!actorId) return { kind: 'system' };
  if (snap) {
    if (snap.role === 'PLATFORM_STAFF') return { kind: 'platform' };
    if (snap.role === 'OWNER')
      return { kind: 'owner', name: snap.display_name };
    if (owner) {
      return {
        kind: 'employee',
        name: snap.display_name,
        branch_name: snap.branch_id
          ? (args.branchName.get(snap.branch_id) ?? null)
          : null,
        other_branch: snap.branch_id !== args.orderBranchId,
      };
    }
    if (snap.branch_id && snap.branch_id === viewer.membership.branchId) {
      return { kind: 'employee', name: snap.display_name };
    }
    return { kind: 'employee_other_branch' };
  }
  if (actorId === args.customerUserId) return { kind: 'customer' };
  return owner
    ? { kind: 'unrecorded', name: args.currentName }
    : { kind: 'unrecorded' };
}
