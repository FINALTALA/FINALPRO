import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BranchOrderPaymentMethod,
  BranchOrderStatus,
  FulfilmentMethod,
  Prisma,
} from '../../generated/prisma/client';
import {
  computeAmountDue,
  computeAmountRefunded,
  computeRemainingRefundable,
} from '../orders/branch-order-money.util';
import { PrismaService } from '../prisma/prisma.service';

/**
 * VIA phase 2D - Admin Orders: a READ-ONLY view of marketplace orders for
 * PLATFORM_ADMIN. Nothing here changes an order: the only admin action on
 * an order stays the existing forced cancel (AdminBranchOrdersController,
 * PLACED/PREPARING only) and escalated returns stay in AdminReturnsController.
 *
 * - The unit listed is the BranchOrder (one store branch's part, with its
 *   own status, money and fulfilment); its CustomerOrder (the shopper's one
 *   checkout, possibly over several stores) is shown with it.
 * - Lines are the immutable checkout snapshots (BranchOrderItem.*Snapshot,
 *   unitPrice) - never the live offer.
 * - In-store POS sales (StoreSale) are a separate model and never appear.
 * - Customer data is minimised: display name and a masked phone; no
 *   address coordinates, address phones or pickup code.
 */

export const ADMIN_ORDERS_PAGE_MAX = 50;
const TIMELINE_LIMIT = 50;
/** Return states still waiting on someone (store, customer or the platform). */
const OPEN_RETURN_STATUSES = [
  'REQUESTED',
  'APPROVED_AWAITING_DROPOFF',
  'RECEIVED',
  'REFUND_PROCESSING',
  'ESCALATED',
] as const;

export interface AdminOrderListQuery {
  q?: string;
  status?: string;
  vendorId?: string;
  fulfilment?: string;
  payment?: string;
  from?: string;
  to?: string;
  flag?: string;
  cursor?: string;
  limit?: string;
}

