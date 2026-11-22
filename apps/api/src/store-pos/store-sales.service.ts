import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { VendorMembership } from '../auth/vendor-membership.guard';
import { legacyVariantBarcode, normalizeBarcode } from '../common/barcode.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import {
  crossesIntoLowStock,
  enqueueLowStockAlert,
} from '../common/low-stock-alert.util';
import {
  dateOnly,
  localDateString,
  windowStartInstant,
} from '../checkout/delivery-calendar.util';
import {
  lockOffersWideForRestock,
  lockSweepOrCreateStockRowsSorted,
} from '../checkout/stock-lock.util';
import {
  enqueueFavoriteNotification,
  enqueueVariantAvailabilityNotifications,
} from '../favorites/favorite-alerts.util';
import { computeEffectivePrice } from '../offers/pricing/effective-price.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { barcodeProblem } from './offer-barcodes.service';
import type { CreateStoreSaleDto } from './dto/store-pos.dto';

/** Only these may be sold in the shop: published, or hidden from shoppers (INACTIVE). Never a draft or an archived product. */
const SELLABLE_STATUSES = new Set(['ACTIVE', 'INACTIVE']);

export function saleNumberLabel(n: number): string {
  return `S-${String(n).padStart(6, '0')}`;
}

function cents(v: number): number {
  return Math.round(v * 100);
}

function money(v: Prisma.Decimal | number): string {
  return Number(v).toFixed(2);
}

