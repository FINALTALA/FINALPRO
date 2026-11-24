import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { readActorSnapshot } from '../audit/audit-actor-context';
import { VendorMembership } from '../auth/vendor-membership.guard';
import { actorView, shortName } from '../orders/branch-order-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SIZE_GUIDE_SNAPSHOT_SELECT,
  sizeGuideSnapshotDto,
} from '../size-guides/size-guide-snapshot';
import {
  computeExchangeSettlement,
  computeReturnRefundAmount,
} from './return-policy.util';
import { ESCALATION_TIMEOUT_HOURS } from './return-sweep.service';
import { assertMayReceiveAt } from './returns.service';

/**
 * IX-P2 «لوحة إرجاعات الفرع» (2026-11-23): the branch's returns board -
 * READ ONLY. Every action stays on the existing endpoints (decision,
 * redeem) with their own checks; the code preview below never writes.
 *
 * Tabs are views of the REAL statuses (no new state):
 *   pending_decision = REQUESTED · awaiting_dropoff = APPROVED_AWAITING_DROPOFF
 *   · completed = RECEIVED, REFUND_PROCESSING, REFUNDED, EXCHANGED
 *   · closed = REJECTED, REJECTED_CLOSED, ADMIN_REJECTED, EXPIRED,
 *     CANCELLED_BY_CUSTOMER · platform = ESCALATED.
 *
 * A branch's returns are the returns of ITS orders (the branch that decides
 * them, as the existing decision endpoint). The raw return code is never
 * part of any answer here (IX-P1): it is the shopper's proof at the counter.
 */
export const RETURN_QUEUE_TABS = [
  'pending_decision',
  'awaiting_dropoff',
  'completed',
  'closed',
  'platform',
] as const;
export type ReturnQueueTab = (typeof RETURN_QUEUE_TABS)[number];