/** "+970599123456" -> "+970•••••456": enough to tell two people apart, not to call them. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const tail = phone.slice(-3);
  const head = phone.startsWith('+') ? phone.slice(0, 4) : phone.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(phone.length - head.length - 3, 3))}${tail}`;
}

const money = (d: Prisma.Decimal | null | undefined) =>
  d === null || d === undefined ? null : Number(d);

function enumOrBad<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === '' || value === 'all') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: `Unknown ${field}`,
    });
  }
  return value as T;
}

function dateOrBad(value: string | undefined, field: string, endOfDay = false) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: `${field} must be YYYY-MM-DD`,
    });
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: `${field} is not a date`,
    });
  }
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminOrderListQuery) {
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? '25', 10) || 25, 1),
      ADMIN_ORDERS_PAGE_MAX,
    );
    const status = enumOrBad(
      query.status,
      Object.values(BranchOrderStatus),
      'status',
    );
    const fulfilment = enumOrBad(
      query.fulfilment,
      Object.values(FulfilmentMethod),
      'fulfilment',
    );
    const payment = enumOrBad(
      query.payment,
      Object.values(BranchOrderPaymentMethod),
      'payment',
    );
    const flag = enumOrBad(
      query.flag,
      ['refunded', 'open_return', 'cancelled_item'] as const,
      'flag',
    );
    const from = dateOrBad(query.from, 'from');
    const to = dateOrBad(query.to, 'to', true);

    const and: Prisma.BranchOrderWhereInput[] = [];
    if (status) and.push({ status });
    if (fulfilment) and.push({ fulfilmentMethod: fulfilment });
    if (payment) and.push({ paymentMethod: payment });
    if (query.vendorId) and.push({ vendorId: query.vendorId });
    if (from || to) and.push({ createdAt: { gte: from, lt: to } });
    if (flag === 'refunded') and.push({ refunds: { some: {} } });
    if (flag === 'open_return')
      and.push({
        items: {
          some: {
            returns: { some: { status: { in: [...OPEN_RETURN_STATUSES] } } },
          },
        },
      });
    if (flag === 'cancelled_item')
      and.push({ items: { some: { cancelledAt: { not: null } } } });
    const q = query.q?.trim();
    if (q) {
      // An order number (the first characters of either id) or a store name.
      const id = q.replace(/^#/, '').toLowerCase();
      and.push({
        OR: [
          ...(/^[0-9a-f-]{4,36}$/.test(id)
            ? [
                { id: { startsWith: id } },
                { customerOrderId: { startsWith: id } },
              ]
            : []),
          { vendor: { displayName: { contains: q, mode: 'insensitive' } } },
          { branch: { name: { contains: q, mode: 'insensitive' } } },
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
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: 'Invalid cursor',
        });
      }
      const t = new Date(c.t);
      and.push({
        OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: c.id } }],
      });
    }

    const rows = await this.prisma.branchOrder.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        customerOrderId: true,
        status: true,
        fulfilmentMethod: true,
        paymentMethod: true,
        total: true,
        createdAt: true,
        vendor: { select: { id: true, displayName: true, slug: true } },
        branch: { select: { id: true, name: true } },
        items: {
          select: {
            quantity: true,
            cancelledAt: true,
            returns: { select: { status: true } },
          },
        },
        refunds: { select: { amount: true } },
        _count: { select: { items: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((o) => ({
        id: o.id,
        number: o.id.slice(0, 8).toUpperCase(),
        customer_order_id: o.customerOrderId,
        status: o.status,
        fulfilment_method: o.fulfilmentMethod,
        payment_method: o.paymentMethod,
        total: money(o.total),
        refunded: computeAmountRefunded(o.refunds).toNumber(),
        item_count: o.items.reduce((n, i) => n + i.quantity, 0),
        line_count: o._count.items,
        cancelled_lines: o.items.filter((i) => i.cancelledAt).length,
        open_returns: o.items.reduce(
          (n, i) =>
            n +
            i.returns.filter((r) =>
              (OPEN_RETURN_STATUSES as readonly string[]).includes(r.status),
            ).length,
          0,
        ),
        store: {
          id: o.vendor.id,
          name: o.vendor.displayName,
          slug: o.vendor.slug,
        },
        branch: { id: o.branch.id, name: o.branch.name },
        created_at: o.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ t: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  async detail(branchOrderId: string, viewerUserId: string) {
    const o = await this.prisma.branchOrder.findUnique({
      where: { id: branchOrderId },
      include: {
        vendor: { select: { id: true, displayName: true, slug: true } },
        branch: { select: { id: true, name: true } },
        deliveryWindow: { select: { startMinute: true, endMinute: true } },
        address: { select: { label: true, zone: true } },
        paymentTransaction: {
          select: { id: true, status: true, amount: true, createdAt: true },
        },
        customerOrder: {
          include: {
            customer: {
              select: {
                displayName: true,
                userId: true,
                user: { select: { phone: true } },
              },
            },
            branchOrders: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                status: true,
                total: true,
                vendor: { select: { displayName: true } },
                branch: { select: { name: true } },
              },
            },
          },
        },
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            refund: { select: { id: true } },
            returns: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                status: true,
                desiredOutcome: true,
                reason: true,
                createdAt: true,
                escalatedAt: true,
              },
            },
          },
        },
        refunds: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            amount: true,
            reason: true,
            initiatedBy: true,
            method: true,
            branchOrderItemId: true,
            returnId: true,
            createdAt: true,
          },
        },
      },
    });
    if (!o) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }

    const deliveryFeeRefunded = o.refunds.some(
      (r) => r.reason === 'DELIVERY_FEE',
    );
    const customerUserId = o.customerOrder.customer.userId;
    const ownOrder = customerUserId === viewerUserId;

    const audit = await this.prisma.auditLog.findMany({
      where: { entityType: 'BranchOrder', entityId: o.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_LIMIT,
      select: {
        id: true,
        action: true,
        actorId: true,
        occurredAt: true,
        beforeState: true,
        afterState: true,
        actor: { select: { platformRole: true } },
      },
    });
    const statusOf = (s: Prisma.JsonValue) =>
      s &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      typeof s.status === 'string'
        ? s.status
        : null;

    return {
      id: o.id,
      number: o.id.slice(0, 8).toUpperCase(),
      status: o.status,
      fulfilment_method: o.fulfilmentMethod,
      payment_method: o.paymentMethod,
      store: {
        id: o.vendor.id,
        name: o.vendor.displayName,
        slug: o.vendor.slug,
      },
      branch: { id: o.branch.id, name: o.branch.name },
      customer: {
        display_name: o.customerOrder.customer.displayName,
        phone_masked: maskPhone(o.customerOrder.customer.user.phone),
      },
      delivery:
        o.fulfilmentMethod === 'DELIVERY'
          ? {
              zone: o.address?.zone ?? null,
              address_label: o.address?.label ?? null,
              scheduled_date:
                o.scheduledDate?.toISOString().slice(0, 10) ?? null,
              window: o.deliveryWindow
                ? {
                    start_minute: o.deliveryWindow.startMinute,
                    end_minute: o.deliveryWindow.endMinute,
                  }
                : null,
              attempts: o.deliveryAttemptCount,
            }
          : null,
      money: {
        subtotal: money(o.subtotal),
        delivery_fee: money(o.deliveryFee),
        total: money(o.total),
        amount_due: computeAmountDue(
          o.total,
          o.items,
          deliveryFeeRefunded,
          o.deliveryFee,
        ).toNumber(),
        refunded: computeAmountRefunded(o.refunds).toNumber(),
        remaining_refundable: computeRemainingRefundable(
          o.total,
          o.refunds,
        ).toNumber(),
        cod_collected: money(o.codCollectedAmount),
        cod_collected_at: o.codCollectedAt?.toISOString() ?? null,
      },
      payment: o.paymentTransaction
        ? {
            status: o.paymentTransaction.status,
            amount: money(o.paymentTransaction.amount),
            at: o.paymentTransaction.createdAt.toISOString(),
          }
        : null,
      dates: {
        created_at: o.createdAt.toISOString(),
        preparation_started_at: o.preparationStartedAt?.toISOString() ?? null,
        ready_at: o.readyAt?.toISOString() ?? null,
        picked_up_at: o.pickedUpAt?.toISOString() ?? null,
        delivered_at: o.deliveredAt?.toISOString() ?? null,
        delivery_failed_at: o.deliveryFailedAt?.toISOString() ?? null,
        not_received_reported_at:
          o.notReceivedReportedAt?.toISOString() ?? null,
        completed_at: o.completedAt?.toISOString() ?? null,
        updated_at: o.updatedAt.toISOString(),
      },
      cancellation_reason: o.cancellationReason,
      customer_note: o.customerNote,
      items: o.items.map((i) => ({
        id: i.id,
        title_ar: i.titleArSnapshot,
        title_en: i.titleEnSnapshot,
        colour: i.colorNameArSnapshot ?? i.colorLabelSnapshot,
        colour_en: i.colorNameEnSnapshot ?? i.colorLabelSnapshot,
        colour_hex: i.colorHexSnapshot,
        size: i.sizeLabelSnapshot ?? i.sizeCodeSnapshot,
        quantity: i.quantity,
        unit_price: money(i.unitPrice),
        line_total: Number(i.unitPrice) * i.quantity,
        cancelled_at: i.cancelledAt?.toISOString() ?? null,
        cancelled_reason: i.cancelledReason,
        refunded: i.refund !== null,
        returns: i.returns.map((r) => ({
          id: r.id,
          status: r.status,
          outcome: r.desiredOutcome,
          reason: r.reason,
          created_at: r.createdAt.toISOString(),
          escalated: r.status === 'ESCALATED',
        })),
      })),
      refunds: o.refunds.map((r) => ({
        id: r.id,
        amount: money(r.amount),
        reason: r.reason,
        initiated_by: r.initiatedBy,
        method: r.method,
        item_id: r.branchOrderItemId,
        return_id: r.returnId,
        created_at: r.createdAt.toISOString(),
      })),
      customer_order: {
        id: o.customerOrder.id,
        created_at: o.customerOrder.createdAt.toISOString(),
        terms_version: o.customerOrder.platformTermsVersion,
        branch_orders: o.customerOrder.branchOrders.map((b) => ({
          id: b.id,
          number: b.id.slice(0, 8).toUpperCase(),
          status: b.status,
          total: money(b.total),
          store_name: b.vendor.displayName,
          branch_name: b.branch.name,
          current: b.id === o.id,
        })),
      },
      timeline: audit.map((a) => ({
        id: a.id,
        at: a.occurredAt.toISOString(),
        action: a.action,
        from_status: statusOf(a.beforeState),
        to_status: statusOf(a.afterState),
        actor:
          a.actorId === null
            ? 'SYSTEM'
            : a.actorId === customerUserId
              ? 'CUSTOMER'
              : a.actor?.platformRole
                ? 'PLATFORM'
                : 'STORE',
      })),
      actions: {
        // The existing forced cancel's own rule (PLACED/PREPARING, never
        // your own order - TB-28); the server re-checks it under lock.
        force_cancel:
          (o.status === 'PLACED' || o.status === 'PREPARING') && !ownOrder,
        own_order: ownOrder,
        escalated_returns: o.items.some((i) =>
          i.returns.some((r) => r.status === 'ESCALATED'),
        ),
      },
    };
  }
}
