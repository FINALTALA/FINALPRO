import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import {
  generatedProductBarcode,
  MAX_GENERATED_BARCODE_SEQ,
  normalizeBarcode,
  printableBarcode,
  type ProductBarcodeFormat,
} from '../common/barcode.util';
import { computeEffectivePrice } from '../offers/pricing/effective-price.util';
import { PrismaService } from '../prisma/prisma.service';

/** At most this many codes per product (one of them the primary). */
export const MAX_BARCODES_PER_OFFER = 10;
/** Label data for at most this many products per request. */
export const MAX_LABEL_OFFERS = 60;

interface Actor {
  userId: string;
  correlationId: string;
}

type BarcodeRow = {
  id: string;
  code: string;
  format: ProductBarcodeFormat;
  source: 'EXTERNAL' | 'GENERATED';
  isPrimary: boolean;
  createdAt: Date;
};

export function barcodeDto(row: BarcodeRow) {
  return {
    id: row.id,
    code: row.code,
    /** What a label shows (a UPC-A without its stored leading "0"). */
    display_code: printableBarcode(row.code, row.format),
    format: row.format,
    source: row.source,
    is_primary: row.isPrimary,
    created_at: row.createdAt.toISOString(),
  };
}

/** A barcode problem from barcode.util, as the 400 the screens translate. */
export function barcodeProblem(problem: string): BadRequestException {
  return new BadRequestException({
    code: problem,
    message:
      problem === 'BARCODE_CHECK_DIGIT'
        ? 'The check digit of this barcode is wrong - scan or type it again'
        : problem === 'BARCODE_RESERVED'
          ? 'This is an internal platform code, not a product barcode'
          : 'This is not a valid barcode (digits, A-Z and "-", 4-32 characters)',
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * A product's barcodes (owner only): attach a code already on the item,
 * generate an in-store one, choose the primary, remove. Operational and
 * immediate - never through an edit draft, never a content revision (the
 * revision triggers watch named columns of vendor_offers only) - each change
 * audited. Every write locks the product row first, so the 10-code limit and
 * "exactly one primary while any exist" hold under concurrency; the
 * (vendorId, code) unique index is what finally stops a duplicate.
 */
@Injectable()
export class OfferBarcodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async requireOffer(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    offerId: string,
  ) {
    const offer = await db.vendorOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        vendorId: true,
        status: true,
        archivedAt: true,
        titleAr: true,
      },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Product not found for this store',
      });
    }
    return offer;
  }

  /** Locks the product row (barcode writes of one product run one at a time). */
  private async lockWritableOffer(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
  ) {
    const offer = await this.requireOffer(tx, vendorId, offerId);
    await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} AND "vendorId" = ${vendorId} FOR NO KEY UPDATE`;
    if (offer.status === 'ARCHIVED' || offer.archivedAt) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'This product is archived',
      });
    }
    return offer;
  }

  private rows(db: Prisma.TransactionClient | PrismaService, offerId: string) {
    return db.offerBarcode.findMany({
      where: { vendorOfferId: offerId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async list(vendorId: string, offerId: string) {
    await this.requireOffer(this.prisma, vendorId, offerId);
    return {
      items: (await this.rows(this.prisma, offerId)).map(barcodeDto),
      limit: MAX_BARCODES_PER_OFFER,
    };
  }

  /** Which product of this store already carries this (normalized) code, if any. */
  async usedBy(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    code: string,
  ): Promise<{ offerId: string; titleAr: string; titleEn: string } | null> {
    const existing = await db.offerBarcode.findUnique({
      where: { vendorId_code: { vendorId, code } },
      select: {
        vendorOfferId: true,
        vendorOffer: { select: { titleAr: true, titleEn: true } },
      },
    });
    return existing
      ? {
          offerId: existing.vendorOfferId,
          titleAr: existing.vendorOffer.titleAr,
          titleEn: existing.vendorOffer.titleEn,
        }
      : null;
  }

  /** The 409 for a code this store already uses (on this product or another one of its own). */
  private async alreadyUsed(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
    code: string,
  ) {
    const existing = await tx.offerBarcode.findUnique({
      where: { vendorId_code: { vendorId, code } },
      select: {
        vendorOfferId: true,
        vendorOffer: { select: { titleAr: true, titleEn: true } },
      },
    });
    if (!existing) return null;
    return new ConflictException({
      code:
        existing.vendorOfferId === offerId
          ? 'BARCODE_ALREADY_ON_PRODUCT'
          : 'BARCODE_ALREADY_USED',
      message: 'This barcode is already used in this store',
      details: [
        {
          offer_id: existing.vendorOfferId,
          title_ar: existing.vendorOffer.titleAr,
          title_en: existing.vendorOffer.titleEn,
        },
      ],
    });
  }

  private async insert(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
    data: {
      code: string;
      format: ProductBarcodeFormat;
      source: 'EXTERNAL' | 'GENERATED';
    },
    actor: Actor,
  ) {
    const count = await tx.offerBarcode.count({
      where: { vendorOfferId: offerId },
    });
    if (count >= MAX_BARCODES_PER_OFFER) {
      throw new ConflictException({
        code: 'BARCODE_LIMIT',
        message: `A product has at most ${MAX_BARCODES_PER_OFFER} barcodes`,
      });
    }
    const row = await tx.offerBarcode.create({
      data: {
        vendorId,
        vendorOfferId: offerId,
        code: data.code,
        format: data.format,
        source: data.source,
        isPrimary: count === 0,
        createdById: actor.userId,
      },
    });
    await this.auditLog.record(
      {
        actorId: actor.userId,
        correlationId: actor.correlationId,
        action: 'offer_barcode.added',
        entityType: 'OfferBarcode',
        entityId: row.id,
        afterState: { offer_id: offerId, ...barcodeDto(row) },
      },
      tx,
    );
    return row;
  }

  /** Attach a code already on the item (scanned or typed). */
  async addExternal(
    vendorId: string,
    offerId: string,
    rawCode: string,
    actor: Actor,
  ) {
    const normalized = normalizeBarcode(rawCode);
    if (!normalized.ok) throw barcodeProblem(normalized.problem);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockWritableOffer(tx, vendorId, offerId);
        const used = await this.alreadyUsed(
          tx,
          vendorId,
          offerId,
          normalized.code,
        );
        if (used) throw used;
        await this.insert(
          tx,
          vendorId,
          offerId,
          {
            code: normalized.code,
            format: normalized.format,
            source: 'EXTERNAL',
          },
          actor,
        );
        return {
          items: (await this.rows(tx, offerId)).map(barcodeDto),
          limit: MAX_BARCODES_PER_OFFER,
        };
      });
    } catch (err) {
      // a concurrent attach of the same code to another product won the unique index
      if (isUniqueViolation(err)) {
        const used = await this.prisma.$transaction((tx) =>
          this.alreadyUsed(tx, vendorId, offerId, normalized.code),
        );
        throw (
          used ??
          new ConflictException({
            code: 'BARCODE_ALREADY_USED',
            message: 'This barcode is already used in this store',
          })
        );
      }
      throw err;
    }
  }

  /**
   * An in-store EAN-13 from the store's own counter ("29..." - the GS1
   * restricted-circulation range, never a registered GTIN). A number the
   * store already uses as an external code is skipped.
   */
  async generate(vendorId: string, offerId: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWritableOffer(tx, vendorId, offerId);
      await this.generateInTx(tx, vendorId, offerId, actor);
      return {
        items: (await this.rows(tx, offerId)).map(barcodeDto),
        limit: MAX_BARCODES_PER_OFFER,
      };
    });
  }

  /**
   * One generated code for a product, inside the caller's transaction (the
   * caller holds the product - e.g. the wizard's publish, which has just
   * created it).
   */
  async generateInTx(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
    actor: Actor,
  ) {
    {
      for (let attempt = 0; attempt < 25; attempt++) {
        const [counter] = await tx.$queryRaw<{ seq: bigint }[]>`
          INSERT INTO vendor_code_counters ("vendorId", "lastBarcodeSeq") VALUES (${vendorId}, 1)
          ON CONFLICT ("vendorId") DO UPDATE SET "lastBarcodeSeq" = vendor_code_counters."lastBarcodeSeq" + 1
          RETURNING "lastBarcodeSeq" AS seq`;
        if (counter.seq > BigInt(MAX_GENERATED_BARCODE_SEQ)) break;
        const code = generatedProductBarcode(counter.seq);
        const taken = await tx.offerBarcode.findUnique({
          where: { vendorId_code: { vendorId, code } },
          select: { id: true },
        });
        if (taken) continue;
        return this.insert(
          tx,
          vendorId,
          offerId,
          { code, format: 'EAN13', source: 'GENERATED' },
          actor,
        );
      }
      throw new ConflictException({
        code: 'BARCODE_GENERATION_FAILED',
        message: 'Could not generate a free barcode - try again',
      });
    }
  }

  /** A checked, normalized code for a product (typed, or reserved for its draft), inside the caller's transaction. */
  async attachInTx(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
    code: {
      code: string;
      format: ProductBarcodeFormat;
      source: 'EXTERNAL' | 'GENERATED';
    },
    actor: Actor,
  ) {
    return this.insert(tx, vendorId, offerId, code, actor);
  }

  /**
   * The wizard's «إنشاء باركود من النظام»: the store's next free in-store
   * code, taken from its counter now (so the owner sees it and can print it
   * before publishing). Nothing is attached - the draft keeps the code and
   * publishing attaches it (checked again then). A code reserved and never
   * published is simply never used: the counter only moves forward.
   */
  async reserve(vendorId: string, actor: Actor) {
    return this.prisma.$transaction((tx) =>
      this.reserveInTx(tx, vendorId, actor),
    );
  }

  /** One free in-store code, inside the caller's transaction (bulk generation for imported drafts). */
  async reserveInTx(
    tx: Prisma.TransactionClient,
    vendorId: string,
    actor: Actor,
  ) {
    {
      for (let attempt = 0; attempt < 25; attempt++) {
        const [counter] = await tx.$queryRaw<{ seq: bigint }[]>`
          INSERT INTO vendor_code_counters ("vendorId", "lastBarcodeSeq") VALUES (${vendorId}, 1)
          ON CONFLICT ("vendorId") DO UPDATE SET "lastBarcodeSeq" = vendor_code_counters."lastBarcodeSeq" + 1
          RETURNING "lastBarcodeSeq" AS seq`;
        if (counter.seq > BigInt(MAX_GENERATED_BARCODE_SEQ)) break;
        const code = generatedProductBarcode(counter.seq);
        if (await this.usedBy(tx, vendorId, code)) continue;
        await this.auditLog.record(
          {
            actorId: actor.userId,
            correlationId: actor.correlationId,
            action: 'offer_barcode.reserved',
            entityType: 'Vendor',
            entityId: vendorId,
            afterState: { code },
          },
          tx,
        );
        return { code, display_code: code, format: 'EAN13' as const };
      }
      throw new ConflictException({
        code: 'BARCODE_GENERATION_FAILED',
        message: 'Could not generate a free barcode - try again',
      });
    }
  }

  /** Does this product have a store barcode? (a cashier sale and a publish need one) */
  async hasAny(db: Prisma.TransactionClient | PrismaService, offerId: string) {
    return (
      (await db.offerBarcode.count({ where: { vendorOfferId: offerId } })) > 0
    );
  }

  private async requireBarcode(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerId: string,
    barcodeId: string,
  ) {
    const row = await tx.offerBarcode.findUnique({ where: { id: barcodeId } });
    if (!row || row.vendorId !== vendorId || row.vendorOfferId !== offerId) {
      throw new NotFoundException({
        code: 'BARCODE_NOT_FOUND',
        message: 'Barcode not found on this product',
      });
    }
    return row;
  }

  async setPrimary(
    vendorId: string,
    offerId: string,
    barcodeId: string,
    actor: Actor,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWritableOffer(tx, vendorId, offerId);
      const row = await this.requireBarcode(tx, vendorId, offerId, barcodeId);
      if (!row.isPrimary) {
        const before = await tx.offerBarcode.findFirst({
          where: { vendorOfferId: offerId, isPrimary: true },
          select: { id: true },
        });
        await tx.offerBarcode.updateMany({
          where: { vendorOfferId: offerId, isPrimary: true },
          data: { isPrimary: false },
        });
        await tx.offerBarcode.update({
          where: { id: row.id },
          data: { isPrimary: true },
        });
        await this.auditLog.record(
          {
            actorId: actor.userId,
            correlationId: actor.correlationId,
            action: 'offer_barcode.primary_set',
            entityType: 'OfferBarcode',
            entityId: row.id,
            beforeState: {
              offer_id: offerId,
              primary_barcode_id: before?.id ?? null,
            },
            afterState: {
              offer_id: offerId,
              primary_barcode_id: row.id,
              code: row.code,
            },
          },
          tx,
        );
      }
      return {
        items: (await this.rows(tx, offerId)).map(barcodeDto),
        limit: MAX_BARCODES_PER_OFFER,
      };
    });
  }

  /** Removes one code; when it was the primary, the oldest remaining one becomes primary. Past sales keep the code they were scanned with (plain text). */
  async remove(
    vendorId: string,
    offerId: string,
    barcodeId: string,
    actor: Actor,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWritableOffer(tx, vendorId, offerId);
      const row = await this.requireBarcode(tx, vendorId, offerId, barcodeId);
      await tx.offerBarcode.delete({ where: { id: row.id } });
      if (row.isPrimary) {
        const next = await tx.offerBarcode.findFirst({
          where: { vendorOfferId: offerId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next)
          await tx.offerBarcode.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
      }
      await this.auditLog.record(
        {
          actorId: actor.userId,
          correlationId: actor.correlationId,
          action: 'offer_barcode.removed',
          entityType: 'OfferBarcode',
          entityId: row.id,
          beforeState: { offer_id: offerId, ...barcodeDto(row) },
        },
        tx,
      );
      return {
        items: (await this.rows(tx, offerId)).map(barcodeDto),
        limit: MAX_BARCODES_PER_OFFER,
      };
    });
  }

  /**
   * What the label page prints for each product: the store's name, the
   * product's name, its PRIMARY code (null = none yet) and its current price
   * (shown only when the owner ticks «إظهار السعر»). Archived products and
   * other stores' ids are left out.
   */
  async labels(vendorId: string, offerIds: string[], codes: string[] = []) {
    // codes (from the device's print list): the products that carry them now
    if (codes.length) {
      const rows = await this.prisma.offerBarcode.findMany({
        where: { vendorId, code: { in: [...new Set(codes)].slice(0, 200) } },
        select: { vendorOfferId: true },
      });
      offerIds = [...offerIds, ...rows.map((r) => r.vendorOfferId)];
    }
    const ids = [...new Set(offerIds)].slice(0, MAX_LABEL_OFFERS);
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { displayName: true, legalName: true },
    });
    const offers = await this.prisma.vendorOffer.findMany({
      where: {
        vendorId,
        id: { in: ids },
        archivedAt: null,
        status: { not: 'ARCHIVED' },
      },
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        barcodes: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
        variants: {
          select: {
            basePrice: true,
            salePrice: true,
            discountPercent: true,
            discountStartAt: true,
            discountEndAt: true,
          },
        },
      },
    });
    const byId = new Map(offers.map((o) => [o.id, o]));
    const now = new Date();
    return {
      store_name: vendor?.displayName || vendor?.legalName || '',
      items: ids
        .map((id) => byId.get(id))
        .filter((o): o is NonNullable<typeof o> => Boolean(o))
        .map((o) => {
          const prices = o.variants.map((v) => computeEffectivePrice(v, now));
          const primary = o.barcodes.find((b) => b.isPrimary) ?? null;
          return {
            offer_id: o.id,
            title_ar: o.titleAr,
            title_en: o.titleEn,
            barcode: primary ? barcodeDto(primary) : null,
            /** every code of the product (primary first) - the print screen may pick any */
            barcodes: o.barcodes.map(barcodeDto),
            price: prices.length ? Math.min(...prices) : null,
          };
        }),
    };
  }
}
