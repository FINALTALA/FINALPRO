import {
  ConflictException,
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
import {
  missingRequired,
  PREP_ITEM_KEYS,
  PREP_ITEMS,
} from './branch-order-prep.service';

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
  // «إدارة طلبات الفرع v2» phase 2: PREPARING with readyAt (a sub-state)
  'ready',
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
  /** cash on delivery only */
  pay?: 'COD';
  /** placed today (Palestine date) */
  created?: 'today';
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
    WHEN bo.status = 'PREPARING' AND bo."readyAt" IS NOT NULL THEN 'ready'
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
const IS_LATE = Prisma.sql`(q.bucket IN ('new', 'preparing', 'ready') AND q.due_at IS NOT NULL AND q.due_at < now())`;

/** «سارة أحمد» -> «سارة أ.»: the list never shows a full name. */
export function shortName(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${Array.from(parts[1])[0]}.`;
}

/** Escapes LIKE's own wildcards so a typed «%» or «_» is just a character. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The search box: an order number (the first characters of its id, as the
 * customer sees it at checkout), the shopper's name (part of it, any case),
 * or the last 4 digits of the phone. Anything else matches nothing.
 *
 * «إدارة طلبات الفرع v2» phase 1 (2026-11-24): the pickup code is NO LONGER
 * a search key - a 6-digit query is only ever an order-number prefix. The
 * code is checked only at the hand-over of one order. Every query is a bound
 * parameter (never SQL text) and is ANDed with the viewer's branch / store
 * scope, so a name search never reaches beyond the queue she may read. */
export function searchCondition(raw: string | undefined): Prisma.Sql | null {
  const text = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const compact = text.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
  const parts: Prisma.Sql[] = [];
  if (/^[0-9a-f-]{4,36}$/.test(compact)) {
    parts.push(Prisma.sql`lower(bo.id) LIKE ${`${likeLiteral(compact)}%`}`);
  }
  if (/^\d{4}$/.test(compact)) {
    parts.push(Prisma.sql`u.phone LIKE ${`%${compact}`}`);
  }
  // a name: at least 2 letters, matched anywhere in the shopper's name
  const name = text.replace(/^#/, '').trim();
  if ((name.match(/\p{L}/gu) ?? []).length >= 2) {
    parts.push(Prisma.sql`cp."displayName" ILIKE ${`%${likeLiteral(name)}%`}`);
  }
  if (parts.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/** Palestine time - the same calendar as delivery windows and opening hours.
 * The timestamp columns hold UTC without a zone, hence the double AT TIME ZONE. */
const ZONE = 'Asia/Hebron';
const CREATED_TODAY = Prisma.sql`((bo."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ZONE})::date = (now() AT TIME ZONE ${ZONE})::date`;

/** A person as the order screen names them: the display name only. */
const PERSON = {
  customerProfile: { select: { displayName: true } },
} as const;
type Person = { customerProfile: { displayName: string | null } | null };
const nameOf = (p: Person | null | undefined) =>
  p?.customerProfile?.displayName ?? null;

/**
 * «إدارة طلبات الفرع v2» phase 2: the order's preparation as the screen
 * shows it - started / ready (when, by whom and their role then), the saved
 * checklist (each item done or not, when, by whom), what is still missing,
 * and whether this viewer may change it (PREPARING, not ready yet, and
 * never an employee on her own order). requires_ready: the order is on the
 * new path (started from the release on) - older ones show none of it.
 */
function preparationView(
  o: {
    status: string;
    preparationStartedAt: Date | null;
    preparationStartedByRole: string | null;
    preparationStartedBy: Person | null;
    readyAt: Date | null;
    readyByRole: string | null;
    readyBy: Person | null;
    prepChecks: {
      itemKey: string;
      doneAt: Date;
      doneByRole: string;
      doneBy: Person;
    }[];
  },
  ownOrder: boolean,
  viewer: Viewer,
) {
  const byKey = new Map(o.prepChecks.map((c) => [c.itemKey, c]));
  const preparing = o.status === 'PREPARING';
  const ready = o.readyAt !== null;
  const ownBlocked = ownOrder && viewer.membership.role === 'BRANCH_EMPLOYEE';
  return {
    requires_ready: o.preparationStartedAt !== null,
    started_at: o.preparationStartedAt?.toISOString() ?? null,
    started_by: o.preparationStartedAt
      ? {
          name: nameOf(o.preparationStartedBy),
          role: o.preparationStartedByRole,
        }
      : null,
    is_ready: preparing && ready,
    ready_at: o.readyAt?.toISOString() ?? null,
    ready_by: o.readyAt
      ? { name: nameOf(o.readyBy), role: o.readyByRole }
      : null,
    checklist: PREP_ITEMS.map((i) => {
      const c = byKey.get(i.key);
      return {
        key: i.key,
        required: i.required,
        done: Boolean(c),
        done_at: c ? c.doneAt.toISOString() : null,
        done_by: c ? { name: nameOf(c.doneBy), role: c.doneByRole } : null,
      };
    }),
    missing: missingRequired(byKey.keys()),
    can_edit: preparing && !ready && !ownBlocked,
    own_order_blocked: preparing && !ready && ownBlocked,
  };
}

/** The checklist item of a prep_check audit row (a closed key, else null). */
function prepItemOf(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const k = (state as Record<string, unknown>).item;
  return typeof k === 'string' && PREP_ITEM_KEYS.includes(k) ? k : null;
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
    if (query.pay === 'COD') {
      filters.push(Prisma.sql`bo."paymentMethod"::text = 'COD'`);
    }
    if (query.created === 'today') filters.push(CREATED_TODAY);
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
      ready: 0,
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
          bucket: bucketOf(o.status, o.notReceivedReportedAt, o.readyAt),
          fulfilment_method: o.fulfilmentMethod,
          payment_method: o.paymentMethod,
          created_at: o.createdAt.toISOString(),
          // phase 2: «جاهز» (PREPARING with readyAt)
          is_ready: o.status === 'PREPARING' && o.readyAt !== null,
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
        // phase 2: who started / readied it, and the saved checklist
        preparationStartedBy: { select: PERSON },
        readyBy: { select: PERSON },
        prepChecks: {
          select: {
            itemKey: true,
            doneAt: true,
            doneByRole: true,
            doneBy: { select: PERSON },
          },
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
      bucket: bucketOf(o.status, o.notReceivedReportedAt, o.readyAt),
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
      // «إدارة طلبات الفرع v2» phase 2: preparation, the saved checklist, «جاهز»
      preparation: preparationView(o, ownOrder, viewer),
      actions: allowedActions(o, ownOrder, viewer.membership.role),
    };
  }

  // ------------------------------------------------------------------
  // The internal prep sheet (one order)
  // ------------------------------------------------------------------

  /**
   * «إدارة طلبات الفرع v2» phase 1 (2026-11-24): what the team needs to
   * prepare ONE order - its number, branch, fulfilment, the pieces (title,
   * colour, size, quantity; cancelled lines left out) and the shopper's /
   * the team's notes. Never the pickup code, never a price, never the
   * shopper's name, phone or address: an internal sheet, not a receipt.
   * Only while the order still needs preparing (PLACED) or is being
   * prepared (PREPARING); otherwise 409 PREP_SHEET_NOT_AVAILABLE. The same
   * boundary as the details (the guard + another branch / store = 404).
   */
  async prepSheet(vendorId: string, branchId: string, branchOrderId: string) {
    const branch = await this.requireBranch(vendorId, branchId);
    const o = await this.requireOrder(vendorId, branchId, branchOrderId);
    if (o.status !== 'PLACED' && o.status !== 'PREPARING') {
      throw new ConflictException({
        code: 'PREP_SHEET_NOT_AVAILABLE',
        message:
          'A prep sheet exists only for an order that is new or being prepared',
      });
    }
    const items = o.items
      .filter((i) => i.cancelledAt === null)
      .map((i) => ({
        id: i.id,
        title_ar: i.titleArSnapshot ?? i.offerVariant.vendorOffer.titleAr,
        title_en: i.titleEnSnapshot ?? i.offerVariant.vendorOffer.titleEn,
        color_name_ar: i.colorNameArSnapshot ?? i.colorLabelSnapshot ?? null,
        color_name_en: i.colorNameEnSnapshot ?? i.colorLabelSnapshot ?? null,
        size_label:
          i.sizeLabelSnapshot ?? i.sizeCodeSnapshot ?? i.offerVariant.sizeCode,
        quantity: i.quantity,
      }));
    return {
      id: o.id,
      number: o.id.slice(0, 8),
      branch_name: branch.name,
      status: o.status,
      fulfilment_method: o.fulfilmentMethod,
      created_at: o.createdAt.toISOString(),
      scheduled_date: isoDate(o.scheduledDate),
      window: o.deliveryWindow
        ? {
            start_minute: o.deliveryWindow.startMinute,
            end_minute: o.deliveryWindow.endMinute,
          }
        : null,
      items,
      item_count: items.reduce((n, i) => n + i.quantity, 0),
      customer_note: o.customerNote,
      internal_store_note: o.internalStoreNote,
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
          // phase 2: which checklist item (a closed key)
          ...(kind === 'prep_check' || kind === 'prep_uncheck'
            ? { item: prepItemOf(r.afterState) }
            : {}),
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
  readyAt: Date | null,
): QueueTab {
  switch (status) {
    case 'PLACED':
      return 'new';
    case 'PREPARING':
      return readyAt ? 'ready' : 'preparing';
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
    | 'internal_note'
    | 'mark_ready';
  primary?: boolean;
  /** mark_ready: the mandatory checklist items still missing (none = it can be done) */
  missing?: string[];
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
    preparationStartedAt?: Date | null;
    readyAt?: Date | null;
    prepChecks?: { itemKey: string }[];
  },
  ownOrder: boolean,
  viewerRole: string = 'OWNER',
): QueueAction[] {
  // 2026-11-24 (approved policy): an employee runs no operational action on
  // her own order - the server refuses every one (OWN_ORDER_FORBIDDEN), so
  // none is offered
  if (ownOrder && viewerRole === 'BRANCH_EMPLOYEE') return [];
  const a: QueueAction[] = [];
  switch (o.status) {
    case 'PLACED':
      a.push({ key: 'start_preparation', primary: true });
      if (!ownOrder) a.push({ key: 'cancel', reason: 'optional' });
      break;
    case 'PREPARING': {
      // phase 2: an order on the new path is sent / handed over only once
      // ready; until then its one step is «إعلان الطلب جاهزًا» (with what is
      // still missing - the server checks again). An employee never readies
      // her own order. Older orders (started before the release) keep the
      // old path.
      const gated =
        (o.preparationStartedAt ?? null) !== null &&
        (o.readyAt ?? null) === null;
      if (gated) {
        if (!(ownOrder && viewerRole === 'BRANCH_EMPLOYEE')) {
          a.push({
            key: 'mark_ready',
            primary: true,
            missing: missingRequired(
              (o.prepChecks ?? []).map((c) => c.itemKey),
            ),
          });
        }
      } else {
        if (o.fulfilmentMethod === 'DELIVERY')
          a.push({ key: 'mark_sent', primary: true });
        if (o.fulfilmentMethod === 'PICKUP')
          a.push({ key: 'pickup_handover', primary: true });
      }
      if (!ownOrder) a.push({ key: 'cancel', reason: 'required' });
      break;
    }
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
  | 'integrity'
  | 'prep_check'
  | 'prep_uncheck'
  | 'ready';

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
    // phase 2
    case 'branch_order.prep_check_done':
      return 'prep_check';
    case 'branch_order.prep_check_undone':
      return 'prep_uncheck';
    case 'branch_order.ready':
      return 'ready';
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
