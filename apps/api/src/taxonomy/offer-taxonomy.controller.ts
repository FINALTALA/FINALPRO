import { ContentViaEditDraft } from '../offers/content-via-edit-draft.guard';
import { applyOfferPrice } from '../offers/pricing/apply-offer-price';
import { MAX_PRODUCT_COLORS } from '../offers/color-name';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { Prisma, ProductAudience } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { lockOffersWideForRestock } from '../checkout/stock-lock.util';
import { bucketForStock } from '../common/availability.util';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { MatchingService } from '../matching/matching.service';
import { computeEffectivePrice } from '../offers/pricing/effective-price.util';
import {
  priceKey,
  resolveUnifiedPrice,
  UnifiedPrice,
} from '../offers/pricing/unified-price.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCombinationsDto,
  SetClassificationDto,
  SetOfferPriceDto,
} from './dto/offer-taxonomy.dto';
import { TAXONOMY_VERSION, TaxonomyService } from './taxonomy.service';

type Tx = Prisma.TransactionClient;

// Sprint 27 (product taxonomy): the owner's classification, ONE unified
// price, and colour/size combinations for an offer. Owner-only (PDR-009:
// catalogue and prices are the owner's; a branch employee keeps only the
// existing per-branch stock movements) - @RequireVendorRole sits on each
// handler because VendorMembershipGuard reads it from the handler only (a
// class-level one is silently ignored). Every route is scoped to the
// :vendorId the membership guard already proved - an offer of another
// store reads as 404, never as someone else's data (BOLA).
@Controller('vendors/:vendorId/offers/:offerId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OfferTaxonomyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
    private readonly matching: MatchingService,
  ) {}

  /** Locks the offer row and proves it belongs to this vendor. */
  private async lockOffer(tx: Tx, vendorId: string, offerId: string) {
    await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
    const offer = await tx.vendorOffer.findUnique({
      where: { id: offerId },
      include: {
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
      },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found for this store',
      });
    }
    return offer;
  }

  private classificationDto(offer: {
    taxonomyVersion: number | null;
    season: string | null;
    requiresTaxonomy: boolean;
    audiences: { audience: ProductAudience }[];
    categories: { categoryCode: string }[];
  }) {
    return {
      classified: offer.taxonomyVersion !== null,
      taxonomy_version: offer.taxonomyVersion,
      requires_taxonomy: offer.requiresTaxonomy,
      audiences: offer.audiences.map((a) => a.audience),
      categories: offer.categories.map((c) => c.categoryCode),
      season: offer.season,
    };
  }

  @Get('classification')
  @RequireVendorRole('OWNER')
  async getClassification(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      include: {
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
      },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found for this store',
      });
    }
    return this.classificationDto(offer);
  }

  /**
   * Sets audiences (>= 1), categories (>= 1, each belonging to a chosen
   * audience) and at most one season. A legacy offer is classified only
   * once its existing variants already share one price (owner-approved
   * decision #3) - never by guessing which price is "right".
   */
  @BlockWhenSuspended()
  @ContentViaEditDraft()
  @Put('classification')
  @RequireVendorRole('OWNER')
  async setClassification(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() dto: SetClassificationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { audiences, categories } =
      await this.taxonomy.validateClassification(dto);
    const season = dto.season ?? null;

    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockOffer(tx, vendorId, offerId);
      const variants = await tx.offerVariant.findMany({
        where: { vendorOfferId: offerId },
        select: {
          sizeCode: true,
          basePrice: true,
          salePrice: true,
          discountPercent: true,
          discountStartAt: true,
          discountEndAt: true,
        },
      });

      if (before.taxonomyVersion === null) {
        const prices = new Set(variants.map(priceKey));
        if (prices.size > 1) {
          throw new ConflictException({
            code: 'PRICES_NOT_UNIFIED',
            message:
              "This product's variants have different prices - set one price for the whole product first (PUT .../price)",
          });
        }
      }
      if (!audiences.includes('KIDS')) {
        for (const v of variants) {
          if (await this.taxonomy.isKidsAgeSize(v.sizeCode)) {
            throw new ConflictException({
              code: 'KIDS_SIZES_IN_USE',
              message:
                'KIDS cannot be removed while combinations use age sizes - set their stock to 0 and keep KIDS, or keep the audience',
            });
          }
        }
      }

      await tx.vendorOfferAudience.deleteMany({
        where: { vendorOfferId: offerId },
      });
      await tx.vendorOfferCategory.deleteMany({
        where: { vendorOfferId: offerId },
      });
      await tx.vendorOfferAudience.createMany({
        data: audiences.map((audience) => ({
          vendorOfferId: offerId,
          vendorId,
          audience,
        })),
      });
      await tx.vendorOfferCategory.createMany({
        data: categories.map((categoryCode) => ({
          vendorOfferId: offerId,
          vendorId,
          categoryCode,
        })),
      });
      const updated = await tx.vendorOffer.update({
        where: { id: offerId },
        data: { season, taxonomyVersion: TAXONOMY_VERSION },
        include: {
          audiences: { select: { audience: true } },
          categories: { select: { categoryCode: true } },
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.classification_changed',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: this.classificationDto(before),
          afterState: this.classificationDto(updated),
        },
        tx,
      );
      return this.classificationDto(updated);
    });
  }

  /**
   * The ONE price of the whole product: every variant is rewritten in
   * this transaction (rows locked in id order), each gets its own
   * PriceHistory row, and an immediate drop notifies followers and
   * favourites exactly like the per-variant path does. Works on a legacy
   * offer too - it is how its owner unifies prices before classifying.
   */
  @BlockWhenSuspended()
  @Put('price')
  @RequireVendorRole('OWNER')
  async setPrice(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() dto: SetOfferPriceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const price = resolveUnifiedPrice(dto);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOffer(tx, vendorId, offerId);
      // the one price path (shared with applying an edit draft)
      return applyOfferPrice(
        tx,
        { outbox: this.outbox, auditLog: this.auditLog },
        {
          vendorId,
          offerId,
          price,
          userId: user.id,
          correlationId: req.correlationId,
        },
      );
    });
  }

  /**
   * Every combination of the offer for its owner - including sold-out
   * ones (quantity 0 everywhere), which stay listed so they can be
   * refilled through the normal stock movement path.
   */
  @Get('combinations')
  @RequireVendorRole('OWNER')
  async listCombinations(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found for this store',
      });
    }
    const variants = await this.prisma.offerVariant.findMany({
      where: { vendorOfferId: offerId },
      orderBy: { createdAt: 'asc' },
      include: {
        branchStocks: {
          select: { branchId: true, quantity: true, reservedQuantity: true },
        },
      },
    });
    return {
      classified: offer.taxonomyVersion !== null,
      items: variants.map((v) => {
        const total = v.branchStocks.reduce((n, s) => n + s.quantity, 0);
        return {
          variant_id: v.id,
          is_combination: v.isCombination,
          color_code: v.colorCode,
          size_code: v.sizeCode,
          colour: v.colour,
          size: v.size,
          seller_sku: v.sellerSku,
          store_inventory_barcode: v.storeInventoryBarcode,
          identifier_type: v.identifierType,
          identifier_value: v.identifierValue,
          condition: v.condition,
          match_proposal_status: v.matchProposalStatus,
          proposed_canonical_variant_id: v.proposedCanonicalVariantId,
          canonical_variant_id: v.canonicalVariantId,
          base_price: Number(v.basePrice).toFixed(2),
          sale_price:
            v.salePrice === null ? null : Number(v.salePrice).toFixed(2),
          total_quantity: total,
          status: total > 0 ? 'available' : 'sold_out',
          availability: bucketForStock(total),
          stock: v.branchStocks.map((s) => ({
            branch_id: s.branchId,
            quantity: s.quantity,
            reserved: s.reservedQuantity,
          })),
        };
      }),
    };
  }

  /**
   * Creates the combinations the store actually has - never the full
   * colour x size cartesian product. Each is an ordinary OfferVariant
   * (isCombination = true) at the offer's unified price, and its opening
   * stock goes through the shared restock primitive the stock-movement
   * endpoint uses (lockOffersWideForRestock), recorded as INITIAL_STOCK
   * with no PDR-021 owner alert.
   */
  @BlockWhenSuspended()
  @ContentViaEditDraft()
  @Post('combinations')
  @RequireVendorRole('OWNER')
  @HttpCode(201)
  async createCombinations(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() dto: CreateCombinationsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const items = dto.items.map((i) => ({
      colorCode: i.color_code ?? null,
      offerColorId: (i.offer_color_id ?? null) as string | null,
      sizeCode: i.size_code ?? null,
      stock: i.stock,
      src: i,
    }));
    const seen = new Set<string>();
    for (const i of items) {
      // Same pair rule as PUT .../variants/:variantId - a half
      // identifier can never be matched, so it is refused up front.
      if (!i.src.identifier_type !== !i.src.identifier_value) {
        throw new BadRequestException({
          code: 'INCOMPLETE_IDENTIFIER_PAIR',
          message:
            'identifier_type and identifier_value must both be set, or both omitted',
        });
      }
      const key = `${i.offerColorId ?? i.colorCode ?? ''}|${i.sizeCode ?? ''}`;
      if (seen.has(key)) {
        throw new ConflictException({
          code: 'DUPLICATE_COMBINATION',
          message: `The same colour/size combination is listed twice (${key})`,
        });
      }
      seen.add(key);
      const branches = new Set(i.stock.map((s) => s.branch_id));
      if (branches.size !== i.stock.length) {
        throw new ConflictException({
          code: 'DUPLICATE_BRANCH',
          message: "A branch appears twice in one combination's stock",
        });
      }
    }
    const t = await this.taxonomy.get();

    // The legacy createVariant path's exact-match proposal, unchanged:
    // looked up before the transaction, stored as a PENDING proposal the
    // owner confirms or rejects through the existing
    // .../variants/:variantId/match-confirmation endpoint.
    const proposals = await Promise.all(
      items.map(async (i) =>
        i.src.identifier_type && i.src.identifier_value
          ? (
              await this.matching.findExactMatch(
                i.src.identifier_type,
                i.src.identifier_value,
              )
            ).canonicalVariantId
          : null,
      ),
    );

    type CreatedRow = {
      id: string;
      colorCode: string | null;
      sizeCode: string | null;
      sellerSku: string;
      storeInventoryBarcode: string | null;
      proposedCanonicalVariantId: string | null;
      matchProposalStatus: string;
    };
    let created: CreatedRow[];
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const offer = await this.lockOffer(tx, vendorId, offerId);
        if (offer.taxonomyVersion === null) {
          throw new ConflictException({
            code: 'OFFER_NOT_CLASSIFIED',
            message:
              'Classify this product (audience and category) before adding combinations',
          });
        }
        const audiences = offer.audiences.map((a) => a.audience);
        // Product colours: each item's product colour - named by id, or by a
        // family the product has ONE colour of (none: created, named after
        // the family). Never a guess between two shades.
        const colors = await tx.offerColor.findMany({
          where: { vendorOfferId: offerId },
          orderBy: { sortOrder: 'asc' },
        });
        for (const i of items) {
          if (i.offerColorId) {
            const c = colors.find((x) => x.id === i.offerColorId);
            if (!c) {
              throw new BadRequestException({
                code: 'COLOR_NOT_FOUND',
                message: "This colour is not one of this product's colours",
                details: [{ offer_color_id: i.offerColorId }],
              });
            }
            if (i.colorCode && i.colorCode !== c.familyCode) {
              throw new BadRequestException({
                code: 'COLOR_FAMILY_MISMATCH',
                message: "color_code is not this colour's family",
                details: [{ offer_color_id: c.id, family: c.familyCode }],
              });
            }
            i.colorCode = c.familyCode;
          } else if (i.colorCode) {
            const same = colors.filter((x) => x.familyCode === i.colorCode);
            if (same.length > 1) {
              throw new ConflictException({
                code: 'COLOR_AMBIGUOUS',
                message:
                  'This product has more than one colour of this family - send offer_color_id',
                details: [
                  {
                    color_code: i.colorCode,
                    colors: same.map((x) => ({ id: x.id, name_ar: x.nameAr })),
                  },
                ],
              });
            }
            if (same.length === 1) i.offerColorId = same[0].id;
          }
        }
        for (const i of items) {
          await this.taxonomy.validateCombination(
            audiences,
            i.colorCode,
            i.sizeCode,
          );
        }

        const existing = await tx.offerVariant.findMany({
          where: { vendorOfferId: offerId },
          orderBy: { id: 'asc' },
        });
        let price: UnifiedPrice;
        if (existing.length === 0) {
          if (!dto.price) {
            throw new ConflictException({
              code: 'PRICE_REQUIRED',
              message: 'Send the product price with its first combinations',
            });
          }
          price = resolveUnifiedPrice(dto.price);
        } else {
          if (dto.price) {
            throw new ConflictException({
              code: 'PRICE_IS_OFFER_LEVEL',
              message:
                'This product already has a price - change it with PUT .../price',
            });
          }
          const e = existing[0];
          price = {
            basePrice: Number(e.basePrice),
            salePrice: e.salePrice === null ? null : Number(e.salePrice),
            discountPercent:
              e.discountPercent === null ? null : Number(e.discountPercent),
            discountStartAt: e.discountStartAt,
            discountEndAt: e.discountEndAt,
          };
          const clash = items.find((i) =>
            existing.some(
              (v) =>
                v.isCombination &&
                (i.offerColorId
                  ? v.offerColorId === i.offerColorId
                  : v.colorCode === i.colorCode) &&
                v.sizeCode === i.sizeCode,
            ),
          );
          if (clash) {
            throw new ConflictException({
              code: 'COMBINATION_EXISTS',
              message:
                'This combination already exists - refill its stock instead of creating it again',
              details: [
                { color_code: clash.colorCode, size_code: clash.sizeCode },
              ],
            });
          }
        }

        const branchIds = [
          ...new Set(items.flatMap((i) => i.stock.map((s) => s.branch_id))),
        ];
        const branches = await tx.storeBranch.findMany({
          where: { id: { in: branchIds }, vendorId, archivedAt: null },
          select: { id: true },
        });
        if (branches.length !== branchIds.length) {
          throw new NotFoundException({
            code: 'BRANCH_NOT_FOUND',
            message:
              'A branch in this request does not belong to this store (or is archived)',
          });
        }

        // A family the product has no colour of yet: its new product colour
        // (named after the family), after the existing ones (at most 30).
        for (const i of items) {
          if (i.colorCode && !i.offerColorId) {
            const created = colors.find((x) => x.familyCode === i.colorCode);
            if (created) {
              i.offerColorId = created.id;
              continue;
            }
            if (colors.length >= MAX_PRODUCT_COLORS) {
              throw new ConflictException({
                code: 'TOO_MANY_COLORS',
                message: `A product has at most ${MAX_PRODUCT_COLORS} colours`,
              });
            }
            const family = t.colors.find((c) => c.code === i.colorCode)!;
            const row = await tx.offerColor.create({
              data: {
                vendorId,
                vendorOfferId: offerId,
                familyCode: family.code,
                nameAr: family.nameAr,
                nameEn: family.nameEn,
                sortOrder:
                  colors.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1,
              },
            });
            colors.push(row);
            i.offerColorId = row.id;
          }
        }
        const now = new Date();
        const rows: CreatedRow[] = [];
        for (const [n, i] of items.entries()) {
          const id = randomUUID();
          const color = colors.find((c) => c.id === i.offerColorId) ?? null;
          // the default SKU as before; a second shade of a family gets its number
          const shade = color
            ? colors
                .filter((c) => c.familyCode === color.familyCode)
                .findIndex((c) => c.id === color.id) + 1
            : 1;
          const suffix = [
            i.colorCode ? `${i.colorCode}${shade > 1 ? shade : ''}` : 'NC',
            i.sizeCode ?? 'NS',
          ].join('-');
          const proposed = proposals[n];
          const variant = await tx.offerVariant.create({
            data: {
              id,
              vendorId,
              vendorOfferId: offerId,
              isCombination: true,
              offerColorId: color?.id ?? null,
              colorCode: i.colorCode,
              sizeCode: i.sizeCode,
              colour: color?.nameAr ?? null,
              size: i.sizeCode ? t.sizeByCode.get(i.sizeCode)!.label : null,
              sellerSku: i.src.seller_sku ?? `${offerId.slice(0, 8)}-${suffix}`,
              storeInventoryBarcode:
                i.src.store_inventory_barcode ??
                generateStoreInventoryBarcode(id),
              identifierType: i.src.identifier_type,
              identifierValue: i.src.identifier_value,
              condition: i.src.condition,
              specsTextAr: i.src.specs_text_ar,
              specsTextEn: i.src.specs_text_en,
              proposedCanonicalVariantId: proposed,
              matchProposalStatus: proposed ? 'PENDING' : 'NONE',
              ...price,
            },
          });
          await tx.priceHistory.create({
            data: {
              vendorId,
              offerVariantId: variant.id,
              basePrice: variant.basePrice,
              salePrice: variant.salePrice,
              discountPercent: variant.discountPercent,
              discountStartAt: variant.discountStartAt,
              discountEndAt: variant.discountEndAt,
              effectivePriceAtChange: computeEffectivePrice(variant, now),
              reason: 'MANUAL_EDIT',
              changedBy: user.id,
              changedAt: now,
            },
          });
          if (proposed) {
            // Same audit action the legacy path writes for a proposal.
            await this.auditLog.record(
              {
                actorId: user.id,
                correlationId: req.correlationId,
                action: 'offer_variant.match_proposed',
                entityType: 'OfferVariant',
                entityId: variant.id,
                afterState: {
                  identifier_type: variant.identifierType,
                  identifier_value: variant.identifierValue,
                  proposed_canonical_variant_id: proposed,
                },
              },
              tx,
            );
          }
          rows.push({
            id: variant.id,
            colorCode: i.colorCode,
            sizeCode: i.sizeCode,
            sellerSku: variant.sellerSku,
            storeInventoryBarcode: variant.storeInventoryBarcode,
            proposedCanonicalVariantId: variant.proposedCanonicalVariantId,
            matchProposalStatus: variant.matchProposalStatus,
          });
        }

        const mutations = items.flatMap((i, n) =>
          i.stock
            .filter((s) => s.quantity > 0)
            .map((s) => ({
              vendorId,
              branchId: s.branch_id,
              offerVariantId: rows[n].id,
              quantityDelta: s.quantity,
            })),
        );
        if (mutations.length > 0) {
          const results = await lockOffersWideForRestock(tx, mutations);
          for (const m of mutations) {
            const result = results.get(`${m.branchId}:${m.offerVariantId}`);
            const movement = await tx.stockMovement.create({
              data: {
                vendorId,
                branchId: m.branchId,
                offerVariantId: m.offerVariantId,
                quantityDelta: m.quantityDelta,
                resultingQuantity:
                  result?.targetStock.quantity ?? m.quantityDelta,
                reason: 'INITIAL_STOCK',
                reasonNote: 'الكمية الافتتاحية عند إنشاء التركيبة',
                actorId: user.id,
              },
            });
            await this.auditLog.record(
              {
                actorId: user.id,
                correlationId: req.correlationId,
                action: 'stock_movement.recorded',
                entityType: 'StockMovement',
                entityId: movement.id,
                afterState: {
                  offer_variant_id: m.offerVariantId,
                  branch_id: m.branchId,
                  quantity_delta: m.quantityDelta,
                  reason: 'INITIAL_STOCK',
                },
              },
              tx,
            );
          }
        }

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor_offer.combinations_created',
            entityType: 'VendorOffer',
            entityId: offerId,
            afterState: {
              combinations: rows.map((r) => ({
                variant_id: r.id,
                color_code: r.colorCode,
                size_code: r.sizeCode,
              })),
            },
          },
          tx,
        );
        return rows;
      });
    } catch (err) {
      // The partial unique index is the race-proof last word on
      // duplicates (two owners' tabs submitting at once). The per-vendor
      // seller_sku / store_inventory_barcode uniques can fire too - told
      // apart the way createVariant does (the adapter only exposes the
      // constraint inside err.meta, so its text is searched).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const metaText = JSON.stringify(err.meta ?? {});
        if (metaText.includes('storeInventoryBarcode')) {
          throw new ConflictException({
            code: 'STORE_INVENTORY_BARCODE_ALREADY_EXISTS',
            message:
              'You already have an offer variant with this store_inventory_barcode',
          });
        }
        if (metaText.includes('sellerSku')) {
          throw new ConflictException({
            code: 'SELLER_SKU_ALREADY_EXISTS',
            message: 'You already have an offer variant with this seller_sku',
          });
        }
        throw new ConflictException({
          code: 'COMBINATION_EXISTS',
          message: 'This combination already exists - refill its stock instead',
        });
      }
      throw err;
    }

    return {
      created: created.map((r) => ({
        variant_id: r.id,
        color_code: r.colorCode,
        size_code: r.sizeCode,
        seller_sku: r.sellerSku,
        store_inventory_barcode: r.storeInventoryBarcode,
        proposed_canonical_variant_id: r.proposedCanonicalVariantId,
        match_proposal_status: r.matchProposalStatus,
      })),
    };
  }
}
