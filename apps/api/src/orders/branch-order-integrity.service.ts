import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PlatformAlertRecipientsService } from '../platform-alerts/platform-alert-recipients.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_LIMIT = 200;

export const INTEGRITY_FLAGGED_ACTION = 'branch_order.integrity_flagged';
export const INTEGRITY_REPAIRED_ACTION = 'branch_order.integrity_repaired';
export const INTEGRITY_ALERT_EVENT = 'branch_order.integrity_flagged';

/** Why a branch order's (fulfilment method, status) pair is one the
 * order state machine never produces. */
export type BranchOrderIntegrityIssue =
  | 'PICKUP_IN_DELIVERY_STATUS'
  | 'DELIVERY_IN_PICKUP_STATUS'
  | 'DELIVERED_WITHOUT_DELIVERED_AT';

/** The delivery-only statuses (branch-order-state-machine.ts: every rule
 * into or out of these is DELIVERY-only) and the pickup-only one. */
const DELIVERY_ONLY_STATUSES = [
  'SENT',
  'DELIVERED',
  'DELIVERY_FAILED',
  'REFUND_REQUESTED',
];
const PICKUP_ONLY_STATUSES = ['PICKED_UP'];

export interface IntegrityCheckedOrder {
  id: string;
  vendorId: string;
  branchId: string;
  fulfilmentMethod: string;
  status: string;
  deliveredAt: Date | null;
}

export function branchOrderIntegrityIssue(
  order: Pick<
    IntegrityCheckedOrder,
    'fulfilmentMethod' | 'status' | 'deliveredAt'
  >,
): BranchOrderIntegrityIssue | null {
  if (
    order.fulfilmentMethod === 'PICKUP' &&
    DELIVERY_ONLY_STATUSES.includes(order.status)
  ) {
    return 'PICKUP_IN_DELIVERY_STATUS';
  }
  if (
    order.fulfilmentMethod === 'DELIVERY' &&
    PICKUP_ONLY_STATUSES.includes(order.status)
  ) {
    return 'DELIVERY_IN_PICKUP_STATUS';
  }
  if (order.status === 'DELIVERED' && !order.deliveredAt) {
    return 'DELIVERED_WITHOUT_DELIVERED_AT';
  }
  return null;
}

/** The same rule as branchOrderIntegrityIssue(), as SQL over branch_orders. */
const INVALID_STATE_SQL = Prisma.sql`(
  (b."fulfilmentMethod" = 'PICKUP' AND b.status::text IN (${Prisma.join(DELIVERY_ONLY_STATUSES)}))
  OR (b."fulfilmentMethod" = 'DELIVERY' AND b.status::text IN (${Prisma.join(PICKUP_ONLY_STATUSES)}))
  OR (b.status = 'DELIVERED' AND b."deliveredAt" IS NULL)
)`;

/** What the narrow fixture repair checks before touching a row. */
export interface FixtureRepairCheck {
  id: string;
  found: boolean;
  fulfilmentMethod: string | null;
  status: string | null;
  deliveredAt: Date | null;
  itemCount: number;
  statusChangeAuditCount: number;
  eligible: boolean;
  /** Why it is not eligible (empty when eligible). */
  blockers: string[];
}

/**
 * TB-9: branch orders in a state the order state machine never
 * produces (finalpro had one - a Sprint 19 e2e fixture written straight
 * into a PICKUP order as DELIVERED, which made the 72h auto-confirm
 * throw on every sweep tick and block every order after it). Nothing
 * here moves such an order through the state machine: it is flagged -
 * one audit row and one alert per platform administrator, ever, per
 * order - and left for a person to decide. The only change this
 * service can make to one is the explicit, narrow fixture repair below,
 * run from scripts/repair-branch-order-integrity.ts with explicit ids.
 */
@Injectable()
export class BranchOrderIntegrityService {
  private readonly logger = new Logger(BranchOrderIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
    private readonly alertRecipients: PlatformAlertRecipientsService,
  ) {}

