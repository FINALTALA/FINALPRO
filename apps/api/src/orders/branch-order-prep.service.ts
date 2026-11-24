import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { auditSelfFulfilment } from '../common/self-decision.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * «إدارة طلبات الفرع v2» phase 2 (2026-11-24): the saved prep checklist and
 * «جاهز» - a sub-state of PREPARING (BranchOrder.readyAt), never a new
 * status. Nothing here touches stock, money, cancellation or returns.
 *
 * The new path: an order whose preparation started from this release on
 * (preparationStartedAt set by start-preparation) must be marked ready - the
 * mandatory checklist items done, checked HERE on the server - before it can
 * be sent (DELIVERY) or handed over (PICKUP): see assertReadyIfRequired. An
 * order already PREPARING before the release (preparationStartedAt null)
 * keeps the old path and is never held back.
 *
 * Who: the OWNER (any branch - the controller's guard and branch check) or
 * the order branch's BRANCH_EMPLOYEE. An employee never ticks or readies her
 * own order (403 OWN_ORDER_FORBIDDEN); the owner may (TB-28: fulfilling one's
 * own order is allowed), recorded as a self-fulfilment.
 */

export const PREP_ITEMS = [
  { key: 'ITEMS_VERIFIED', required: true },
  { key: 'PACKED', required: true },
  { key: 'INVOICE_ATTACHED', required: false },
] as const;
export type PrepItemKey = (typeof PREP_ITEMS)[number]['key'];
export const PREP_ITEM_KEYS: readonly string[] = PREP_ITEMS.map((i) => i.key);
export const REQUIRED_PREP_ITEMS: readonly string[] = PREP_ITEMS.filter(
  (i) => i.required,
).map((i) => i.key);

export type StoreRole = 'OWNER' | 'BRANCH_EMPLOYEE';
export interface PrepActor {
  userId: string;
  role: StoreRole;
}

interface LockedOrder {
  id: string;
  vendorId: string;
  branchId: string;
  status: string;
  fulfilmentMethod: string;
  preparationStartedAt: Date | null;
  readyAt: Date | null;
}

/** The mandatory items not done yet, in the checklist's order. */
export function missingRequired(doneKeys: Iterable<string>): string[] {
  const done = new Set(doneKeys);
  return REQUIRED_PREP_ITEMS.filter((k) => !done.has(k));
}

/**
 * Called inside mark-sent / pickup-handover's transaction: an order on the
 * new path (preparation started from this release on) that is not ready yet
 * is refused - 409 ORDER_NOT_READY, nothing written. Locks the row.
 */
export async function assertReadyIfRequired(
  tx: Prisma.TransactionClient,
  branchOrderId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { preparationStartedAt: Date | null; readyAt: Date | null }[]
  >`SELECT "preparationStartedAt", "readyAt" FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
  const o = rows[0];
  if (o && o.preparationStartedAt !== null && o.readyAt === null) {
    throw new ConflictException({
      code: 'ORDER_NOT_READY',
      message:
        'Mark this order ready (its mandatory checklist done) before sending or handing it over',
    });
  }
}

@Injectable()
export class BranchOrderPrepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
  ) {}

  private async lock(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ): Promise<LockedOrder> {
    const rows = await tx.$queryRaw<LockedOrder[]>`
      SELECT id, "vendorId", "branchId", status::text AS status, "fulfilmentMethod"::text AS "fulfilmentMethod",
             "preparationStartedAt", "readyAt"
      FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    return rows[0];
  }

  /** An employee never prepares her own order; the owner may (recorded). */
  private async assertMayPrepare(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    actor: PrepActor,
    step: 'PREP_CHECK' | 'MARK_READY',
    correlationId: string,
  ): Promise<void> {
    const order = await tx.branchOrder.findUniqueOrThrow({
      where: { id: branchOrderId },
      select: {
        customerOrder: { select: { customer: { select: { userId: true } } } },
      },
    });
    const own = order.customerOrder.customer.userId === actor.userId;
    if (own && actor.role === 'BRANCH_EMPLOYEE') {
      throw new ForbiddenException({
        code: 'OWN_ORDER_FORBIDDEN',
        message:
          'You placed this order - another member of the team must prepare it',
      });
    }
    if (own) {
      await auditSelfFulfilment(
        tx,
        this.auditLog,
        branchOrderId,
        actor.userId,
        step,
        correlationId,
      );
    }
  }

  private assertPreparing(o: LockedOrder) {
    if (o.status !== 'PREPARING') {
      throw new ConflictException({
        code: 'ORDER_NOT_PREPARING',
        message: 'The checklist and «ready» apply only while preparing',
      });
    }
    if (o.readyAt !== null) {
      throw new ConflictException({
        code: 'ORDER_ALREADY_READY',
        message: 'This order is already marked ready',
      });
    }
  }

  /**
   * Ticks (done = true) or un-ticks one checklist item. Idempotent: ticking
   * a done item or un-ticking an open one changes and records nothing.
   * Locked once the order is ready.
   */
  async setCheck(
    branchOrderId: string,
    item: PrepItemKey,
    done: boolean,
    actor: PrepActor,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, branchOrderId);
      this.assertPreparing(o);
      await this.assertMayPrepare(
        tx,
        branchOrderId,
        actor,
        'PREP_CHECK',
        correlationId,
      );
      const existing = await tx.branchOrderPrepCheck.findUnique({
        where: { branchOrderId_itemKey: { branchOrderId, itemKey: item } },
      });
      if (done && !existing) {
        const row = await tx.branchOrderPrepCheck.create({
          data: {
            vendorId: o.vendorId,
            branchOrderId,
            itemKey: item,
            doneById: actor.userId,
            doneByRole: actor.role,
          },
        });
        await this.auditLog.record(
          {
            actorId: actor.userId,
            correlationId,
            action: 'branch_order.prep_check_done',
            entityType: 'BranchOrder',
            entityId: branchOrderId,
            beforeState: { item, done: false },
            afterState: {
              item,
              done: true,
              done_at: row.doneAt.toISOString(),
              role: actor.role,
              branch_id: o.branchId,
            },
          },
          tx,
        );
      } else if (!done && existing) {
        await tx.branchOrderPrepCheck.delete({ where: { id: existing.id } });
        await this.auditLog.record(
          {
            actorId: actor.userId,
            correlationId,
            action: 'branch_order.prep_check_undone',
            entityType: 'BranchOrder',
            entityId: branchOrderId,
            beforeState: {
              item,
              done: true,
              done_at: existing.doneAt.toISOString(),
              done_by: existing.doneById,
            },
            afterState: {
              item,
              done: false,
              role: actor.role,
              branch_id: o.branchId,
            },
          },
          tx,
        );
      }
      const checks = await tx.branchOrderPrepCheck.findMany({
        where: { branchOrderId },
        select: { itemKey: true },
      });
      return {
        id: branchOrderId,
        item,
        done,
        missing: missingRequired(checks.map((c) => c.itemKey)),
      };
    });
  }

  /**
   * «إعلان الطلب جاهزًا»: only from PREPARING, only once, only with every
   * mandatory item done (409 PREP_CHECKLIST_INCOMPLETE with the missing
   * keys). A PICKUP order notifies its customer (READY_FOR_PICKUP - the
   * order id only, never the pickup code); a DELIVERY order notifies her
   * when it is actually sent (ORDER_SENT, mark-sent).
   */
  async markReady(
    branchOrderId: string,
    actor: PrepActor,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, branchOrderId);
      this.assertPreparing(o);
      await this.assertMayPrepare(
        tx,
        branchOrderId,
        actor,
        'MARK_READY',
        correlationId,
      );
      const checks = await tx.branchOrderPrepCheck.findMany({
        where: { branchOrderId },
        select: { itemKey: true },
      });
      const missing = missingRequired(checks.map((c) => c.itemKey));
      if (missing.length > 0) {
        throw new ConflictException({
          code: 'PREP_CHECKLIST_INCOMPLETE',
          message: 'The mandatory checklist items are not done yet',
          // the missing mandatory item keys
          details: missing,
        });
      }
      const readyAt = new Date();
      const updated = await tx.branchOrder.update({
        where: { id: branchOrderId },
        data: {
          readyAt,
          readyBy: { connect: { id: actor.userId } },
          readyByRole: actor.role,
        },
        select: {
          id: true,
          status: true,
          readyAt: true,
          customerOrder: {
            select: { customer: { select: { userId: true } } },
          },
        },
      });
      await this.auditLog.record(
        {
          actorId: actor.userId,
          correlationId,
          action: 'branch_order.ready',
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          beforeState: { status: o.status, ready: false },
          afterState: {
            status: o.status,
            ready: true,
            ready_at: readyAt.toISOString(),
            fulfilment_method: o.fulfilmentMethod,
            role: actor.role,
            branch_id: o.branchId,
          },
        },
        tx,
      );
      if (o.fulfilmentMethod === 'PICKUP') {
        await this.outbox.enqueue(
          {
            eventType: 'branch_order.ready_for_pickup',
            audience: 'CUSTOMER',
            payload: {
              branch_order_id: branchOrderId,
              vendor_id: o.vendorId,
              branch_id: o.branchId,
              recipient_user_id: updated.customerOrder.customer.userId,
            },
          },
          tx,
        );
      }
      return {
        id: updated.id,
        status: updated.status,
        ready_at: updated.readyAt!.toISOString(),
      };
    });
  }
}
