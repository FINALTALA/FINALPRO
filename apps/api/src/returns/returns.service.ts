import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { lockBranchOperationalStatus } from '../common/branch-operational-lock.util';
import {
  lockSweepOrCreateStockRow,
  lockSweepOrCreateStockRowsSorted,
} from '../checkout/stock-lock.util';
import {
  computeEffectivePrice,
  toDecimal,
} from '../offers/pricing/effective-price.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkReturnEligibility,
  computeExchangeSettlement,
  computeReturnRefundAmount,
  isOutcomeAllowedBySnapshot,
} from './return-policy.util';

const RETURN_CODE_MAX_ATTEMPTS = 10;
const VENDOR_REVIEW_SLA_HOURS = 48;
const DISPUTE_WINDOW_DAYS = 7;
const CODE_VALIDITY_DAYS = 7;
// Sprint 21b (PDR §3.5: "reserve it for 24 hours") - an EXCHANGE
// outcome's own code validity, deliberately shorter than a plain
// RETURN's 7 days, since it holds real replacement inventory hostage
// the whole time.
const EXCHANGE_CODE_VALIDITY_DAYS = 1;

// Every status except these three blocks a second concurrent/duplicate
// Return for the same item - see Return's own partial unique index
// comment (migration SQL) for the exact reasoning, repeated here only
// so the application-layer courtesy pre-check (a clean 409 instead of
// a raw constraint-violation error) stays in sync with the DB-level
// guarantee.
const RESUBMISSION_ALLOWED_STATUSES = [
  'REJECTED_CLOSED',
  'EXPIRED',
  'CANCELLED_BY_CUSTOMER',
] as const;

function generateReturnCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** The AuditLog action name for an APPROVE decision specifically -
 * distinct for an EXCHANGE outcome, shared by decide() and
 * resolveEscalation() (both go through approveReturn()). Each
 * caller's own REJECT action name differs between the two (store
 * rejection vs. admin's final one) and is kept inline at each call
 * site, unrelated to this. */
function approveAuditAction(desiredOutcome: string): string {
  return desiredOutcome === 'EXCHANGE'
    ? 'return.exchange_approved'
    : 'return.approved';
}

interface ExchangeSettlementRow {
  originalTotal: unknown;
  replacementTotal: unknown;
  netAmount: unknown;
  direction: string;
}

function settlementDto(s: ExchangeSettlementRow | null | undefined) {
  if (!s) return null;
  return {
    original_total: Number(s.originalTotal),
    replacement_total: Number(s.replacementTotal),
    net_amount: Number(s.netAmount),
    direction: s.direction,
  };
}

function returnDto(r: {
  id: string;
  status: string;
  reason: string;
  reasonNote: string | null;
  photoUrls: string[];
  code: string | null;
  codeExpiresAt: Date | null;
  rejectedAt: Date | null;
  disputeDeadlineAt: Date | null;
  rejectionReason: string | null;
  escalatedAt: Date | null;
  receivingBranchId: string | null;
  receivedAt: Date | null;
  itemCondition: string | null;
  createdAt: Date;
  desiredOutcome: string;
  replacementOfferVariantId: string | null;
  replacementBranchId: string | null;
  replacementUnitPriceSnapshot: unknown;
  exchangeSettlement?: ExchangeSettlementRow | null;
}) {
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reason_note: r.reasonNote,
    photo_urls: r.photoUrls,
    code: r.code,
    code_expires_at: r.codeExpiresAt,
    rejected_at: r.rejectedAt,
    dispute_deadline_at: r.disputeDeadlineAt,
    rejection_reason: r.rejectionReason,
    escalated_at: r.escalatedAt,
    receiving_branch_id: r.receivingBranchId,
    received_at: r.receivedAt,
    item_condition: r.itemCondition,
    created_at: r.createdAt,
    desired_outcome: r.desiredOutcome,
    replacement_offer_variant_id: r.replacementOfferVariantId,
    replacement_branch_id: r.replacementBranchId,
    replacement_unit_price_snapshot:
      r.replacementUnitPriceSnapshot != null
        ? Number(r.replacementUnitPriceSnapshot)
        : null,
    settlement: settlementDto(r.exchangeSettlement),
  };
}

/**
 * Review-round requirement: redeem() is deliberately reachable by any
 * employee/owner of ANY branch of this vendor (PDR-031's cross-branch
 * acceptance) - but reason_note/photo_urls/rejection_reason/code are
 * only for the customer, the ORIGINATING branch's own staff, and
 * PLATFORM_ADMIN (same privacy convention as Sprint 20b's
 * internalStoreNote). The full returnDto() above must never be the
 * response to a redeem call - this is the only safe subset.
 */
function redeemResultDto(
  r: {
    id: string;
    status: string;
    receivingBranchId: string | null;
    receivedAt: Date | null;
    itemCondition: string | null;
  },
  settlement?: ExchangeSettlementRow | null,
) {
  return {
    id: r.id,
    status: r.status,
    receiving_branch_id: r.receivingBranchId,
    received_at: r.receivedAt,
    item_condition: r.itemCondition,
    // EXCHANGED is only ever reached via the EXCHANGE outcome, so the
    // status alone determines this - no need to thread desiredOutcome
    // through every caller's input shape.
    desired_outcome: r.status === 'EXCHANGED' ? 'EXCHANGE' : 'RETURN',
    // Sprint 21b: the redeeming staff member NEEDS this to do the cash
    // hand-over correctly - still privacy-safe, same as the rest of
    // this DTO (never reason_note/photo_urls/rejection_reason/code).
    settlement: settlementDto(settlement),
  };
}