  /**
   * Records the issue once per order: the caller already holds the
   * order row's lock (FOR UPDATE), so two callers racing on the same
   * order serialize and the second sees the first's audit row. Returns
   * whether this call is the one that flagged it.
   */
  async flagOnce(
    tx: Prisma.TransactionClient,
    order: IntegrityCheckedOrder,
    issue: BranchOrderIntegrityIssue,
    correlationId: string,
  ): Promise<boolean> {
    const already = await tx.auditLog.findFirst({
      where: {
        entityType: 'BranchOrder',
        entityId: order.id,
        action: INTEGRITY_FLAGGED_ACTION,
      },
      select: { id: true },
    });
    if (already) return false;

    await this.auditLog.record(
      {
        actorId: null,
        correlationId,
        action: INTEGRITY_FLAGGED_ACTION,
        entityType: 'BranchOrder',
        entityId: order.id,
        afterState: {
          fulfilment_method: order.fulfilmentMethod,
          status: order.status,
          issue,
        },
      },
      tx,
    );
    // Platform administrators only - never the customer or the store:
    // the ORDER_INTEGRITY subscribers who are still active
    // administrators, else every active administrator (TB-12.2). No
    // vendor_id/branch_id in the payload: the alert is not a store
    // workspace notification.
    const { userIds } = await this.alertRecipients.resolve(
      tx,
      'ORDER_INTEGRITY',
    );
    for (const recipientId of userIds) {
      await this.outbox.enqueue(
        {
          eventType: INTEGRITY_ALERT_EVENT,
          audience: 'PLATFORM',
          payload: {
            branch_order_id: order.id,
            issue,
            recipient_user_id: recipientId,
          },
        },
        tx,
      );
    }
    this.logger.error(
      `Branch order ${order.id} is ${order.fulfilmentMethod} in ${order.status} (${issue}) - ` +
        'a state the order state machine never produces; left unchanged and flagged for platform administrators',
    );
    return true;
  }