const SALE_INCLUDE = {
  branch: { select: { id: true, name: true } },
  soldBy: {
    select: {
      id: true,
      phone: true,
      customerProfile: { select: { displayName: true } },
    },
  },
  voidedBy: {
    select: {
      id: true,
      phone: true,
      customerProfile: { select: { displayName: true } },
    },
  },
  items: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.StoreSaleInclude;

type SaleWithItems = Prisma.StoreSaleGetPayload<{
  include: typeof SALE_INCLUDE;
}>;

function personDto(
  u: {
    id: string;
    phone: string;
    customerProfile: { displayName: string | null } | null;
  } | null,
) {
  if (!u) return null;
  return { id: u.id, name: u.customerProfile?.displayName || u.phone };
}

export function saleDto(s: SaleWithItems, now: Date = new Date()) {
  return {
    id: s.id,
    sale_number: s.saleNumber,
    sale_label: saleNumberLabel(s.saleNumber),
    status: s.status,
    payment_method: s.paymentMethod,
    total: money(s.total),
    currency: s.currency,
    units: s.items.reduce((n, i) => n + i.quantity, 0),
    branch: { id: s.branch.id, name: s.branch.name },
    sold_by: personDto(s.soldBy),
    created_at: s.createdAt.toISOString(),
    voided_at: s.voidedAt?.toISOString() ?? null,
    voided_by: personDto(s.voidedBy),
    void_reason: s.voidReason,
    /** The owner may still void it: completed, and still its own day (Palestine time). */
    voidable:
      s.status === 'COMPLETED' &&
      localDateString(s.createdAt) === localDateString(now),
    lines: s.items.map((i) => ({
      id: i.id,
      offer_id: i.vendorOfferId,
      offer_variant_id: i.offerVariantId,
      title_ar: i.titleArSnapshot,
      title_en: i.titleEnSnapshot,
      color_name_ar: i.colorNameArSnapshot,
      color_name_en: i.colorNameEnSnapshot,
      size_code: i.sizeCodeSnapshot,
      size_label: i.sizeLabelSnapshot,
      quantity: i.quantity,
      unit_price: money(i.unitPrice),
      line_total: money(i.lineTotal),
      scanned_code: i.scannedCode,
    })),
  };
}

const VARIANT_CARD_SELECT = {
  id: true,
  vendorOfferId: true,
  colour: true,
  size: true,
  sizeCode: true,
  offerColorId: true,
  createdAt: true,
  basePrice: true,
  salePrice: true,
  discountPercent: true,
  discountStartAt: true,
  discountEndAt: true,
  offerColor: {
    select: {
      id: true,
      nameAr: true,
      nameEn: true,
      hex: true,
      sortOrder: true,
      family: { select: { hex: true } },
    },
  },
  sizeOption: { select: { code: true, label: true, sortOrder: true } },
} satisfies Prisma.OfferVariantSelect;

type CardVariant = Prisma.OfferVariantGetPayload<{
  select: typeof VARIANT_CARD_SELECT;
}>;

function colourOf(v: CardVariant) {
  if (v.offerColor) {
    return {
      key: v.offerColor.id,
      name_ar: v.offerColor.nameAr,
      name_en: v.offerColor.nameEn ?? null,
      hex: v.offerColor.hex ?? v.offerColor.family.hex ?? null,
      sort: v.offerColor.sortOrder,
    };
  }
  // a legacy variant: its free-text colour (or none)
  return v.colour
    ? {
        key: `text:${v.colour}`,
        name_ar: v.colour,
        name_en: null,
        hex: null,
        sort: 10_000,
      }
    : null;
}

function sizeOf(v: CardVariant) {
  if (v.sizeOption)
    return {
      code: v.sizeOption.code,
      label: v.sizeOption.label,
      sort: v.sizeOption.sortOrder,
    };
  return v.size ? { code: null, label: v.size, sort: 10_000 } : null;
}

/**
 * «بيع من المحل»: the cashier's product card, a real in-store sale and its
 * same-day whole-sale void. A sale is ONE transaction: stock rows locked
 * in the shared global order, each colour x size x branch decremented with
 * the reservation-respecting guard, a SALE StockMovement per line, the
 * sale + lines with price/name snapshots, the audit entry, the existing
 * low-stock alert when a line crosses into 1-3, and the idempotency record.
 * Never a BranchOrder, never in the public bestseller ranking.
 */
@Injectable()
export class StoreSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  /** The branch a sale happens at: this store's, physical, not archived. */
  private async requireSellingBranch(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    branchId: string,
  ) {
    const branch = await db.storeBranch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        vendorId: true,
        name: true,
        isPhysical: true,
        archivedAt: true,
      },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    if (branch.archivedAt) {
      throw new ConflictException({
        code: 'BRANCH_ARCHIVED',
        message: 'This branch is archived',
      });
    }
    if (!branch.isPhysical) {
      throw new ConflictException({
        code: 'BRANCH_NOT_PHYSICAL',
        message: 'In-store sales need a physical branch',
      });
    }
    return branch;
  }

  /**
   * What the cashier screen starts from: the branches this person may sell
   * at - the owner: every physical, non-archived branch; an employee: their
   * own branch only (empty when it is archived or not physical).
   */
  async start(vendorId: string, membership: VendorMembership, userId: string) {
    const branches = await this.prisma.storeBranch.findMany({
      where: {
        vendorId,
        isPhysical: true,
        archivedAt: null,
        ...(membership.role === 'BRANCH_EMPLOYEE'
          ? { id: membership.branchId ?? '__none__' }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    return {
      role: membership.role,
      /** who is signed in (the device keeps a print list per store and person) */
      user_id: userId,
      branches,
      can_void: membership.role === 'OWNER',
      can_link_barcodes: membership.role === 'OWNER',
    };
  }

  // ------------------------------------------------------------------
  // The product card for a scanned / typed code
  // ------------------------------------------------------------------

  async lookup(
    vendorId: string,
    branchId: string,
    rawCode: string | undefined,
  ) {
    const branch = await this.requireSellingBranch(
      this.prisma,
      vendorId,
      branchId,
    );
    let offerId: string;
    let preselectVariantId: string | null = null;
    let matchedBy: 'PRODUCT_BARCODE' | 'LEGACY_VARIANT_CODE';
    let code: string;

    const legacy = legacyVariantBarcode(rawCode ?? '');
    if (legacy) {
      // compatibility only: an old per-variant label opens its product with that colour x size chosen
      const variant = await this.prisma.offerVariant.findFirst({
        where: { vendorId, storeInventoryBarcode: legacy },
        select: { id: true, vendorOfferId: true },
      });
      if (!variant)
        throw new NotFoundException({
          code: 'BARCODE_UNKNOWN',
          message: 'This barcode is not linked to a product of this store',
        });
      offerId = variant.vendorOfferId;
      preselectVariantId = variant.id;
      matchedBy = 'LEGACY_VARIANT_CODE';
      code = legacy;
    } else {
      const normalized = normalizeBarcode(rawCode);
      if (!normalized.ok) throw barcodeProblem(normalized.problem);
      const row = await this.prisma.offerBarcode.findUnique({
        where: { vendorId_code: { vendorId, code: normalized.code } },
        select: { vendorOfferId: true },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'BARCODE_UNKNOWN',
          message: 'This barcode is not linked to a product of this store',
          details: [{ code: normalized.code }],
        });
      }
      offerId = row.vendorOfferId;
      matchedBy = 'PRODUCT_BARCODE';
      code = normalized.code;
    }
    return this.card(vendorId, branch, offerId, {
      matchedBy,
      code,
      preselectVariantId,
    });
  }

  private async card(
    vendorId: string,
    branch: { id: string; name: string },
    offerId: string,
    match: {
      matchedBy: string;
      code: string;
      preselectVariantId: string | null;
    },
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        vendorId: true,
        titleAr: true,
        titleEn: true,
        status: true,
        archivedAt: true,
        variants: {
          select: VARIANT_CARD_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        sharedMedia: {
          select: { url: true },
          orderBy: { sortOrder: 'asc' },
          take: 1,
        },
      },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BARCODE_UNKNOWN',
        message: 'This barcode is not linked to a product of this store',
      });
    }
    if (
      !(await this.prisma.offerBarcode.count({
        where: { vendorOfferId: offer.id },
      }))
    ) {
      // (reachable through an old SIB- label only) - add a barcode first, never made silently
      throw new ConflictException({
        code: 'PRODUCT_NEEDS_BARCODE',
        message:
          'This product has no store barcode yet - add one before selling it in the shop',
        details: [
          {
            offer_id: offer.id,
            title_ar: offer.titleAr,
            title_en: offer.titleEn,
          },
        ],
      });
    }
    if (!SELLABLE_STATUSES.has(offer.status) || offer.archivedAt) {
      throw new ConflictException({
        code: 'PRODUCT_NOT_SELLABLE',
        message: 'Only a published or hidden product can be sold in the shop',
        details: [
          {
            offer_id: offer.id,
            title_ar: offer.titleAr,
            title_en: offer.titleEn,
            status: offer.archivedAt ? 'ARCHIVED' : offer.status,
          },
        ],
      });
    }
    const variantIds = offer.variants.map((v) => v.id);
    const [stocks, media] = await Promise.all([
      this.prisma.branchStock.findMany({
        where: {
          vendorId,
          branchId: branch.id,
          offerVariantId: { in: variantIds },
        },
        select: {
          offerVariantId: true,
          quantity: true,
          reservedQuantity: true,
        },
      }),
      this.prisma.offerVariantMedia.findMany({
        where: {
          vendorId,
          offerVariantId: { in: variantIds },
          kind: 'PRIMARY',
          mediaType: 'IMAGE',
        },
        select: { url: true, offerVariantId: true },
      }),
    ]);
    const stockBy = new Map(stocks.map((s) => [s.offerVariantId, s]));
    const imageBy = new Map(media.map((m) => [m.offerVariantId, m.url]));
    const now = new Date();

    const options = offer.variants.map((v) => {
      const s = stockBy.get(v.id);
      const colour = colourOf(v);
      const size = sizeOf(v);
      return {
        offer_variant_id: v.id,
        color_key: colour?.key ?? null,
        color_name_ar: colour?.name_ar ?? null,
        color_name_en: colour?.name_en ?? null,
        color_hex: colour?.hex ?? null,
        color_sort: colour?.sort ?? 0,
        size_code: size?.code ?? null,
        size_label: size?.label ?? null,
        size_sort: size?.sort ?? 0,
        unit_price: computeEffectivePrice(v, now).toFixed(2),
        available: Math.max(0, (s?.quantity ?? 0) - (s?.reservedQuantity ?? 0)),
        image_url: imageBy.get(v.id) ?? null,
      };
    });
    options.sort(
      (a, b) => a.color_sort - b.color_sort || a.size_sort - b.size_sort,
    );
    const firstImage =
      options.find((o) => o.image_url)?.image_url ??
      offer.sharedMedia[0]?.url ??
      null;

    return {
      matched_by: match.matchedBy,
      code: match.code,
      branch: { id: branch.id, name: branch.name },
      offer: {
        id: offer.id,
        title_ar: offer.titleAr,
        title_en: offer.titleEn,
        status: offer.status,
        image_url: firstImage,
      },
      options,
      preselect_variant_id: match.preselectVariantId,
    };
  }

  // ------------------------------------------------------------------
  // A sale
  // ------------------------------------------------------------------

  async create(
    vendorId: string,
    branchId: string,
    dto: CreateStoreSaleDto,
    userId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
  ) {
    // one line per colour x size: repeated lines are added together
    const merged = new Map<
      string,
      {
        offerVariantId: string;
        quantity: number;
        expected: number;
        scannedCode: string | null;
        order: number;
      }
    >();
    for (const [order, line] of dto.lines.entries()) {
      const prev = merged.get(line.offer_variant_id);
      if (prev) {
        if (cents(prev.expected) !== cents(line.expected_unit_price)) {
          throw new BadRequestException({
            code: 'SALE_LINES_DISAGREE',
            message:
              'Two lines of the same colour and size carry different prices',
          });
        }
        prev.quantity += line.quantity;
        continue;
      }
      merged.set(line.offer_variant_id, {
        offerVariantId: line.offer_variant_id,
        quantity: line.quantity,
        expected: line.expected_unit_price,
        scannedCode: line.scanned_code?.trim().slice(0, 64) || null,
        order,
      });
    }
    const lines = [...merged.values()].sort((a, b) => a.order - b.order);
    if (lines.some((l) => l.quantity > 999)) {
      throw new BadRequestException({
        code: 'SALE_QUANTITY_TOO_LARGE',
        message: 'At most 999 units of one colour and size per sale',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const branch = await this.requireSellingBranch(tx, vendorId, branchId);
      const variants = await tx.offerVariant.findMany({
        where: { vendorId, id: { in: lines.map((l) => l.offerVariantId) } },
        select: {
          ...VARIANT_CARD_SELECT,
          vendorOffer: {
            select: {
              id: true,
              titleAr: true,
              titleEn: true,
              status: true,
              archivedAt: true,
            },
          },
        },
      });
      const variantBy = new Map(variants.map((v) => [v.id, v]));
      const missing = lines.filter((l) => !variantBy.has(l.offerVariantId));
      if (missing.length) {
        throw new NotFoundException({
          code: 'OFFER_VARIANT_NOT_FOUND',
          message:
            'A colour and size of this sale does not belong to this store',
          details: missing.map((l) => ({ offer_variant_id: l.offerVariantId })),
        });
      }
      const notSellable = lines.filter((l) => {
        const o = variantBy.get(l.offerVariantId)!.vendorOffer;
        return !SELLABLE_STATUSES.has(o.status) || o.archivedAt;
      });
      if (notSellable.length) {
        throw new ConflictException({
          code: 'PRODUCT_NOT_SELLABLE',
          message: 'Only a published or hidden product can be sold in the shop',
          details: notSellable.map((l) => {
            const o = variantBy.get(l.offerVariantId)!.vendorOffer;
            return {
              offer_variant_id: l.offerVariantId,
              offer_id: o.id,
              title_ar: o.titleAr,
              title_en: o.titleEn,
              status: o.archivedAt ? 'ARCHIVED' : o.status,
            };
          }),
        });
      }

      // a product without a store barcode is not sold at the cashier
      const coded = new Set(
        (
          await tx.offerBarcode.findMany({
            where: {
              vendorId,
              vendorOfferId: {
                in: [...new Set(variants.map((v) => v.vendorOfferId))],
              },
            },
            select: { vendorOfferId: true },
          })
        ).map((r) => r.vendorOfferId),
      );
      const uncoded = lines.filter(
        (l) => !coded.has(variantBy.get(l.offerVariantId)!.vendorOfferId),
      );
      if (uncoded.length) {
        throw new ConflictException({
          code: 'PRODUCT_NEEDS_BARCODE',
          message:
            'This product has no store barcode yet - add one before selling it in the shop',
          details: uncoded.map((l) => {
            const o = variantBy.get(l.offerVariantId)!.vendorOffer;
            return {
              offer_variant_id: l.offerVariantId,
              offer_id: o.id,
              title_ar: o.titleAr,
              title_en: o.titleEn,
            };
          }),
        });
      }

      // the price at confirmation; a different price than the screen showed is never charged silently
      const now = new Date();
      const priced = lines.map((l) => ({
        ...l,
        unitPrice: computeEffectivePrice(variantBy.get(l.offerVariantId)!, now),
      }));
      const changed = priced.filter(
        (l) => cents(l.unitPrice) !== cents(l.expected),
      );
      if (changed.length) {
        throw new ConflictException({
          code: 'PRICE_CHANGED',
          message:
            'The price of an item changed - check the basket and confirm again',
          details: changed.map((l) => ({
            offer_variant_id: l.offerVariantId,
            unit_price: l.unitPrice.toFixed(2),
            expected_unit_price: l.expected.toFixed(2),
          })),
        });
      }

      // the stock rows, locked in the one global order every stock writer uses
      const locked = await lockSweepOrCreateStockRowsSorted(
        tx,
        priced.map((l) => ({
          vendorId,
          branchId,
          offerVariantId: l.offerVariantId,
        })),
      );
      const short = priced
        .map((l) => {
          const s = locked.get(`${branchId}:${l.offerVariantId}`)!;
          return { line: l, available: s.quantity - s.reservedQuantity };
        })
        .filter((x) => x.available < x.line.quantity);
      if (short.length) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: 'Not enough of a colour and size at this branch',
          details: short.map((x) => ({
            offer_variant_id: x.line.offerVariantId,
            available: Math.max(0, x.available),
            requested: x.line.quantity,
          })),
        });
      }

      const [counter] = await tx.$queryRaw<{ n: number }[]>`
        INSERT INTO vendor_code_counters ("vendorId", "lastSaleNumber") VALUES (${vendorId}, 1)
        ON CONFLICT ("vendorId") DO UPDATE SET "lastSaleNumber" = vendor_code_counters."lastSaleNumber" + 1
        RETURNING "lastSaleNumber" AS n`;
      const saleNumber = Number(counter.n);
      const note = `بيع من المحل ${saleNumberLabel(saleNumber)}`;

      const movements: { line: (typeof priced)[number]; movementId: string }[] =
        [];
      // 2026-11-22: the seller's store role now - kept on each stock log line
      const sellerRole =
        (
          await tx.vendorUser.findFirst({
            where: { vendorId, userId },
            select: { role: true },
          })
        )?.role ?? null;
      for (const l of priced) {
        const s = locked.get(`${branchId}:${l.offerVariantId}`)!;
        const updated = await tx.$queryRaw<
          {
            quantity: number;
            reservedQuantity: number;
            safetyStockThreshold: number;
          }[]
        >`
          UPDATE branch_stock SET quantity = quantity - ${l.quantity}, "updatedAt" = now()
          WHERE id = ${s.id} AND quantity - ${l.quantity} - "reservedQuantity" >= 0
          RETURNING quantity, "reservedQuantity", "safetyStockThreshold"`;
        if (updated.length === 0) {
          // unreachable under the row lock above - kept as the honest backstop
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: 'Not enough of a colour and size at this branch',
          });
        }
        const movement = await tx.stockMovement.create({
          data: {
            vendorId,
            branchId,
            offerVariantId: l.offerVariantId,
            quantityDelta: -l.quantity,
            resultingQuantity: updated[0].quantity,
            reason: 'SALE',
            reasonNote: note,
            actorId: userId,
            // 2026-11-22: the seller's role at that moment (the stock log)
            actorRole: sellerRole,
          },
        });
        movements.push({ line: l, movementId: movement.id });
        const before = s.quantity - s.reservedQuantity;
        const after = updated[0].quantity - updated[0].reservedQuantity;
        // 2026-11-22: the owner's safety threshold first (1-3 only as a fallback)
        if (
          crossesIntoLowStock(before, after, updated[0].safetyStockThreshold)
        ) {
          await enqueueLowStockAlert(tx, this.outbox, {
            vendorId,
            branchId,
            offerVariantId: l.offerVariantId,
            remainingQuantity: after,
          });
        }
      }

      const total =
        priced.reduce((sum, l) => sum + cents(l.unitPrice) * l.quantity, 0) /
        100;
      const sale = await tx.storeSale.create({
        data: {
          vendorId,
          branchId: branch.id,
          saleNumber,
          paymentMethod: dto.payment_method,
          total: total.toFixed(2),
          soldById: userId,
        },
      });
      await tx.storeSaleItem.createMany({
        // one millisecond apart: the lines read back in the basket's order
        data: movements.map(({ line, movementId }, index) => {
          const v = variantBy.get(line.offerVariantId)!;
          const colour = colourOf(v);
          const size = sizeOf(v);
          return {
            vendorId,
            storeSaleId: sale.id,
            vendorOfferId: v.vendorOfferId,
            offerVariantId: v.id,
            quantity: line.quantity,
            unitPrice: line.unitPrice.toFixed(2),
            lineTotal: ((cents(line.unitPrice) * line.quantity) / 100).toFixed(
              2,
            ),
            titleArSnapshot: v.vendorOffer.titleAr,
            titleEnSnapshot: v.vendorOffer.titleEn,
            colorNameArSnapshot: colour?.name_ar ?? null,
            colorNameEnSnapshot: colour?.name_en ?? null,
            sizeCodeSnapshot: size?.code ?? null,
            sizeLabelSnapshot: size?.label ?? null,
            scannedCode: line.scannedCode,
            saleMovementId: movementId,
            createdAt: new Date(now.getTime() + index),
          };
        }),
      });
      const full = await tx.storeSale.findUniqueOrThrow({
        where: { id: sale.id },
        include: SALE_INCLUDE,
      });
      const body = saleDto(full, now);
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'store_sale.recorded',
          entityType: 'StoreSale',
          entityId: sale.id,
          afterState: {
            sale_number: saleNumber,
            branch_id: branchId,
            payment_method: dto.payment_method,
            total: body.total,
            lines: movements.map(({ line, movementId }) => ({
              offer_variant_id: line.offerVariantId,
              quantity: line.quantity,
              unit_price: line.unitPrice.toFixed(2),
              stock_movement_id: movementId,
            })),
          },
        },
        tx,
      );
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  // ------------------------------------------------------------------
  // «مبيعات المحل»: the owner's list (every branch), an employee's (own branch only)
  // ------------------------------------------------------------------

  /** The branch an employee is limited to; the owner may name any of the store's branches (or none). */
  private scopeBranch(
    membership: VendorMembership,
    requested: string | undefined,
  ): string | undefined {
    if (membership.role === 'BRANCH_EMPLOYEE') {
      if (requested && requested !== membership.branchId) {
        throw new ForbiddenException({
          code: 'BRANCH_ACCESS_DENIED',
          message: 'You are not assigned to this branch',
        });
      }
      return membership.branchId ?? '__none__';
    }
    return requested || undefined;
  }

  async list(
    vendorId: string,
    membership: VendorMembership,
    q: {
      branch_id?: string;
      from?: string;
      to?: string;
      status?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    const branchId = this.scopeBranch(membership, q.branch_id);
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((q.from && !day.test(q.from)) || (q.to && !day.test(q.to))) {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: 'from / to must be YYYY-MM-DD',
      });
    }
    if (q.status && q.status !== 'COMPLETED' && q.status !== 'VOIDED') {
      throw new BadRequestException({
        code: 'INVALID_STATUS',
        message: 'status must be COMPLETED or VOIDED',
      });
    }
    const createdAt: Prisma.DateTimeFilter = {};
    // a day is a Palestine calendar day
    if (q.from) createdAt.gte = windowStartInstant(dateOnly(q.from), 0);
    if (q.to) createdAt.lt = windowStartInstant(dateOnly(q.to), 24 * 60);
    const where: Prisma.StoreSaleWhereInput = {
      vendorId,
      ...(branchId ? { branchId } : {}),
      ...(q.from || q.to ? { createdAt } : {}),
    };
    const listWhere: Prisma.StoreSaleWhereInput = {
      ...where,
      ...(q.status ? { status: q.status as 'COMPLETED' | 'VOIDED' } : {}),
    };
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor, [isIsoDateString, isUuidLike]);
    if (cursor) {
      const [at, id] = cursor as [string, string];
      listWhere.AND = [
        {
          OR: [
            { createdAt: { lt: new Date(at) } },
            { createdAt: new Date(at), id: { lt: id } },
          ],
        },
      ];
    }
    const [rows, completed, completedUnits, voidedCount] = await Promise.all([
      this.prisma.storeSale.findMany({
        where: listWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: SALE_INCLUDE,
      }),
      this.prisma.storeSale.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.prisma.storeSaleItem.aggregate({
        where: { storeSale: { ...where, status: 'COMPLETED' } },
        _sum: { quantity: true },
      }),
      this.prisma.storeSale.count({ where: { ...where, status: 'VOIDED' } }),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const now = new Date();
    return {
      items: page.map((s) => saleDto(s, now)),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
      summary: {
        sales_count: completed._count._all,
        total: money(completed._sum.total ?? 0),
        units: completedUnits._sum.quantity ?? 0,
        voided_count: voidedCount,
      },
      branch_id: branchId && branchId !== '__none__' ? branchId : null,
    };
  }

  async get(vendorId: string, membership: VendorMembership, saleId: string) {
    const sale = await this.prisma.storeSale.findUnique({
      where: { id: saleId },
      include: SALE_INCLUDE,
    });
    if (
      !sale ||
      sale.vendorId !== vendorId ||
      (membership.role === 'BRANCH_EMPLOYEE' &&
        sale.branchId !== membership.branchId)
    ) {
      throw new NotFoundException({
        code: 'STORE_SALE_NOT_FOUND',
        message: 'Sale not found',
      });
    }
    return saleDto(sale);
  }

  // ------------------------------------------------------------------
  // The owner's same-day void of a WHOLE sale
  // ------------------------------------------------------------------

  async void(
    vendorId: string,
    saleId: string,
    reasonRaw: string,
    userId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
  ) {
    const reason = reasonRaw.trim();
    if (!reason)
      throw new BadRequestException({
        code: 'VOID_REASON_REQUIRED',
        message: 'A reason is required',
      });
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string; vendorId: string }[]>`
        SELECT id, "vendorId" FROM store_sales WHERE id = ${saleId} FOR UPDATE`;
      if (!locked || locked.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'STORE_SALE_NOT_FOUND',
          message: 'Sale not found',
        });
      }
      const sale = await tx.storeSale.findUniqueOrThrow({
        where: { id: saleId },
        include: SALE_INCLUDE,
      });
      if (sale.status !== 'COMPLETED') {
        throw new ConflictException({
          code: 'STORE_SALE_ALREADY_VOIDED',
          message: 'This sale is already cancelled',
        });
      }
      const now = new Date();
      if (localDateString(sale.createdAt) !== localDateString(now)) {
        throw new ConflictException({
          code: 'VOID_WINDOW_CLOSED',
          message: 'A sale can only be cancelled on the day it was made',
        });
      }
      const branch = await tx.storeBranch.findUniqueOrThrow({
        where: { id: sale.branchId },
        select: { archivedAt: true },
      });
      if (branch.archivedAt) {
        throw new ConflictException({
          code: 'BRANCH_ARCHIVED',
          message: 'This branch is archived',
        });
      }

      // every line's units back to the SAME colour x size x branch, in one batched,
      // globally-ordered pass - with the offer-wide totals a back-in-stock alert needs
      const siblings = (
        await tx.storeBranch.findMany({
          where: {
            vendorId,
            isPhysical: true,
            archivedAt: null,
            id: { not: sale.branchId },
          },
          select: { id: true },
        })
      ).map((b) => b.id);
      const results = await lockOffersWideForRestock(
        tx,
        sale.items.map((i) => ({
          vendorId,
          branchId: sale.branchId,
          offerVariantId: i.offerVariantId,
          quantityDelta: i.quantity,
          siblingBranchIds: siblings,
        })),
      );
      const note =
        `إلغاء بيع من المحل ${saleNumberLabel(sale.saleNumber)}: ${reason}`.slice(
          0,
          1000,
        );
      const voidMovements: { itemId: string; movementId: string }[] = [];
      const alerted = new Set<string>();
      for (const item of sale.items) {
        const r = results.get(`${sale.branchId}:${item.offerVariantId}`)!;
        const movement = await tx.stockMovement.create({
          data: {
            vendorId,
            branchId: sale.branchId,
            offerVariantId: item.offerVariantId,
            quantityDelta: item.quantity,
            resultingQuantity: r.targetStock.quantity,
            reason: 'STORE_SALE_VOID',
            reasonNote: note,
            actorId: userId,
            actorRole: 'OWNER', // the void route is owner-only
          },
        });
        await tx.storeSaleItem.update({
          where: { id: item.id },
          data: { voidMovementId: movement.id },
        });
        voidMovements.push({ itemId: item.id, movementId: movement.id });
        // the same sold-out-everywhere -> available transition alerts a manual restock sends
        if (
          r.before === 0 &&
          (r.after ?? 0) > 0 &&
          !alerted.has(item.offerVariantId)
        ) {
          alerted.add(item.offerVariantId);
          await enqueueFavoriteNotification(tx, this.outbox, {
            eventType: 'favorite.back_in_stock',
            alertType: 'BACK_IN_STOCK',
            offerVariantId: item.offerVariantId,
            payload: {
              vendor_id: vendorId,
              offer_variant_id: item.offerVariantId,
            },
          });
          await enqueueVariantAvailabilityNotifications(tx, this.outbox, {
            vendorId,
            offerVariantId: item.offerVariantId,
          });
        }
      }
      await tx.storeSale.update({
        where: { id: sale.id },
        data: {
          status: 'VOIDED',
          voidedAt: now,
          voidedById: userId,
          voidReason: reason,
        },
      });
      const full = await tx.storeSale.findUniqueOrThrow({
        where: { id: sale.id },
        include: SALE_INCLUDE,
      });
      const body = saleDto(full, now);
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'store_sale.voided',
          entityType: 'StoreSale',
          entityId: sale.id,
          beforeState: {
            status: 'COMPLETED',
            sale_number: sale.saleNumber,
            total: money(sale.total),
          },
          afterState: {
            status: 'VOIDED',
            reason,
            void_movements: voidMovements,
          },
        },
        tx,
      );
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }
}