export interface ReturnQueueQuery {
  tab?: ReturnQueueTab;
  outcome?: 'RETURN' | 'EXCHANGE';
  /** created on or after / on or before (YYYY-MM-DD, Palestine time) */
  from?: string;
  to?: string;
  q?: string;
  /** owner, all branches: narrow to one branch */
  branch?: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TIMELINE_LIMIT = 200;
const ZONE = 'Asia/Hebron';

const BUCKET = Prisma.sql`CASE
    WHEN r.status = 'REQUESTED' THEN 'pending_decision'
    WHEN r.status = 'APPROVED_AWAITING_DROPOFF' THEN 'awaiting_dropoff'
    WHEN r.status = 'ESCALATED' THEN 'platform'
    WHEN r.status IN ('RECEIVED', 'REFUND_PROCESSING', 'REFUNDED', 'EXCHANGED') THEN 'completed'
    ELSE 'closed'
  END`;

export function bucketOfReturn(status: string): ReturnQueueTab {
  switch (status) {
    case 'REQUESTED':
      return 'pending_decision';
    case 'APPROVED_AWAITING_DROPOFF':
      return 'awaiting_dropoff';
    case 'ESCALATED':
      return 'platform';
    case 'RECEIVED':
    case 'REFUND_PROCESSING':
    case 'REFUNDED':
    case 'EXCHANGED':
      return 'completed';
    default:
      return 'closed';
  }
}

/** An order number or a return number (the first characters of the id), or
 * the last 4 digits of the shopper's phone. Never the return code. */
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
    parts.push(Prisma.sql`lower(r.id) LIKE ${`${q}%`}`);
  }
  if (/^\d{4}$/.test(q)) {
    parts.push(Prisma.sql`u.phone LIKE ${`%${q}`}`);
  }
  if (parts.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

type Viewer = { userId: string; membership: VendorMembership };
const isOwner = (v: Viewer) => v.membership.role === 'OWNER';

const RETURN_INCLUDE = {
  branchOrderItem: {
    include: {
      branchOrder: {
        select: {
          id: true,
          branchId: true,
          paymentMethod: true,
          returnPolicySnapshotMode: true,
          returnPolicySnapshotWindowDays: true,
          returnPolicySnapshotFeeIls: true,
          returnPolicySnapshotExchangeFeeIls: true,
          branch: { select: { name: true } },
          customerOrder: {
            select: {
              customer: {
                select: { displayName: true, userId: true },
              },
            },
          },
        },
      },
      offerVariant: {
        select: {
          sizeCode: true,
          vendorOffer: { select: { titleAr: true, titleEn: true } },
        },
      },
      sizeGuideVersionSnapshot: { select: SIZE_GUIDE_SNAPSHOT_SELECT },
    },
  },
  refund: { select: { amount: true, method: true } },
  exchangeSettlement: true,
  replacementOfferVariant: {
    select: {
      id: true,
      colour: true,
      size: true,
      sizeCode: true,
      offerColor: { select: { nameAr: true, nameEn: true, hex: true } },
      vendorOffer: { select: { titleAr: true, titleEn: true } },
    },
  },
  replacementBranch: { select: { id: true, name: true } },
  receivingBranch: { select: { id: true, name: true } },
} satisfies Prisma.ReturnInclude;

type ReturnRow = Prisma.ReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;

@Injectable()
export class BranchReturnQueueService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireBranch(vendorId: string, branchId: string) {
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

  /** Primary image of each variant (the order screen's rule). */
  private async imagesFor(vendorId: string, variantIds: string[]) {
    const media = variantIds.length
      ? await this.prisma.offerVariantMedia.findMany({
          where: {
            vendorId,
            offerVariantId: { in: [...new Set(variantIds)] },
            kind: 'PRIMARY',
            mediaType: 'IMAGE',
          },
          orderBy: { sortOrder: 'asc' },
          select: { offerVariantId: true, url: true },
        })
      : [];
    const by = new Map<string, string>();
    for (const m of media) {
      if (!by.has(m.offerVariantId)) by.set(m.offerVariantId, m.url);
    }
    return by;
  }

  // ------------------------------------------------------------------
  // The list
  // ------------------------------------------------------------------

  /**
   * The returns of one branch's orders, or - branchId null, OWNER only (the
   * caller enforces it, this re-checks) - of every branch of the store,
   * optionally narrowed with query.branch.
   */
  async list(
    vendorId: string,
    branchId: string | null,
    viewer: Viewer,
    query: ReturnQueueQuery,
  ) {
    if (branchId) await this.requireBranch(vendorId, branchId);
    else if (!isOwner(viewer)) {
      throw new ForbiddenException({
        code: 'RETURN_QUEUE_ALL_BRANCHES_OWNER_ONLY',
        message: 'Only the store owner can list the returns of every branch',
      });
    }
    if (!branchId && query.branch)
      await this.requireBranch(vendorId, query.branch);
    const scopeBranch = branchId ?? query.branch ?? null;
    const tab: ReturnQueueTab = query.tab ?? 'pending_decision';
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = query.cursor ? Number(query.cursor) : 0;

    const filters: Prisma.Sql[] = [Prisma.sql`r."vendorId" = ${vendorId}`];
    if (query.outcome) {
      filters.push(Prisma.sql`r."desiredOutcome"::text = ${query.outcome}`);
    }
    if (query.from) {
      filters.push(
        Prisma.sql`(r."createdAt" AT TIME ZONE ${ZONE})::date >= ${query.from}::date`,
      );
    }
    if (query.to) {
      filters.push(
        Prisma.sql`(r."createdAt" AT TIME ZONE ${ZONE})::date <= ${query.to}::date`,
      );
    }
    const search = searchCondition(query.q);
    if (search) filters.push(search);
    const otherFilters = [...filters];
    if (scopeBranch) filters.push(Prisma.sql`bo."branchId" = ${scopeBranch}`);

    const from = Prisma.sql`
      FROM returns r
      JOIN branch_order_items boi ON boi.id = r."branchOrderItemId"
      JOIN branch_orders bo ON bo.id = boi."branchOrderId"
      JOIN customer_orders co ON co.id = bo."customerOrderId"
      JOIN customer_profiles cp ON cp.id = co."customerId"
      JOIN users u ON u.id = cp."userId"`;
    const base = Prisma.sql`
      SELECT r.id, r."createdAt" AS created_at, r."updatedAt" AS updated_at,
        r."codeExpiresAt" AS code_expires_at, r."escalatedAt" AS escalated_at,
        ${BUCKET} AS bucket
      ${from}
      WHERE ${Prisma.join(filters, ' AND ')}`;
    // the tab's own working order: the nearest deadline first, finished ones newest first
    const orderBy =
      tab === 'pending_decision'
        ? Prisma.sql`q.created_at ASC, q.id ASC`
        : tab === 'awaiting_dropoff'
          ? Prisma.sql`q.code_expires_at ASC NULLS LAST, q.id ASC`
          : tab === 'platform'
            ? Prisma.sql`q.escalated_at ASC NULLS LAST, q.id ASC`
            : Prisma.sql`q.updated_at DESC, q.id DESC`;
    const page = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH q AS (${base})
      SELECT q.id FROM q WHERE q.bucket = ${tab}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1} OFFSET ${offset}`;
    const countRows = await this.prisma.$queryRaw<
      { bucket: string; n: number }[]
    >`WITH q AS (${base})
      SELECT q.bucket, count(*)::int AS n FROM q GROUP BY q.bucket`;
    const counts: Record<ReturnQueueTab, number> = {
      pending_decision: 0,
      awaiting_dropoff: 0,
      completed: 0,
      closed: 0,
      platform: 0,
    };
    for (const c of countRows) {
      if (c.bucket in counts) counts[c.bucket as ReturnQueueTab] = c.n;
    }
    // all branches: each branch's open returns (decision, drop-off, platform)
    let branchCounts: { branch_id: string; open: number }[] | undefined;
    if (!branchId) {
      const per = await this.prisma.$queryRaw<
        { branch_id: string; n: number }[]
      >`SELECT bo."branchId" AS branch_id, count(*)::int AS n
        ${from}
        WHERE ${Prisma.join(otherFilters, ' AND ')}
          AND r.status IN ('REQUESTED', 'APPROVED_AWAITING_DROPOFF', 'ESCALATED')
        GROUP BY bo."branchId"`;
      branchCounts = per.map((p) => ({ branch_id: p.branch_id, open: p.n }));
    }

    const shown = page.slice(0, limit).map((p) => p.id);
    const rows = await this.prisma.return.findMany({
      where: { id: { in: shown } },
      include: RETURN_INCLUDE,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images = await this.imagesFor(
      vendorId,
      rows.map((r) => r.branchOrderItem.offerVariantId),
    );
    const items = shown.flatMap((id) => {
      const r = byId.get(id);
      return r ? [this.row(r, images)] : [];
    });
    return {
      items,
      next_cursor: page.length > limit ? String(offset + limit) : null,
      counts,
      ...(branchCounts ? { branch_counts: branchCounts } : {}),
      scope: branchId ? 'branch' : 'all',
      tab,
    };
  }

  private row(r: ReturnRow, images: Map<string, string>) {
    const item = r.branchOrderItem;
    const order = item.branchOrder;
    return {
      id: r.id,
      number: r.id.slice(0, 8),
      order_id: order.id,
      order_number: order.id.slice(0, 8),
      branch_id: order.branchId,
      branch_name: order.branch.name,
      status: r.status,
      bucket: bucketOfReturn(r.status),
      outcome: r.desiredOutcome,
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
      item: {
        title_ar: item.titleArSnapshot ?? item.offerVariant.vendorOffer.titleAr,
        title_en: item.titleEnSnapshot ?? item.offerVariant.vendorOffer.titleEn,
        color_name_ar: item.colorNameArSnapshot ?? item.colorLabelSnapshot,
        color_name_en: item.colorNameEnSnapshot ?? item.colorLabelSnapshot,
        color_hex: item.colorHexSnapshot,
        size_label:
          item.sizeLabelSnapshot ??
          item.sizeCodeSnapshot ??
          item.offerVariant.sizeCode,
        quantity: item.quantity,
        image_url: images.get(item.offerVariantId) ?? null,
      },
      customer_short: shortName(order.customerOrder.customer.displayName),
      money: moneyOf(r),
      deadline: deadlineOf(r),
    };
  }

  // ------------------------------------------------------------------
  // One return
  // ------------------------------------------------------------------

  private async requireReturn(
    vendorId: string,
    branchId: string,
    returnId: string,
  ): Promise<ReturnRow> {
    const r = await this.prisma.return.findUnique({
      where: { id: returnId },
      include: RETURN_INCLUDE,
    });
    if (
      !r ||
      r.vendorId !== vendorId ||
      r.branchOrderItem.branchOrder.branchId !== branchId
    ) {
      throw new NotFoundException({
        code: 'RETURN_NOT_FOUND',
        message: 'Return not found for this branch',
      });
    }
    return r;
  }

  async detail(
    vendorId: string,
    branchId: string,
    returnId: string,
    viewer: Viewer,
  ) {
    await this.requireBranch(vendorId, branchId);
    const r = await this.requireReturn(vendorId, branchId, returnId);
    const order = r.branchOrderItem.branchOrder;
    const images = await this.imagesFor(vendorId, [
      r.branchOrderItem.offerVariantId,
      ...(r.replacementOfferVariant ? [r.replacementOfferVariant.id] : []),
    ]);
    const own = order.customerOrder.customer.userId === viewer.userId;
    const rv = r.replacementOfferVariant;
    return {
      ...this.row(r, images),
      reason_note: r.reasonNote,
      photo_urls: r.photoUrls,
      size_guide: sizeGuideSnapshotDto(
        r.branchOrderItem.sizeGuideVersionSnapshot,
      ),
      policy: {
        mode: order.returnPolicySnapshotMode,
        window_days: order.returnPolicySnapshotWindowDays,
        fee_ils: numOrNull(order.returnPolicySnapshotFeeIls),
        exchange_fee_ils: numOrNull(order.returnPolicySnapshotExchangeFeeIls),
      },
      payment_method: order.paymentMethod,
      replacement: rv
        ? {
            title_ar: rv.vendorOffer.titleAr,
            title_en: rv.vendorOffer.titleEn,
            color_name_ar: rv.offerColor?.nameAr ?? rv.colour,
            color_name_en: rv.offerColor?.nameEn ?? rv.colour,
            color_hex: rv.offerColor?.hex ?? null,
            size_label: rv.size ?? rv.sizeCode,
            image_url: images.get(rv.id) ?? null,
            branch_id: r.replacementBranch?.id ?? null,
            branch_name: r.replacementBranch?.name ?? null,
            unit_price: numOrNull(r.replacementUnitPriceSnapshot),
          }
        : null,
      rejection_reason: r.rejectionReason,
      rejected_at: r.rejectedAt?.toISOString() ?? null,
      dispute_deadline_at: r.disputeDeadlineAt?.toISOString() ?? null,
      escalated_at: r.escalatedAt?.toISOString() ?? null,
      code_expires_at: r.codeExpiresAt?.toISOString() ?? null,
      received: r.receivedAt
        ? {
            at: r.receivedAt.toISOString(),
            branch_id: r.receivingBranch?.id ?? null,
            branch_name: r.receivingBranch?.name ?? null,
            condition: r.itemCondition,
          }
        : null,
      is_own_return: own,
      // the existing decision endpoint's own conditions; it decides again
      can_decide: r.status === 'REQUESTED' && !own,
      // where the item may be received (an exchange: only its branch)
      receive_at:
        r.status === 'APPROVED_AWAITING_DROPOFF'
          ? r.desiredOutcome === 'EXCHANGE'
            ? {
                any_branch: false,
                branch_id: r.replacementBranch?.id ?? null,
                branch_name: r.replacementBranch?.name ?? null,
              }
            : { any_branch: true }
          : null,
    };
  }

  async timeline(
    vendorId: string,
    branchId: string,
    returnId: string,
    viewer: Viewer,
  ) {
    await this.requireBranch(vendorId, branchId);
    const r = await this.requireReturn(vendorId, branchId, returnId);
    const owner = isOwner(viewer);
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: 'Return', entityId: r.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_LIMIT + 1,
      select: {
        id: true,
        actorId: true,
        action: true,
        afterState: true,
        occurredAt: true,
        actor: {
          select: { customerProfile: { select: { displayName: true } } },
        },
      },
    });
    const snapshots = new Map(
      rows.map((x) => [x.id, readActorSnapshot(x.afterState)]),
    );
    const branchIds = new Set<string>();
    for (const x of rows) {
      const s = snapshots.get(x.id);
      if (s?.branch_id) branchIds.add(s.branch_id);
      const rb = stringField(x.afterState, 'receiving_branch_id');
      if (rb) branchIds.add(rb);
    }
    const branches = branchIds.size
      ? await this.prisma.storeBranch.findMany({
          where: { vendorId, id: { in: [...branchIds] } },
          select: { id: true, name: true },
        })
      : [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const customerUserId =
      r.branchOrderItem.branchOrder.customerOrder.customer.userId;
    const items = rows.slice(0, TIMELINE_LIMIT).flatMap((x) => {
      const kind = returnEventKind(x.action);
      if (!kind) return [];
      const after = x.afterState;
      const receivingBranch = stringField(after, 'receiving_branch_id');
      return [
        {
          id: x.id,
          at: x.occurredAt.toISOString(),
          kind,
          actor: actorView({
            actorId: x.actorId,
            customerUserId,
            snapshot: snapshots.get(x.id) ?? null,
            currentName: x.actor?.customerProfile?.displayName ?? null,
            viewer,
            orderBranchId: r.branchOrderItem.branchOrder.branchId,
            branchName: owner ? branchName : new Map(),
          }),
          ...(kind === 'received'
            ? {
                condition: stringField(after, 'item_condition'),
                branch_name: receivingBranch
                  ? (branchName.get(receivingBranch) ?? null)
                  : null,
              }
            : {}),
          ...(kind === 'refunded'
            ? {
                amount: numberField(after, 'amount'),
                method: stringField(after, 'method'),
              }
            : {}),
          ...(kind === 'exchanged'
            ? {
                condition: stringField(after, 'item_condition'),
                amount: numberField(after, 'net_amount'),
                direction: stringField(after, 'direction'),
              }
            : {}),
        },
      ];
    });
    // Steps written in ONE transaction share their time (received + refunded,
    // approved + its code): newest first, and within the same instant the
    // later step of the flow first - a stable, readable order.
    items.sort(
      (a, b) =>
        b.at.localeCompare(a.at) || EVENT_RANK[b.kind] - EVENT_RANK[a.kind],
    );
    return { items, truncated: rows.length > TIMELINE_LIMIT };
  }

  // ------------------------------------------------------------------
  // The code preview (before «استلام»)
  // ------------------------------------------------------------------

  /**
   * POST vendors/:v/returns/lookup - what this code would receive, BEFORE
   * the existing redeem runs. Never writes and never consumes the code; the
   * same who-may-receive-where rule as redeem, checked first (an employee
   * only at her own branch, nothing said about the code otherwise); the
   * same «invalid / used / expired» refusals. The answer holds only what the
   * receiving counter needs - the item, the outcome, the money and where
   * it may be received - never the code, the shopper's note, photos,
   * rejection reason, name or phone.
   */
  async lookup(
    vendorId: string,
    actorUserId: string,
    dto: { code: string; receiving_branch_id: string },
  ) {
    await assertMayReceiveAt(
      this.prisma,
      vendorId,
      actorUserId,
      dto.receiving_branch_id,
    );
    const receiving = await this.prisma.storeBranch.findFirst({
      where: { id: dto.receiving_branch_id, vendorId },
      select: { id: true, name: true },
    });
    if (!receiving) {
      throw new ForbiddenException({
        code: 'RECEIVING_BRANCH_NOT_IN_VENDOR',
        message: 'The receiving branch must belong to this vendor',
      });
    }
    const r = await this.prisma.return.findFirst({
      where: {
        vendorId,
        code: dto.code,
        status: 'APPROVED_AWAITING_DROPOFF',
      },
      include: RETURN_INCLUDE,
    });
    if (!r) {
      throw new ConflictException({
        code: 'INVALID_RETURN_CODE',
        message: 'This code is invalid, already used, or expired',
      });
    }
    if (!r.codeExpiresAt || new Date() > r.codeExpiresAt) {
      throw new ConflictException({
        code: 'RETURN_CODE_EXPIRED',
        message: 'This return code has expired',
      });
    }
    const images = await this.imagesFor(vendorId, [
      r.branchOrderItem.offerVariantId,
      ...(r.replacementOfferVariant ? [r.replacementOfferVariant.id] : []),
    ]);
    const base = this.row(r, images);
    const exchange = r.desiredOutcome === 'EXCHANGE';
    const own =
      r.branchOrderItem.branchOrder.customerOrder.customer.userId ===
      actorUserId;
    const wrongBranch =
      exchange && r.replacementBranchId !== dto.receiving_branch_id;
    const rv = r.replacementOfferVariant;
    return {
      return_id: r.id,
      number: base.number,
      order_number: base.order_number,
      outcome: r.desiredOutcome,
      item: base.item,
      replacement: rv
        ? {
            title_ar: rv.vendorOffer.titleAr,
            title_en: rv.vendorOffer.titleEn,
            color_name_ar: rv.offerColor?.nameAr ?? rv.colour,
            color_name_en: rv.offerColor?.nameEn ?? rv.colour,
            color_hex: rv.offerColor?.hex ?? null,
            size_label: rv.size ?? rv.sizeCode,
            image_url: images.get(rv.id) ?? null,
          }
        : null,
      money: base.money,
      code_expires_at: r.codeExpiresAt.toISOString(),
      receiving_branch: receiving,
      allowed_branch: exchange
        ? {
            id: r.replacementBranch?.id ?? null,
            name: r.replacementBranch?.name ?? null,
          }
        : null,
      can_receive_here: !own && !wrongBranch,
      blocked_reason: own
        ? 'SELF_DECISION_FORBIDDEN'
        : wrongBranch
          ? 'WRONG_BRANCH_FOR_EXCHANGE'
          : null,
    };
  }
}

// ------------------------------------------------------------------

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** What changes hands: the refund (amount + how) or the exchange difference.
 * Final once it happened (the stored refund / settlement), otherwise the
 * expected value from the order's own policy snapshot - the same formulas
 * the redemption uses. */
function moneyOf(r: ReturnRow) {
  const item = r.branchOrderItem;
  const order = item.branchOrder;
  if (r.desiredOutcome === 'EXCHANGE') {
    if (r.exchangeSettlement) {
      return {
        kind: 'exchange' as const,
        final: true,
        direction: r.exchangeSettlement.direction,
        amount: Number(r.exchangeSettlement.netAmount),
      };
    }
    if (r.replacementUnitPriceSnapshot === null) return null;
    const calc = computeExchangeSettlement(
      item.unitPrice,
      r.replacementUnitPriceSnapshot,
      item.quantity,
      order.returnPolicySnapshotExchangeFeeIls,
    );
    return {
      kind: 'exchange' as const,
      final: false,
      direction: calc.direction,
      amount: calc.netAmount.toNumber(),
    };
  }
  if (r.refund) {
    return {
      kind: 'refund' as const,
      final: true,
      amount: Number(r.refund.amount),
      method: r.refund.method,
    };
  }
  return {
    kind: 'refund' as const,
    final: false,
    amount: computeReturnRefundAmount(
      item.unitPrice,
      item.quantity,
      order.returnPolicySnapshotFeeIls,
    ).toNumber(),
    method:
      order.paymentMethod === 'ONLINE'
        ? ('ONLINE_GATEWAY' as const)
        : ('COD_CASH' as const),
  };
}

/** The deadline that matters in each state - each one the date a sweep acts on. */
function deadlineOf(r: ReturnRow) {
  switch (r.status) {
    case 'REQUESTED':
      return {
        kind: 'escalation' as const,
        at: new Date(
          r.createdAt.getTime() + ESCALATION_TIMEOUT_HOURS * 3_600_000,
        ).toISOString(),
      };
    case 'APPROVED_AWAITING_DROPOFF':
      return r.codeExpiresAt
        ? { kind: 'code_expiry' as const, at: r.codeExpiresAt.toISOString() }
        : null;
    case 'REJECTED':
      return r.disputeDeadlineAt
        ? { kind: 'dispute' as const, at: r.disputeDeadlineAt.toISOString() }
        : null;
    default:
      return null;
  }
}

type ReturnEventKind =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'disputed'
  | 'escalated'
  | 'platform_approved'
  | 'platform_rejected'
  | 'code_expired'
  | 'dispute_closed'
  | 'received'
  | 'refunded'
  | 'exchanged';

/** The order of the flow, for events written at the same instant. */
const EVENT_RANK: Record<ReturnEventKind, number> = {
  requested: 0,
  cancelled: 1,
  approved: 2,
  rejected: 2,
  disputed: 3,
  escalated: 3,
  platform_approved: 4,
  platform_rejected: 4,
  dispute_closed: 5,
  code_expired: 5,
  received: 6,
  refunded: 7,
  exchanged: 7,
};

function returnEventKind(action: string): ReturnEventKind | null {
  switch (action) {
    case 'return.requested':
      return 'requested';
    case 'return.approved':
    case 'return.exchange_approved':
      return 'approved';
    case 'return.rejected':
      return 'rejected';
    case 'return.cancelled_by_customer':
      return 'cancelled';
    case 'return.disputed':
      return 'disputed';
    case 'return.auto_escalated':
      return 'escalated';
    case 'return.escalation_approved':
    case 'return.exchange_escalation_approved':
      return 'platform_approved';
    case 'return.escalation_admin_rejected':
      return 'platform_rejected';
    case 'return.code_expired':
      return 'code_expired';
    case 'return.dispute_window_closed':
      return 'dispute_closed';
    case 'return.received':
      return 'received';
    case 'return.refund_processed':
      return 'refunded';
    case 'return.exchange_fulfilled':
      return 'exchanged';
    default:
      return null;
  }
}

function stringField(state: unknown, key: string): string | null {
  if (!state || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function numberField(state: unknown, key: string): number | null {
  if (!state || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : null;
}