  /**
   * The sweep's integrity pass: every not-yet-flagged order in an
   * invalid state, each locked and re-checked in its own transaction
   * and try/catch - one failure never stops the rest.
   */
  async flagInvalidOrders(
    correlationId: string,
  ): Promise<{ flagged: number; failed: number }> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b.id FROM branch_orders b
      WHERE ${INVALID_STATE_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM audit_logs a
          WHERE a."entityType" = 'BranchOrder' AND a."entityId" = b.id
            AND a.action = ${INTEGRITY_FLAGGED_ACTION}
        )
      ORDER BY b."createdAt" ASC, b.id ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let flagged = 0;
    let failed = 0;
    for (const { id } of candidates) {
      try {
        const didFlag = await this.prisma.$transaction(async (tx) => {
          const order = await lockIntegrityRow(tx, id);
          const issue = order && branchOrderIntegrityIssue(order);
          return issue ? this.flagOnce(tx, order, issue, correlationId) : false;
        });
        if (didFlag) flagged += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Integrity check failed for branch order ${id}`,
          (err as Error).stack,
        );
      }
    }
    return { flagged, failed };
  }

  /**
   * The checks the fixture repair requires, read without a lock (the
   * repair itself re-reads them under the row lock). Eligible only for
   * exactly the stale-fixture shape: PICKUP + DELIVERED, no items, and
   * never moved through the state machine (no status-change audit).
   */
  async checkFixtureRepair(
    client: Prisma.TransactionClient,
    id: string,
  ): Promise<FixtureRepairCheck> {
    const rows = await client.$queryRaw<
      { fulfilmentMethod: string; status: string; deliveredAt: Date | null }[]
    >`SELECT "fulfilmentMethod", status, "deliveredAt" FROM branch_orders WHERE id = ${id}`;
    return fixtureRepairCheck(client, id, rows[0] ?? null);
  }

  /** Every PICKUP order in DELIVERED, each with its repair check - what
   * the dry-run shows. Nothing is written. */
  async fixtureRepairCandidates(
    client: Prisma.TransactionClient,
  ): Promise<FixtureRepairCheck[]> {
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id FROM branch_orders
      WHERE "fulfilmentMethod" = 'PICKUP' AND status = 'DELIVERED'
      ORDER BY "createdAt" ASC, id ASC`;
    const checks: FixtureRepairCheck[] = [];
    for (const { id } of rows) {
      checks.push(await this.checkFixtureRepair(client, id));
    }
    return checks;
  }

  /**
   * Closes one stale-fixture order as COMPLETED - what the 72h
   * auto-confirm was trying to do, and for pickup the hand-over is the
   * confirmation. Deliberately NOT through BranchOrderService.transition()
   * (the state machine has no DELIVERED -> COMPLETED rule for PICKUP, and
   * that path also sends the review invitation): no notification of any
   * kind is written. The audit row is data-minimal - no address, phone
   * or order contents. Throws when the row is not eligible under its lock.
   */
  async repairFixtureOrder(
    tx: Prisma.TransactionClient,
    id: string,
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<
      { fulfilmentMethod: string; status: string; deliveredAt: Date | null }[]
    >`SELECT "fulfilmentMethod", status, "deliveredAt" FROM branch_orders WHERE id = ${id} FOR UPDATE`;
    const check = await fixtureRepairCheck(tx, id, locked[0] ?? null);
    if (!check.eligible) {
      throw new Error(
        `Branch order ${id} is not eligible for the fixture repair: ${check.blockers.join('; ')}`,
      );
    }
    await tx.branchOrder.update({
      where: { id },
      data: { status: 'COMPLETED' },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: INTEGRITY_REPAIRED_ACTION,
        entityType: 'BranchOrder',
        entityId: id,
        beforeState: { status: check.status },
        afterState: {
          order_id: id,
          fulfilment_method: check.fulfilmentMethod,
          old_status: check.status,
          new_status: 'COMPLETED',
          delivered_at: check.deliveredAt?.toISOString() ?? null,
          reason: 'STALE_TEST_FIXTURE_PICKUP_DELIVERED',
          repaired_by: actorId,
        },
      },
      tx,
    );
  }
}

async function lockIntegrityRow(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<IntegrityCheckedOrder | null> {
  const rows = await tx.$queryRaw<IntegrityCheckedOrder[]>`
    SELECT id, "vendorId", "branchId", "fulfilmentMethod", status::text AS status, "deliveredAt"
    FROM branch_orders WHERE id = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

async function fixtureRepairCheck(
  client: Prisma.TransactionClient,
  id: string,
  row: {
    fulfilmentMethod: string;
    status: string;
    deliveredAt: Date | null;
  } | null,
): Promise<FixtureRepairCheck> {
  if (!row) {
    return {
      id,
      found: false,
      fulfilmentMethod: null,
      status: null,
      deliveredAt: null,
      itemCount: 0,
      statusChangeAuditCount: 0,
      eligible: false,
      blockers: ['not found'],
    };
  }
  const itemCount = await client.branchOrderItem.count({
    where: { branchOrderId: id },
  });
  const statusChangeAuditCount = await client.auditLog.count({
    where: {
      entityType: 'BranchOrder',
      entityId: id,
      action: 'branch_order.status_changed',
    },
  });
  const blockers: string[] = [];
  if (row.fulfilmentMethod !== 'PICKUP') blockers.push('not a PICKUP order');
  if (row.status !== 'DELIVERED') blockers.push(`status is ${row.status}`);
  if (itemCount > 0) blockers.push(`has ${itemCount} item(s)`);
  if (statusChangeAuditCount > 0) {
    blockers.push('was moved through the order state machine');
  }
  return {
    id,
    found: true,
    fulfilmentMethod: row.fulfilmentMethod,
    status: row.status,
    deliveredAt: row.deliveredAt,
    itemCount,
    statusChangeAuditCount,
    eligible: blockers.length === 0,
    blockers,
  };
}