/**
 * Sprint 21 (EPIC-RET). The full Return lifecycle - submit, customer
 * cancel/dispute, vendor decide, vendor redeem, admin escalation
 * decision. See Return's own schema.prisma comment for the state
 * machine and the partial-unique-index invariants this service's own
 * pre-checks mirror (but never replace - the DB constraint is the
 * real guarantee under concurrency, these are only for a clean error
 * message on the common, non-racing path).
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
  ) {}

  // ============================================================
  // Customer-facing
  // ============================================================

  async submit(
    customerId: string,
    actorUserId: string,
    branchOrderId: string,
    itemId: string,
    dto: {
      reason: string;
      reason_note?: string;
      photo_urls?: string[];
      desired_outcome?: 'RETURN' | 'EXCHANGE';
      replacement_offer_variant_id?: string;
      replacement_branch_id?: string;
    },
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branch_order_items WHERE id = ${itemId} FOR UPDATE`;
      const item = await tx.branchOrderItem.findUnique({
        where: { id: itemId },
        include: {
          branchOrder: {
            include: { customerOrder: { select: { customerId: true } } },
          },
          offerVariant: { select: { vendorOfferId: true } },
        },
      });
      if (
        !item ||
        item.branchOrderId !== branchOrderId ||
        item.branchOrder.customerOrder.customerId !== customerId
      ) {
        throw new NotFoundException({
          code: 'BRANCH_ORDER_ITEM_NOT_FOUND',
          message: 'Order item not found',
        });
      }
      if (item.cancelledAt !== null) {
        throw new ConflictException({
          code: 'ITEM_CANCELLED_NOT_RETURNABLE',
          message:
            'A cancelled item was never delivered and cannot be returned',
        });
      }

      const order = item.branchOrder;
      const eligibility = checkReturnEligibility(
        {
          status: order.status,
          fulfilmentMethod: order.fulfilmentMethod,
          paymentMethod: order.paymentMethod,
          deliveredAt: order.deliveredAt,
          pickedUpAt: order.pickedUpAt,
          codCollectedAt: order.codCollectedAt,
          returnPolicySnapshotEnabled: order.returnPolicySnapshotEnabled,
          returnPolicySnapshotMode: order.returnPolicySnapshotMode,
          returnPolicySnapshotWindowDays: order.returnPolicySnapshotWindowDays,
        },
        new Date(),
      );
      if (!eligibility.eligible) {
        throw new ConflictException({
          code: 'NOT_ELIGIBLE_FOR_RETURN',
          message: `This item is not eligible for return (${eligibility.reasonCode})`,
          details: [{ reason_code: eligibility.reasonCode }],
        });
      }

      // Sprint 21b: the desired outcome is judged against THIS ORDER's
      // own frozen snapshot, never the vendor's live policy - the
      // outcome itself only ever defaults to RETURN, never silently
      // "upgraded" to EXCHANGE just because that's all the policy
      // permits (an EXCHANGE_ONLY store still requires the customer to
      // actually ask for one, via the replacement fields below).
      const desiredOutcome: 'RETURN' | 'EXCHANGE' =
        dto.desired_outcome ?? 'RETURN';
      if (
        !isOutcomeAllowedBySnapshot(
          order.returnPolicySnapshotMode,
          desiredOutcome,
        )
      ) {
        throw new ConflictException({
          code: 'OUTCOME_NOT_ALLOWED_BY_POLICY',
          message: `This store's return policy at the time of purchase does not allow a ${desiredOutcome} outcome`,
        });
      }

      let replacementUnitPriceSnapshot: string | null = null;
      if (desiredOutcome === 'EXCHANGE') {
        if (!dto.replacement_offer_variant_id || !dto.replacement_branch_id) {
          throw new BadRequestException({
            code: 'REPLACEMENT_REQUIRED',
            message:
              'replacement_offer_variant_id and replacement_branch_id are required for an EXCHANGE outcome',
          });
        }
        const replacementVariant =
          await this.validateReplacementVariantAndBranch(
            tx,
            item.vendorId,
            item.offerVariantId,
            item.offerVariant.vendorOfferId,
            dto.replacement_offer_variant_id,
            dto.replacement_branch_id,
          );
        replacementUnitPriceSnapshot = computeEffectivePrice({
          basePrice: replacementVariant.basePrice,
          salePrice: replacementVariant.salePrice,
          discountPercent: replacementVariant.discountPercent,
          discountStartAt: replacementVariant.discountStartAt,
          discountEndAt: replacementVariant.discountEndAt,
        }).toFixed(2);
      }

      const openExisting = await tx.return.findFirst({
        where: {
          branchOrderItemId: itemId,
          status: { notIn: [...RESUBMISSION_ALLOWED_STATUSES] },
        },
      });
      if (openExisting) {
        throw new ConflictException({
          code: 'RETURN_ALREADY_EXISTS',
          message:
            'This item already has an open or completed return - see the partial unique index comment on Return for which statuses allow resubmission',
        });
      }

      const now = new Date();
      let created;
      try {
        created = await tx.return.create({
          data: {
            vendorId: item.vendorId,
            branchOrderItemId: itemId,
            reason: dto.reason as never,
            reasonNote: dto.reason_note ?? null,
            photoUrls: dto.photo_urls ?? [],
            status: 'REQUESTED',
            vendorReviewDueAt: new Date(
              now.getTime() + VENDOR_REVIEW_SLA_HOURS * 60 * 60 * 1000,
            ),
            desiredOutcome,
            replacementOfferVariantId:
              desiredOutcome === 'EXCHANGE'
                ? dto.replacement_offer_variant_id
                : null,
            replacementBranchId:
              desiredOutcome === 'EXCHANGE' ? dto.replacement_branch_id : null,
            replacementUnitPriceSnapshot,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'RETURN_ALREADY_EXISTS',
            message: 'This item already has an open or completed return',
          });
        }
        throw err;
      }

      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.requested',
          entityType: 'Return',
          entityId: created.id,
          afterState: {
            branch_order_item_id: itemId,
            reason: dto.reason,
            desired_outcome: desiredOutcome,
          },
        },
        tx,
      );
      await this.notifyBranch(
        tx,
        order.vendorId,
        order.branchId,
        'return.requested',
        { return_id: created.id, branch_order_id: branchOrderId },
      );
      return returnDto(created);
    });
  }

  /**
   * Sprint 21b (review-round requirement §3): the full server-side
   * replacement validation, re-run VERBATIM under lock inside
   * approveReturn() - never trusted from the UI picker, which is only
   * ever a convenience (see listExchangeOptions()). Checks, in order:
   * (1) a different variant than the original item's own, (2) same
   * vendorId AND same vendorOfferId (colour/size swap only, never an
   * arbitrary product), (3) the branch belongs to this vendor,
   * (4) physical, APPROVED, not archived, (5) the offer/variant are
   * still sellable. The live stock-quantity check is deliberately
   * NOT here - it needs the real lock (lockSweepOrCreateStockRow),
   * which only approveReturn() takes, at the one moment that actually
   * commits a reservation.
   */
  private async validateReplacementVariantAndBranch(
    tx: Prisma.TransactionClient,
    vendorId: string,
    originalOfferVariantId: string,
    originalVendorOfferId: string,
    replacementOfferVariantId: string,
    replacementBranchId: string,
  ) {
    if (replacementOfferVariantId === originalOfferVariantId) {
      throw new BadRequestException({
        code: 'REPLACEMENT_SAME_AS_ORIGINAL',
        message:
          'The replacement must be a different variant than the original item',
      });
    }
    const replacementVariant = await tx.offerVariant.findFirst({
      where: { id: replacementOfferVariantId, vendorId },
      include: { vendorOffer: { select: { status: true, vendorId: true } } },
    });
    if (
      !replacementVariant ||
      replacementVariant.vendorOfferId !== originalVendorOfferId
    ) {
      throw new NotFoundException({
        code: 'REPLACEMENT_VARIANT_NOT_FOUND',
        message:
          'The replacement must be another variant of the same product listing',
      });
    }
    if (replacementVariant.vendorOffer.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'REPLACEMENT_NOT_AVAILABLE',
        message: 'The replacement is not currently sellable',
      });
    }
    const branch = await tx.storeBranch.findFirst({
      where: { id: replacementBranchId, vendorId },
    });
    if (!branch) {
      throw new NotFoundException({
        code: 'REPLACEMENT_BRANCH_NOT_FOUND',
        message: 'The replacement branch must belong to this vendor',
      });
    }
    if (
      !branch.isPhysical ||
      branch.verificationStatus !== 'APPROVED' ||
      branch.archivedAt !== null
    ) {
      throw new ConflictException({
        code: 'REPLACEMENT_BRANCH_NOT_AVAILABLE',
        message:
          'The replacement branch must be a real, verified, active branch',
      });
    }
    return replacementVariant;
  }

  async cancel(
    customerId: string,
    actorUserId: string,
    returnId: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockAndRequireOwnReturn(tx, customerId, returnId);
      if (r.status !== 'REQUESTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_CANCELLABLE',
          message:
            'Only a return still pending the store decision (REQUESTED) can be cancelled by the customer',
        });
      }
      const updated = await tx.return.update({
        where: { id: returnId },
        data: { status: 'CANCELLED_BY_CUSTOMER' },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.cancelled_by_customer',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REQUESTED' },
          afterState: { status: 'CANCELLED_BY_CUSTOMER' },
        },
        tx,
      );
      return returnDto(updated);
    });
  }

  async dispute(
    customerId: string,
    actorUserId: string,
    returnId: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockAndRequireOwnReturn(tx, customerId, returnId);
      if (r.status !== 'REJECTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_DISPUTABLE',
          message:
            'Only a store-level rejection (REJECTED), not yet closed, can be disputed',
        });
      }
      if (!r.disputeDeadlineAt || new Date() > r.disputeDeadlineAt) {
        throw new ConflictException({
          code: 'DISPUTE_WINDOW_EXPIRED',
          message: 'The dispute window for this rejection has closed',
        });
      }
      const updated = await tx.return.update({
        where: { id: returnId },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.disputed',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REJECTED' },
          afterState: { status: 'ESCALATED' },
        },
        tx,
      );
      return returnDto(updated);
    });
  }

  /** List the customer's own returns, newest first - the minimal
   * read-only plumbing the Orders/Returns UI needs to show "this item
   * already has a return, here's its status" without a client-side
   * returnId cache. */
  async listOwnReturns(customerId: string) {
    const rows = await this.prisma.return.findMany({
      where: {
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        branchOrderItem: {
          select: {
            id: true,
            branchOrderId: true,
            offerVariant: {
              select: {
                vendorOffer: { select: { titleAr: true, titleEn: true } },
              },
            },
          },
        },
        exchangeSettlement: true,
      },
    });
    return rows.map((r) => ({
      ...returnDto(r),
      branch_order_id: r.branchOrderItem.branchOrderId,
      branch_order_item_id: r.branchOrderItem.id,
      title_ar: r.branchOrderItem.offerVariant.vendorOffer.titleAr,
      title_en: r.branchOrderItem.offerVariant.vendorOffer.titleEn,
    }));
  }

  async getOwnReturn(customerId: string, returnId: string) {
    const r = await this.prisma.return.findFirst({
      where: {
        id: returnId,
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
      include: { exchangeSettlement: true },
    });
    if (!r) {
      throw new NotFoundException({
        code: 'RETURN_NOT_FOUND',
        message: 'Return not found',
      });
    }
    return returnDto(r);
  }

  /**
   * Sprint 21b (review-round requirement §2): a real, authenticated,
   * ownership-scoped data source for the customer's own replacement
   * picker - INDICATIVE ONLY, never a reservation. submit() and
   * approveReturn() (under a real lock) remain the only places
   * eligibility/availability is actually enforced. A variant is
   * omitted entirely unless it has a positive live quantity at AT
   * LEAST one eligible branch; a branch is omitted entirely unless it
   * is physical, APPROVED, and not archived.
   */
  async listExchangeOptions(
    customerId: string,
    branchOrderId: string,
    itemId: string,
  ) {
    const item = await this.prisma.branchOrderItem.findUnique({
      where: { id: itemId },
      include: {
        branchOrder: {
          include: { customerOrder: { select: { customerId: true } } },
        },
        offerVariant: { select: { vendorOfferId: true } },
      },
    });
    if (
      !item ||
      item.branchOrderId !== branchOrderId ||
      item.branchOrder.customerOrder.customerId !== customerId
    ) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_ITEM_NOT_FOUND',
        message: 'Order item not found',
      });
    }

    const branches = await this.prisma.storeBranch.findMany({
      where: {
        vendorId: item.vendorId,
        isPhysical: true,
        verificationStatus: 'APPROVED',
        archivedAt: null,
      },
      select: { id: true, name: true },
    });
    const branchIds = branches.map((b) => b.id);

    const variants = await this.prisma.offerVariant.findMany({
      where: {
        vendorOfferId: item.offerVariant.vendorOfferId,
        id: { not: item.offerVariantId },
      },
      include: {
        branchStocks: {
          where: { branchId: { in: branchIds } },
          select: { branchId: true, quantity: true, reservedQuantity: true },
        },
      },
    });

    const variantsOut = variants
      .map((v) => ({
        id: v.id,
        colour: v.colour,
        size: v.size,
        price: computeEffectivePrice({
          basePrice: v.basePrice,
          salePrice: v.salePrice,
          discountPercent: v.discountPercent,
          discountStartAt: v.discountStartAt,
          discountEndAt: v.discountEndAt,
        }),
        available_at_branches: v.branchStocks
          .filter((s) => s.quantity - s.reservedQuantity > 0)
          .map((s) => ({
            branch_id: s.branchId,
            available_quantity: s.quantity - s.reservedQuantity,
          })),
      }))
      .filter((v) => v.available_at_branches.length > 0);

    return {
      variants: variantsOut,
      branches: branches.map((b) => ({ id: b.id, name: b.name })),
    };
  }

  private async lockAndRequireOwnReturn(
    tx: Prisma.TransactionClient,
    customerId: string,
    returnId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
    const r = await tx.return.findFirst({
      where: {
        id: returnId,
        branchOrderItem: {
          branchOrder: { customerOrder: { customerId } },
        },
      },
    });
    if (!r) {
      throw new NotFoundException({
        code: 'RETURN_NOT_FOUND',
        message: 'Return not found',
      });
    }
    return r;
  }

  // ============================================================
  // Vendor/branch-facing
  // ============================================================

  async listForBranch(vendorId: string, branchId: string) {
    const rows = await this.prisma.return.findMany({
      where: {
        vendorId,
        branchOrderItem: { branchOrder: { branchId } },
      },
      orderBy: { createdAt: 'desc' },
      include: { exchangeSettlement: true },
    });
    return rows.map(returnDto);
  }

  // ============================================================
  // Admin-facing
  // ============================================================

  /** The admin escalation queue - ESCALATED only, the one status
   * resolveEscalation() actually acts on. */
  async listEscalated() {
    const rows = await this.prisma.return.findMany({
      where: { status: 'ESCALATED' },
      orderBy: { escalatedAt: 'asc' },
    });
    return rows.map(returnDto);
  }

  async decide(
    vendorId: string,
    branchId: string,
    returnId: string,
    actorUserId: string,
    correlationId: string,
    dto: { decision: 'approve' | 'reject'; rejection_reason?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
      const r = await tx.return.findFirst({
        where: {
          id: returnId,
          vendorId,
          branchOrderItem: { branchOrder: { branchId } },
        },
      });
      if (!r) {
        throw new NotFoundException({
          code: 'RETURN_NOT_FOUND',
          message: 'Return not found for this branch',
        });
      }
      if (r.status !== 'REQUESTED') {
        throw new ConflictException({
          code: 'RETURN_NOT_DECIDABLE',
          message: 'Only a REQUESTED return can be approved/rejected',
        });
      }

      let updated;
      if (dto.decision === 'approve') {
        updated = await this.approveReturn(tx, r);
      } else {
        const now = new Date();
        updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'REJECTED',
            rejectedAt: now,
            disputeDeadlineAt: new Date(
              now.getTime() + DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
            ),
            rejectionReason: dto.rejection_reason,
          },
        });
      }
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action:
            dto.decision === 'approve'
              ? approveAuditAction(r.desiredOutcome)
              : 'return.rejected',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'REQUESTED' },
          afterState: { status: updated.status },
        },
        tx,
      );
      await this.notifyCustomerForReturn(
        tx,
        returnId,
        dto.decision === 'approve' ? 'return.approved' : 'return.rejected',
      );
      return returnDto(updated);
    });
  }

  /**
   * Sprint 21b (review-round requirement §1): the ONE place a return
   * or exchange is ever approved - decide() and resolveEscalation()
   * (PLATFORM_ADMIN, after ESCALATED) both call this and nothing else,
   * so an admin's approval can never skip the replacement-reservation
   * step a branch employee's own approval would otherwise require.
   * Caller must already hold the Return row lock (`FOR UPDATE`).
   */
  private async approveReturn(
    tx: Prisma.TransactionClient,
    r: { id: string; vendorId: string; branchOrderItemId: string } & {
      desiredOutcome: string;
      replacementOfferVariantId: string | null;
      replacementBranchId: string | null;
    },
  ) {
    if (r.desiredOutcome !== 'EXCHANGE') {
      return this.createCodeWithRetry(tx, r.id, CODE_VALIDITY_DAYS);
    }

    const replacementBranchId = r.replacementBranchId!;
    const replacementOfferVariantId = r.replacementOfferVariantId!;

    // Review-round requirement §9: the branch may have been archived
    // (or the offer/variant turned unsellable) AFTER submit() but
    // BEFORE this approval - re-validate everything fresh, under the
    // SAME operational lock archive() itself takes, so one of the two
    // deterministically wins (see archive()'s own new check).
    await lockBranchOperationalStatus(tx, r.vendorId, replacementBranchId);
    const item = await tx.branchOrderItem.findUniqueOrThrow({
      where: { id: r.branchOrderItemId },
    });
    await this.validateReplacementVariantAndBranch(
      tx,
      r.vendorId,
      item.offerVariantId,
      (
        await tx.offerVariant.findUniqueOrThrow({
          where: { id: item.offerVariantId },
          select: { vendorOfferId: true },
        })
      ).vendorOfferId,
      replacementOfferVariantId,
      replacementBranchId,
    );

    const stock = await lockSweepOrCreateStockRow(
      tx,
      r.vendorId,
      replacementBranchId,
      replacementOfferVariantId,
    );
    const available = stock.quantity - stock.reservedQuantity;
    if (available < item.quantity) {
      throw new ConflictException({
        code: 'REPLACEMENT_NOT_AVAILABLE',
        message: 'The replacement is no longer available in enough quantity',
      });
    }
    await tx.branchStock.update({
      where: { id: stock.id },
      data: { reservedQuantity: { increment: item.quantity } },
    });

    return this.createCodeWithRetry(tx, r.id, EXCHANGE_CODE_VALIDITY_DAYS);
  }

  private async createCodeWithRetry(
    tx: Prisma.TransactionClient,
    returnId: string,
    validityDays: number,
  ) {
    const now = new Date();
    const codeExpiresAt = new Date(
      now.getTime() + validityDays * 24 * 60 * 60 * 1000,
    );
    for (let attempt = 0; attempt < RETURN_CODE_MAX_ATTEMPTS; attempt++) {
      await tx.$executeRaw`SAVEPOINT return_code_attempt`;
      try {
        const updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'APPROVED_AWAITING_DROPOFF',
            code: generateReturnCode(),
            codeExpiresAt,
          },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT return_code_attempt`;
        return updated;
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT return_code_attempt`;
        if (isUniqueViolation(err) && attempt < RETURN_CODE_MAX_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      'unreachable: return code retry loop exhausted without returning or throwing',
    );
  }

  /**
   * Sprint 21 (PDR-031 cross-branch acceptance). No `:branchId` in the
   * caller's own route (see VendorReturnsController's own comment) -
   * `VendorMembershipGuard` therefore never applies its branch-lock
   * check at all, so any OWNER/BRANCH_EMPLOYEE of this vendor reaches
   * here regardless of their own assigned branch. `receiving_branch_id`
   * is re-verified against `vendorId` explicitly below - the real
   * BOLA guarantee, not the guard.
   *
   * Lock order, fixed (Return -> BranchOrderItem -> BranchStock),
   * matching this codebase's own established deadlock-avoidance
   * discipline.
   */
  async redeem(
    vendorId: string,
    actorUserId: string,
    correlationId: string,
    dto: {
      code: string;
      receiving_branch_id: string;
      item_condition: 'RESELLABLE' | 'DAMAGED';
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.return.findFirst({
        where: {
          vendorId,
          code: dto.code,
          status: 'APPROVED_AWAITING_DROPOFF',
        },
        select: { id: true },
      });
      if (!candidate) {
        throw new ConflictException({
          code: 'INVALID_RETURN_CODE',
          message: 'This code is invalid, already used, or expired',
        });
      }

      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${candidate.id} FOR UPDATE`;
      const r = await tx.return.findUniqueOrThrow({
        where: { id: candidate.id },
        include: {
          branchOrderItem: { include: { branchOrder: true } },
        },
      });
      if (r.status !== 'APPROVED_AWAITING_DROPOFF' || r.code !== dto.code) {
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

      if (r.desiredOutcome === 'EXCHANGE') {
        // Review-round requirement §2: an exchange is redeemed ONLY at
        // its own reserved replacementBranchId - never vendor-wide the
        // way a plain RETURN is (PDR-031's cross-branch acceptance
        // never applied to exchange, by product decision).
        if (dto.receiving_branch_id !== r.replacementBranchId) {
          throw new ConflictException({
            code: 'WRONG_BRANCH_FOR_EXCHANGE',
            message:
              'This exchange can only be redeemed at its own reserved replacement branch',
          });
        }
        // Review-round requirement §9: re-check the branch is still
        // live under the SAME operational lock archive() takes - the
        // branch may have been archived after approval reserved stock
        // there.
        await lockBranchOperationalStatus(tx, vendorId, r.replacementBranchId);
        const freshBranch = await tx.storeBranch.findUniqueOrThrow({
          where: { id: r.replacementBranchId },
        });
        if (
          freshBranch.verificationStatus !== 'APPROVED' ||
          freshBranch.archivedAt !== null
        ) {
          throw new ConflictException({
            code: 'REPLACEMENT_BRANCH_NOT_AVAILABLE',
            message: 'The replacement branch is no longer active',
          });
        }
      } else {
        const branch = await tx.storeBranch.findFirst({
          where: { id: dto.receiving_branch_id, vendorId },
        });
        if (!branch) {
          throw new ForbiddenException({
            code: 'RECEIVING_BRANCH_NOT_IN_VENDOR',
            message: 'The receiving branch must belong to this vendor',
          });
        }
      }

      await tx.$queryRaw`SELECT id FROM branch_order_items WHERE id = ${r.branchOrderItemId} FOR UPDATE`;
      const item = r.branchOrderItem;
      const order = item.branchOrder;

      if (r.desiredOutcome === 'EXCHANGE') {
        return redeemResultDto(
          ...(await this.fulfillExchange(
            tx,
            vendorId,
            actorUserId,
            correlationId,
            r,
            item,
            order,
            dto.item_condition,
          )),
        );
      }

      const now = new Date();
      await tx.return.update({
        where: { id: r.id },
        data: {
          status: 'RECEIVED',
          receivingBranchId: dto.receiving_branch_id,
          receivedByUserId: actorUserId,
          receivedAt: now,
          itemCondition: dto.item_condition,
        },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.received',
          entityType: 'Return',
          entityId: r.id,
          afterState: {
            receiving_branch_id: dto.receiving_branch_id,
            item_condition: dto.item_condition,
          },
        },
        tx,
      );

      if (dto.item_condition === 'RESELLABLE') {
        await this.incrementBranchStockWithLock(
          tx,
          vendorId,
          dto.receiving_branch_id,
          item.offerVariantId,
          item.quantity,
        );
        const stock = await tx.branchStock.findUniqueOrThrow({
          where: {
            branchId_offerVariantId: {
              branchId: dto.receiving_branch_id,
              offerVariantId: item.offerVariantId,
            },
          },
        });
        await tx.stockMovement.create({
          data: {
            vendorId,
            branchId: dto.receiving_branch_id,
            offerVariantId: item.offerVariantId,
            quantityDelta: item.quantity,
            resultingQuantity: stock.quantity,
            reason: 'RETURN_RESTOCK',
            reasonNote: `Return ${r.id} - item received resellable`,
            actorId: actorUserId,
          },
        });
      }

      await tx.return.update({
        where: { id: r.id },
        data: { status: 'REFUND_PROCESSING' },
      });

      const amount = computeReturnRefundAmount(
        item.unitPrice,
        item.quantity,
        order.returnPolicySnapshotFeeIls,
      );
      const method: 'ONLINE_GATEWAY' | 'COD_CASH' =
        order.paymentMethod === 'ONLINE' ? 'ONLINE_GATEWAY' : 'COD_CASH';
      await tx.branchOrderRefund.create({
        data: {
          branchOrderId: order.id,
          branchOrderItemId: item.id,
          paymentTransactionId:
            method === 'ONLINE_GATEWAY' ? order.paymentTransactionId : null,
          amount: amount.toFixed(2),
          reason: 'ITEM_RETURNED',
          initiatedBy: 'STAFF',
          approvedByUserId: actorUserId,
          method,
          returnId: r.id,
        },
      });
      const finalReturn = await tx.return.update({
        where: { id: r.id },
        data: { status: 'REFUNDED' },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'return.refund_processed',
          entityType: 'Return',
          entityId: r.id,
          afterState: { amount: amount.toNumber(), method },
        },
        tx,
      );
      await this.notifyCustomerForReturn(tx, r.id, 'return.refunded');

      return redeemResultDto(finalReturn);
    });
  }

  /**
   * Sprint 21b (review-round requirements §5/§8): the EXCHANGE
   * outcome's own atomic completion - one transaction receives the
   * original item, settles the cash difference, and hands over the
   * replacement, going straight APPROVED_AWAITING_DROPOFF -> EXCHANGED
   * (never through RECEIVED/a processing status - nothing async
   * happens in between). Lock order: Return (caller already holds it)
   * -> branch-operational-status (caller already took it) ->
   * BranchOrderItem (caller already holds it) -> the two BranchStock
   * rows below, locked TOGETHER via lockSweepOrCreateStockRowsSorted
   * (never two sequential standalone single-key calls - a real
   * review-round finding: each standalone call independently
   * discovers-and-locks its own reservation set, which can deadlock
   * against a concurrent checkout reserve() or a second exchange
   * touching the same two keys in the opposite order - see that
   * function's own comment).
   */
  private async fulfillExchange(
    tx: Prisma.TransactionClient,
    vendorId: string,
    actorUserId: string,
    correlationId: string,
    r: {
      id: string;
      replacementBranchId: string | null;
      replacementOfferVariantId: string | null;
      replacementUnitPriceSnapshot: unknown;
    },
    item: {
      id: string;
      offerVariantId: string;
      quantity: number;
      unitPrice: unknown;
    },
    order: { returnPolicySnapshotExchangeFeeIls: unknown },
    itemCondition: 'RESELLABLE' | 'DAMAGED',
  ): Promise<
    [
      {
        id: string;
        status: string;
        receivingBranchId: string | null;
        receivedAt: Date | null;
        itemCondition: string | null;
      },
      ExchangeSettlementRow,
    ]
  > {
    const branchId = r.replacementBranchId!;
    const replacementVariantId = r.replacementOfferVariantId!;
    const now = new Date();

    const lockedStocks = await lockSweepOrCreateStockRowsSorted(tx, [
      { vendorId, branchId, offerVariantId: item.offerVariantId },
      { vendorId, branchId, offerVariantId: replacementVariantId },
    ]);
    const originalStock = lockedStocks.get(
      `${branchId}:${item.offerVariantId}`,
    )!;
    const replacementStock = lockedStocks.get(
      `${branchId}:${replacementVariantId}`,
    )!;

    // Release the reservation taken at approval time and decrement the
    // real quantity - the replacement physically leaves the shelf now.
    await tx.branchStock.update({
      where: { id: replacementStock.id },
      data: {
        reservedQuantity: { decrement: item.quantity },
        quantity: { decrement: item.quantity },
      },
    });
    const updatedReplacementStock = await tx.branchStock.findUniqueOrThrow({
      where: { id: replacementStock.id },
    });
    await tx.stockMovement.create({
      data: {
        vendorId,
        branchId,
        offerVariantId: replacementVariantId,
        quantityDelta: -item.quantity,
        resultingQuantity: updatedReplacementStock.quantity,
        reason: 'EXCHANGE_FULFILLED',
        reasonNote: `Return ${r.id} - replacement handed over`,
        actorId: actorUserId,
      },
    });

    if (itemCondition === 'RESELLABLE') {
      await tx.branchStock.update({
        where: { id: originalStock.id },
        data: { quantity: { increment: item.quantity } },
      });
      const updatedOriginalStock = await tx.branchStock.findUniqueOrThrow({
        where: { id: originalStock.id },
      });
      await tx.stockMovement.create({
        data: {
          vendorId,
          branchId,
          offerVariantId: item.offerVariantId,
          quantityDelta: item.quantity,
          resultingQuantity: updatedOriginalStock.quantity,
          reason: 'RETURN_RESTOCK',
          reasonNote: `Return ${r.id} - exchanged item received resellable`,
          actorId: actorUserId,
        },
      });
    }

    const calc = computeExchangeSettlement(
      item.unitPrice,
      r.replacementUnitPriceSnapshot,
      item.quantity,
      order.returnPolicySnapshotExchangeFeeIls,
    );
    const settlement = await tx.exchangeSettlement.create({
      data: {
        returnId: r.id,
        branchOrderItemId: item.id,
        vendorId,
        originalUnitPriceSnapshot: this.decimalToFixed(item.unitPrice),
        replacementUnitPriceSnapshot: this.decimalToFixed(
          r.replacementUnitPriceSnapshot,
        ),
        quantity: item.quantity,
        exchangeFeeSnapshot: this.decimalToFixed(
          order.returnPolicySnapshotExchangeFeeIls,
        ),
        originalTotal: calc.originalTotal.toFixed(2),
        replacementTotal: calc.replacementTotal.toFixed(2),
        netAmount: calc.netAmount.toFixed(2),
        direction: calc.direction,
      },
    });

    const finalReturn = await tx.return.update({
      where: { id: r.id },
      data: {
        status: 'EXCHANGED',
        receivingBranchId: branchId,
        receivedByUserId: actorUserId,
        receivedAt: now,
        itemCondition,
      },
    });
    await this.auditLog.record(
      {
        actorId: actorUserId,
        correlationId,
        action: 'return.exchange_fulfilled',
        entityType: 'Return',
        entityId: r.id,
        afterState: {
          item_condition: itemCondition,
          net_amount: calc.netAmount.toNumber(),
          direction: calc.direction,
        },
      },
      tx,
    );
    await this.notifyCustomerForReturn(tx, r.id, 'return.exchanged');

    return [finalReturn, settlement];
  }

  private decimalToFixed(value: unknown): string {
    return value == null ? '0.00' : toDecimal(value).toFixed(2);
  }

  private async incrementBranchStockWithLock(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    offerVariantId: string,
    incrementBy: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_stock:' || ${branchId} || ':' || ${offerVariantId}))`;
    const existing = await tx.branchStock.findUnique({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
    if (existing) {
      await tx.branchStock.update({
        where: { id: existing.id },
        data: { quantity: { increment: incrementBy } },
      });
    } else {
      await tx.branchStock.create({
        data: { vendorId, branchId, offerVariantId, quantity: incrementBy },
      });
    }
  }

  // ============================================================
  // Admin-facing (escalation resolution)
  // ============================================================

  async resolveEscalation(
    adminUserId: string,
    correlationId: string,
    returnId: string,
    dto: { decision: 'approve' | 'reject'; rejection_reason?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
      const r = await tx.return.findUnique({ where: { id: returnId } });
      if (!r) {
        throw new NotFoundException({
          code: 'RETURN_NOT_FOUND',
          message: 'Return not found',
        });
      }
      if (r.status !== 'ESCALATED') {
        throw new ConflictException({
          code: 'RETURN_NOT_ESCALATED',
          message: 'Only an ESCALATED return can receive an admin decision',
        });
      }

      let updated;
      if (dto.decision === 'approve') {
        updated = await this.approveReturn(tx, r);
      } else {
        updated = await tx.return.update({
          where: { id: returnId },
          data: {
            status: 'ADMIN_REJECTED',
            rejectionReason: dto.rejection_reason,
            escalationResolvedAt: new Date(),
            escalationResolvedByUserId: adminUserId,
          },
        });
      }
      await this.auditLog.record(
        {
          actorId: adminUserId,
          correlationId,
          action:
            dto.decision === 'approve'
              ? r.desiredOutcome === 'EXCHANGE'
                ? 'return.exchange_escalation_approved'
                : 'return.escalation_approved'
              : 'return.escalation_admin_rejected',
          entityType: 'Return',
          entityId: returnId,
          beforeState: { status: 'ESCALATED' },
          afterState: { status: updated.status },
        },
        tx,
      );
      await this.notifyCustomerForReturn(
        tx,
        returnId,
        dto.decision === 'approve'
          ? 'return.approved'
          : 'return.admin_rejected',
      );
      return returnDto(updated);
    });
  }

  // ============================================================
  // Notification helpers - deep link/id only, NEVER reasonNote,
  // photoUrls, or rejectionReason (same privacy convention as Sprint
  // 20b's internalStoreNote/customerNote).
  // ============================================================

  private async notifyBranch(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipients = await tx.vendorUser.findMany({
      where: {
        vendorId,
        status: 'ACTIVE',
        OR: [{ role: 'OWNER' }, { role: 'BRANCH_EMPLOYEE', branchId }],
      },
      select: { userId: true },
    });
    for (const recipient of recipients) {
      await this.outbox.enqueue(
        {
          eventType,
          payload: { ...payload, recipient_user_id: recipient.userId },
        },
        tx,
      );
    }
  }

  private async notifyCustomerForReturn(
    tx: Prisma.TransactionClient,
    returnId: string,
    eventType: string,
  ): Promise<void> {
    const r = await tx.return.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        branchOrderItem: {
          include: {
            branchOrder: {
              include: {
                customerOrder: {
                  select: { customer: { select: { userId: true } } },
                },
              },
            },
          },
        },
      },
    });
    await this.outbox.enqueue(
      {
        eventType,
        payload: {
          return_id: returnId,
          recipient_user_id:
            r.branchOrderItem.branchOrder.customerOrder.customer.userId,
        },
      },
      tx,
    );
  }
}
