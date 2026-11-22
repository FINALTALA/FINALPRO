import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { isLowNow } from '../common/low-stock-alert.util';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { saleNumberLabel } from '../store-pos/store-sales.service';

/**
 * «إدارة مخزون الفرع v1» (2026-11-22): the branch's stock board, one line's
 * details and its stock log - READ ONLY. Every write stays on the existing
 * stock endpoints (movements, confirm-count, safety-stock).
 *
 * A line = one colour x size (offer variant) of the store, with this
 * branch's stock row (or none yet = 0) - the same set the old paginated
 * list showed. available = quantity - reserved (checkout holds).
 *   out of stock: available <= 0
 *   low:          available > 0 and at or below the owner's threshold, or
 *                 1-3 while no threshold is set (the alert's own rule)
 *   not counted lately: there is stock and no physical count in 7 days
 */
const STALE_DAYS = 7;
export const BOARD_FILTERS = ['all', 'low', 'out', 'stale'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

const AVAILABLE = Prisma.sql`(COALESCE(bs.quantity, 0) - COALESCE(bs."reservedQuantity", 0))`;
const THRESHOLD = Prisma.sql`COALESCE(bs."safetyStockThreshold", 0)`;
const IS_OUT = Prisma.sql`(${AVAILABLE} <= 0)`;
const IS_LOW = Prisma.sql`(${AVAILABLE} > 0 AND ((${THRESHOLD} > 0 AND ${AVAILABLE} <= ${THRESHOLD}) OR (${THRESHOLD} = 0 AND ${AVAILABLE} <= 3)))`;
const IS_STALE = Prisma.sql`(COALESCE(bs.quantity, 0) > 0 AND (bs."lastPhysicalCountAt" IS NULL OR bs."lastPhysicalCountAt" < now() - make_interval(days => ${STALE_DAYS})))`;

interface BoardSqlRow {
  variant_id: string;
  quantity: number;
  reserved: number;
  threshold: number;
  counted_at: Date | null;
}

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class StockBoardService {
  constructor(private readonly prisma: PrismaService) {}

  private searchSql(raw: string | undefined): Prisma.Sql | null {
    const q = (raw ?? '').trim();
    if (!q) return null;
    if (q.length > 60) {
      throw new BadRequestException({
        code: 'INVALID_SEARCH',
        message: 'The search is too long',
      });
    }
    const like = `%${likeEscape(q.toLowerCase())}%`;
    return Prisma.sql`(
      lower(vo."titleAr") LIKE ${like} OR lower(vo."titleEn") LIKE ${like}
      OR lower(ov."sellerSku") LIKE ${like}
      OR ov."storeInventoryBarcode" = ${q}
      OR EXISTS (SELECT 1 FROM offer_barcodes ob WHERE ob."vendorOfferId" = vo.id AND ob."vendorId" = vo."vendorId" AND ob.code = ${q})
    )`;
  }

  private base(vendorId: string, branchId: string, where: Prisma.Sql[]) {
    return Prisma.sql`
      FROM offer_variants ov
      JOIN vendor_offers vo ON vo.id = ov."vendorOfferId"
      LEFT JOIN branch_stock bs ON bs."offerVariantId" = ov.id AND bs."branchId" = ${branchId}
      WHERE ${Prisma.join([Prisma.sql`ov."vendorId" = ${vendorId}`, ...where], ' AND ')}`;
  }

  async board(
    vendorId: string,
    branchId: string,
    query: {
      q?: string;
      filter?: BoardFilter;
      cursor?: string;
      limit?: string;
      variant?: string;
    },
  ) {
    const filter: BoardFilter = query.filter ?? 'all';
    const limit = parseLimit(query.limit, 50);
    const offset = query.cursor ? Number(query.cursor) : 0;
    const where: Prisma.Sql[] = [];
    const search = this.searchSql(query.q);
    if (search) where.push(search);
    if (filter === 'low') where.push(IS_LOW);
    if (filter === 'out') where.push(IS_OUT);
    if (filter === 'stale') where.push(IS_STALE);

    const rows = await this.prisma.$queryRaw<BoardSqlRow[]>`
      SELECT ov.id AS variant_id, COALESCE(bs.quantity, 0)::int AS quantity,
        COALESCE(bs."reservedQuantity", 0)::int AS reserved, ${THRESHOLD}::int AS threshold,
        bs."lastPhysicalCountAt" AS counted_at
      ${this.base(vendorId, branchId, where)}
      ORDER BY vo."titleAr" ASC, vo.id ASC, ov."createdAt" ASC, ov.id ASC
      LIMIT ${limit + 1} OFFSET ${offset}`;
    // the summary: the whole branch, whatever the search or filter
    const [sum] = await this.prisma.$queryRaw<
      {
        pieces: number;
        lines: number;
        low: number;
        out: number;
        stale: number;
      }[]
    >`
      SELECT COALESCE(sum(COALESCE(bs.quantity, 0)), 0)::int AS pieces, count(*)::int AS lines,
        (count(*) FILTER (WHERE ${IS_LOW}))::int AS low,
        (count(*) FILTER (WHERE ${IS_OUT}))::int AS out,
        (count(*) FILTER (WHERE ${IS_STALE}))::int AS stale
      ${this.base(vendorId, branchId, [])}`;

    let pinned: BoardSqlRow | null = null;
    if (query.variant) {
      if (!isUuidLike(query.variant)) {
        throw new BadRequestException({
          code: 'INVALID_VARIANT',
          message: 'variant must be an id',
        });
      }
      const found = await this.prisma.$queryRaw<BoardSqlRow[]>`
        SELECT ov.id AS variant_id, COALESCE(bs.quantity, 0)::int AS quantity,
          COALESCE(bs."reservedQuantity", 0)::int AS reserved, ${THRESHOLD}::int AS threshold,
          bs."lastPhysicalCountAt" AS counted_at
        ${this.base(vendorId, branchId, [Prisma.sql`ov.id = ${query.variant}`])}`;
      pinned = found[0] ?? null;
    }

    const page = rows.slice(0, limit);
    const views = await this.views(vendorId, [
      ...page,
      ...(pinned ? [pinned] : []),
    ]);
    return {
      summary: {
        total_pieces: sum.pieces,
        lines: sum.lines,
        low: sum.low,
        out: sum.out,
        stale: sum.stale,
      },
      items: page.map((r) => views.get(r.variant_id)!),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
      filter,
      // a link from a low-stock notice: that line, wherever it sits in the
      // list (null when it is not this store's)
      pinned: pinned ? views.get(pinned.variant_id)! : null,
    };
  }

  /** Display rows: names, colour, size, image, the numbers and the flags. */
  private async views(vendorId: string, rows: BoardSqlRow[]) {
    const ids = [...new Set(rows.map((r) => r.variant_id))];
    const variants = await this.prisma.offerVariant.findMany({
      where: { vendorId, id: { in: ids } },
      select: {
        id: true,
        vendorOfferId: true,
        sellerSku: true,
        storeInventoryBarcode: true,
        colour: true,
        size: true,
        vendorOffer: { select: { titleAr: true, titleEn: true } },
        offerColor: {
          select: {
            nameAr: true,
            nameEn: true,
            hex: true,
            family: { select: { hex: true } },
          },
        },
        sizeOption: { select: { label: true } },
      },
    });
    const offerIds = [...new Set(variants.map((v) => v.vendorOfferId))];
    const media = await this.prisma.offerVariantMedia.findMany({
      where: {
        vendorId,
        kind: 'PRIMARY',
        mediaType: 'IMAGE',
        offerVariant: { vendorOfferId: { in: offerIds } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        url: true,
        offerVariantId: true,
        offerVariant: { select: { vendorOfferId: true } },
      },
    });
    const byVariant = new Map<string, string>();
    const byOffer = new Map<string, string>();
    for (const m of media) {
      if (!byVariant.has(m.offerVariantId))
        byVariant.set(m.offerVariantId, m.url);
      if (!byOffer.has(m.offerVariant.vendorOfferId))
        byOffer.set(m.offerVariant.vendorOfferId, m.url);
    }
    const vBy = new Map(variants.map((v) => [v.id, v]));
    const out = new Map<string, ReturnType<typeof lineView>>();
    for (const r of rows) {
      const v = vBy.get(r.variant_id);
      if (!v) continue;
      out.set(
        r.variant_id,
        lineView(
          r,
          v,
          byVariant.get(v.id) ?? byOffer.get(v.vendorOfferId) ?? null,
        ),
      );
    }
    return out;
  }

  /** One line: the board's row plus what open orders hold of it. */
  async detail(vendorId: string, branchId: string, offerVariantId: string) {
    const found = await this.prisma.$queryRaw<BoardSqlRow[]>`
      SELECT ov.id AS variant_id, COALESCE(bs.quantity, 0)::int AS quantity,
        COALESCE(bs."reservedQuantity", 0)::int AS reserved, ${THRESHOLD}::int AS threshold,
        bs."lastPhysicalCountAt" AS counted_at
      ${this.base(vendorId, branchId, [Prisma.sql`ov.id = ${offerVariantId}`])}`;
    const views = await this.views(vendorId, found);
    // read only: units of this line in this branch's orders not yet handed
    // over (new / preparing) - already taken from the quantity at checkout;
    // nothing about holds or orders changes
    const [prep] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT COALESCE(sum(boi.quantity), 0)::int AS n
      FROM branch_order_items boi
      JOIN branch_orders bo ON bo.id = boi."branchOrderId"
      WHERE bo."vendorId" = ${vendorId} AND bo."branchId" = ${branchId}
        AND boi."offerVariantId" = ${offerVariantId}
        AND bo.status IN ('PLACED', 'PREPARING') AND boi."cancelledAt" IS NULL`;
    return { ...views.get(offerVariantId)!, in_open_orders: prep.n };
  }

  /** The line's stock log, newest first (keyset pages). */
  async ledger(
    vendorId: string,
    branchId: string,
    offerVariantId: string,
    query: { cursor?: string; limit?: string },
  ) {
    const limit = parseLimit(query.limit, 50);
    const cursor = decodeCursor(query.cursor, [isIsoDateString, isUuidLike]);
    const where: Prisma.StockMovementWhereInput = {
      vendorId,
      branchId,
      offerVariantId,
    };
    if (cursor) {
      const [at, id] = cursor as [string, string];
      where.OR = [
        { createdAt: { lt: new Date(at) } },
        { createdAt: new Date(at), id: { lt: id } },
      ];
    }
    const rows = await this.prisma.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        quantityDelta: true,
        resultingQuantity: true,
        reason: true,
        reasonNote: true,
        actorId: true,
        actorRole: true,
        branchOrderId: true,
        returnId: true,
        actor: {
          select: { customerProfile: { select: { displayName: true } } },
        },
        storeSaleItemSold: {
          select: { storeSale: { select: { saleNumber: true } } },
        },
        storeSaleItemVoided: {
          select: { storeSale: { select: { saleNumber: true } } },
        },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((m) => {
        const role = m.actorRole;
        // a shopper is «العميلة», never her name; the system has no actor
        const actor =
          !m.actorId || role === 'SYSTEM'
            ? { kind: 'system' as const }
            : role === 'CUSTOMER'
              ? { kind: 'customer' as const }
              : {
                  kind: 'person' as const,
                  name: m.actor?.customerProfile?.displayName ?? null,
                  // the role at that moment - only when it was recorded
                  role: role ?? null,
                };
        const sale =
          m.storeSaleItemSold?.storeSale ?? m.storeSaleItemVoided?.storeSale;
        const reference = m.branchOrderId
          ? {
              kind: 'order' as const,
              id: m.branchOrderId,
              number: m.branchOrderId.slice(0, 8),
            }
          : sale
            ? {
                kind: 'store_sale' as const,
                number: saleNumberLabel(sale.saleNumber),
              }
            : m.returnId
              ? {
                  kind: 'return' as const,
                  id: m.returnId,
                  number: m.returnId.slice(0, 8),
                }
              : null;
        return {
          id: m.id,
          at: m.createdAt.toISOString(),
          delta: m.quantityDelta,
          resulting_quantity: m.resultingQuantity,
          reason: m.reason,
          note: m.reasonNote,
          actor,
          reference,
        };
      }),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }
}

function lineView(
  r: BoardSqlRow,
  v: {
    id: string;
    vendorOfferId: string;
    sellerSku: string;
    storeInventoryBarcode: string;
    colour: string | null;
    size: string | null;
    vendorOffer: { titleAr: string; titleEn: string };
    offerColor: {
      nameAr: string;
      nameEn: string | null;
      hex: string | null;
      family: { hex: string | null };
    } | null;
    sizeOption: { label: string } | null;
  },
  imageUrl: string | null,
) {
  const available = r.quantity - r.reserved;
  const counted = r.counted_at ? new Date(r.counted_at) : null;
  return {
    offer_variant_id: v.id,
    offer_id: v.vendorOfferId,
    title_ar: v.vendorOffer.titleAr,
    title_en: v.vendorOffer.titleEn,
    color_name_ar: v.offerColor?.nameAr ?? v.colour ?? null,
    color_name_en: v.offerColor?.nameEn ?? null,
    color_hex: v.offerColor
      ? (v.offerColor.hex ?? v.offerColor.family.hex)
      : null,
    size_label: v.sizeOption?.label ?? v.size ?? null,
    sku: v.sellerSku,
    store_barcode: v.storeInventoryBarcode,
    image_url: imageUrl,
    quantity: r.quantity,
    reserved_quantity: r.reserved,
    available_quantity: available,
    safety_stock_threshold: r.threshold,
    last_physical_count_at: counted?.toISOString() ?? null,
    is_out: available <= 0,
    is_low: isLowNow(available, r.threshold),
    is_stale:
      r.quantity > 0 &&
      (counted === null ||
        counted.getTime() < Date.now() - STALE_DAYS * 24 * 3600_000),
  };
}
