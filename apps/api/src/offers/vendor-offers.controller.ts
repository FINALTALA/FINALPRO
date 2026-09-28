import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  ClothingCategoryTemplate,
  Prisma,
} from '../../generated/prisma/client';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  liveReservedQuantityByKey,
  totalAvailableStockLive,
} from '../common/availability.util';
import { CanonicalNamingService } from '../matching/canonical-naming.service';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import {
  describeTemplateProblems,
  validateTemplateAttributes,
} from './catalog/clothing-category-templates';
import { ConfirmMatchDto } from './dto/confirm-match.dto';
import { CreateOfferVariantDto } from './dto/create-offer-variant.dto';
import { CreateOfferVariantMediaDto } from './dto/create-offer-variant-media.dto';
import { CreateVendorOfferDto } from './dto/create-vendor-offer.dto';
import { ReorderOfferVariantMediaDto } from './dto/reorder-offer-variant-media.dto';
import { UpdateOfferVariantDto } from './dto/update-offer-variant.dto';
import { UpdateOfferVariantMediaDto } from './dto/update-offer-variant-media.dto';
import { UpdateVendorOfferDto } from './dto/update-vendor-offer.dto';
import { UpdateVendorOfferStatusDto } from './dto/update-vendor-offer-status.dto';
import {
  computeDiscountedPrice,
  computeEffectivePrice,
} from './pricing/effective-price.util';

const MEDIA_LIMITS: Record<'IMAGE' | 'VIDEO', number> = { IMAGE: 10, VIDEO: 3 };

// FR-MATCH-001/BL-VEND-004/BR-014: a vendor's offers, nested under
// their vendor record. Catalog/pricing is owner-only, full stop
// (PDR-009: "cannot edit prices, media, descriptions... store
// configuration" is explicitly an employee's forbidden list, and
// nothing in the current scope gives an employee a legitimate reason to
// even read it) - enforced via VendorMembershipGuard (class-level) +
// @RequireVendorRole('OWNER') on every individual route (see below for
// why that part can't be class-level). There is no
// public browse/search endpoint in Sprint 3 scope, so "vendor status
// gates offer visibility" (BR-014) is enforced at *creation* time: an
// offer cannot be created at all until the vendor's subscription is
// ACTIVE (FR-VEND-004, PDR-033's sandbox trial - see
// SubscriptionGateService for the lazy expiry check this gate now runs
// first).
//
// Sprint 5 review-round finding (RB-ROLE-006): every route here used to
// be guarded by a private requireOwner() that only checked *membership*
// (any role), not role itself - a BRANCH_EMPLOYEE could reach every
// method below, including price/catalog writes, a direct PDR-009
// violation pre-dating this sprint. Replaced with the same
// VendorMembershipGuard/@RequireVendorRole('OWNER') pattern already
// proven in VendorsController (Sprint 4) - see the regression test
// added alongside this fix. @RequireVendorRole is applied per-method,
// not at the class level: VendorMembershipGuard reads its metadata via
// `Reflector.get(KEY, context.getHandler())`, which only ever sees
// method-level SetMetadata, never a class-level decorator - the same
// per-method convention VendorsController's own owner-only routes
// already use, kept here rather than changing the shared guard's
// reflection behavior for every one of its other call sites.
//
// Sprint 17 adds: owner catalog editing (PATCH offer/variant, not just
// create+status), PDR-036 category templates + governed brand,
// scheduled relative discounts + PriceHistory (see
// offers/pricing/effective-price.util.ts for the read-only price
// computation every consumer shares), archive/restore, media type +
// limits + ordering, and the publish gate on transition to ACTIVE.
@Controller('vendors/:vendorId/offers')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorOffersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly matching: MatchingService,
    private readonly canonicalNaming: CanonicalNamingService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
    private readonly subscriptionGate: SubscriptionGateService,
  ) {}

  private offerToDto(offer: {
    id: string;
    vendorId: string;
    canonicalProductId: string | null;
    titleAr: string;
    titleEn: string;
    status: string;
    brandId: string | null;
    categoryTemplate: string | null;
    templateAttributes: Prisma.JsonValue | null;
    archivedAt: Date | null;
  }) {
    return {
      id: offer.id,
      vendor_id: offer.vendorId,
      canonical_product_id: offer.canonicalProductId,
      title_ar: offer.titleAr,
      title_en: offer.titleEn,
      status: offer.status,
      brand_id: offer.brandId,
      category_template: offer.categoryTemplate,
      template_attributes: offer.templateAttributes,
      archived_at: offer.archivedAt?.toISOString() ?? null,
    };
  }

  private variantToDto(variant: {
    id: string;
    vendorOfferId: string;
    canonicalVariantId: string | null;
    proposedCanonicalVariantId: string | null;
    matchProposalStatus: string;
    sellerSku: string;
    condition: string;
    basePrice: Prisma.Decimal;
    salePrice: Prisma.Decimal | null;
    discountPercent: Prisma.Decimal | null;
    discountStartAt: Date | null;
    discountEndAt: Date | null;
    colour: string | null;
    size: string | null;
    specsTextAr: string | null;
    specsTextEn: string | null;
    identifierType: string | null;
    identifierValue: string | null;
    storeInventoryBarcode: string;
  }) {
    return {
      id: variant.id,
      vendor_offer_id: variant.vendorOfferId,
      // Sprint 3 remediation (FR-MATCH-012, Sec 3.2 - not PDR-012, which
      // is unrelated/covers store sections): canonical_variant_id is set
      // *only* once the store owner confirms - see
      // match_proposal_status/proposed_canonical_variant_id for a
      // pending exact-identifier match still awaiting that decision.
      // Comparison (or anything that would treat this offer as matched)
      // must key off canonical_variant_id, never the proposed one.
      canonical_variant_id: variant.canonicalVariantId,
      proposed_canonical_variant_id: variant.proposedCanonicalVariantId,
      match_proposal_status: variant.matchProposalStatus,
      seller_sku: variant.sellerSku,
      condition: variant.condition,
      // Sprint 3 remediation (PDR-001): ILS is the only platform
      // currency - there is no per-offer currency to report; every
      // price on this platform is implicitly ILS.
      currency: 'ILS' as const,
      base_price: variant.basePrice.toString(),
      sale_price: variant.salePrice?.toString() ?? null,
      discount_percent: variant.discountPercent?.toString() ?? null,
      discount_start_at: variant.discountStartAt?.toISOString() ?? null,
      discount_end_at: variant.discountEndAt?.toISOString() ?? null,
      // Sprint 17 (blocker 1): the live computed price - what a
      // customer would actually pay right now - alongside the raw
      // config above, so the owner sees both what they configured and
      // what it currently resolves to.
      effective_price: computeEffectivePrice({
        basePrice: variant.basePrice.toString(),
        salePrice: variant.salePrice?.toString() ?? null,
        discountPercent: variant.discountPercent?.toString() ?? null,
        discountStartAt: variant.discountStartAt,
        discountEndAt: variant.discountEndAt,
      }),
      colour: variant.colour,
      size: variant.size,
      specs_text_ar: variant.specsTextAr,
      specs_text_en: variant.specsTextEn,
      identifier_type: variant.identifierType,
      identifier_value: variant.identifierValue,
      // Sprint 5 (RB-INV-001, PDR-018): the store-scoped, scanner-facing
      // barcode - never the internal platformProductBarcode, which this
      // DTO has no access to in the first place (it lives on
      // CanonicalProductVariant, not here) and must never be exposed.
      store_inventory_barcode: variant.storeInventoryBarcode,
    };
  }

  private mediaToDto(media: {
    id: string;
    offerVariantId: string;
    url: string;
    kind: string;
    mediaType: string;
    altTextAr: string | null;
    altTextEn: string | null;
    sortOrder: number;
    createdAt: Date;
  }) {
    return {
      id: media.id,
      offer_variant_id: media.offerVariantId,
      url: media.url,
      kind: media.kind,
      media_type: media.mediaType,
      alt_text_ar: media.altTextAr,
      alt_text_en: media.altTextEn,
      sort_order: media.sortOrder,
      created_at: media.createdAt.toISOString(),
    };
  }

  // ------------------------------------------------------------------
  // Sprint 17 (D1/D3): shared helpers for brand + category-template
  // validation, reused by create(), updateOffer() and the publish gate.
  // ------------------------------------------------------------------

  /** Throws 400 BRAND_NOT_FOUND if brandId is set but no such row exists. */
  private async assertBrandExists(
    client: Prisma.TransactionClient | PrismaService,
    brandId: string,
  ): Promise<void> {
    const brand = await client.brand.findUnique({ where: { id: brandId } });
    if (!brand) {
      throw new BadRequestException({
        code: 'BRAND_NOT_FOUND',
        message: 'brand_id does not reference an existing brand',
      });
    }
  }

  private assertTemplatePairValid(
    template: ClothingCategoryTemplate | null | undefined,
    attributes: unknown,
  ): void {
    if (!template) return;
    const problems = validateTemplateAttributes(template, attributes);
    if (problems.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_TEMPLATE_ATTRIBUTES',
        message: describeTemplateProblems(problems),
      });
    }
  }

  /**
   * Sprint 17 (identity lock, item 1 of the final review round): once
   * an offer is CONFIRMED-matched (canonicalProductId set - sticky,
   * never cleared by any code path in this system), its brand/
   * category_template/template_attributes must never change without an
   * explicit unmatch step that does not exist yet. Called under the
   * offer's own row lock.
   */
  private assertOfferIdentityUnlocked(
    offer: { canonicalProductId: string | null },
    touchesIdentity: boolean,
  ): void {
    if (offer.canonicalProductId && touchesIdentity) {
      throw new ConflictException({
        code: 'CONFIRMED_MATCH_IDENTITY_LOCKED',
        message:
          'This offer is matched to a canonical product - brand, category_template and template_attributes cannot be changed until an unmatch path exists',
      });
    }
  }

  /**
   * Sprint 17 (identity lock): once a VARIANT's own match is CONFIRMED,
   * its identifier_type/identifier_value cannot change either.
   */
  private assertVariantIdentityUnlocked(
    variant: { matchProposalStatus: string },
    touchesIdentifier: boolean,
  ): void {
    if (variant.matchProposalStatus === 'CONFIRMED' && touchesIdentifier) {
      throw new ConflictException({
        code: 'CONFIRMED_MATCH_IDENTITY_LOCKED',
        message:
          'This variant is matched to a canonical product - identifier_type/identifier_value cannot be changed until an unmatch path exists',
      });
    }
  }

  // ------------------------------------------------------------------

  @Get()
  @RequireVendorRole('OWNER')
  async list(@Param('vendorId') vendorId: string) {
    const offers = await this.prisma.vendorOffer.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' },
    });
    return offers.map((o) => this.offerToDto(o));
  }

  @Get(':offerId')
  @RequireVendorRole('OWNER')
  async get(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    return this.offerToDto(offer);
  }

  @BlockWhenSuspended()
  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async create(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorOfferDto,
    @Req() req: Request,
  ) {
    const vendorExists = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendorExists) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    // FR-VEND-004 / BR-014: catalog publication gated on an ACTIVE
    // subscription - refreshed lazily first (PDR-033's trial may have
    // just elapsed past its periodEnd without anything having checked
    // yet; see SubscriptionGateService). Run as its own, separate,
    // committing transaction: if the gate finds the trial has lapsed
    // and needs marking EXPIRED, that write must durably land even
    // though this request goes on to be rejected - it must not roll
    // back alongside the offer-creation transaction below just because
    // the gate says no.
    const subscriptionStatus = await this.prisma.$transaction((tx) =>
      this.subscriptionGate.refreshStatus(tx, vendorId, req.correlationId),
    );
    if (subscriptionStatus !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required before creating offers',
      });
    }

    // Sprint 17 (D1/D2/D3, blocker 2): structural fields are optional
    // at creation (the publish gate enforces them, not this endpoint) -
    // but whatever IS supplied must already be internally consistent.
    if (dto.brand_id) {
      await this.assertBrandExists(this.prisma, dto.brand_id);
    }
    this.assertTemplatePairValid(
      dto.category_template,
      dto.template_attributes,
    );

    return this.prisma.$transaction(async (tx) => {
      const offer = await tx.vendorOffer.create({
        data: {
          vendorId,
          titleAr: dto.title_ar,
          titleEn: dto.title_en,
          brandId: dto.brand_id ?? null,
          categoryTemplate: dto.category_template ?? null,
          // Prisma.DbNull (real SQL NULL), not Prisma.JsonNull (the
          // JSON literal `null` value) - the CHECK constraint tests
          // SQL NULL, and a stored JSON `null` would violate it.
          templateAttributes: dto.category_template
            ? (dto.template_attributes as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.created',
          entityType: 'VendorOffer',
          entityId: offer.id,
          afterState: this.offerToDto(offer),
        },
        tx,
      );

      const body = this.offerToDto(offer);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  // Sprint 17 (blocker 2): the owner's real "edit" path - title,
  // brand, category_template/template_attributes. Refused with 409
  // CONFIRMED_MATCH_IDENTITY_LOCKED if the offer is already matched and
  // the request touches brand/category_template/template_attributes
  // (see assertOfferIdentityUnlocked). On an UNMATCHED offer, changing
  // title/brand/category/template_attributes automatically re-runs
  // MatchingService.searchNonExactCandidates() for every one of this
  // offer's still-unmatched variants, inside this SAME transaction
  // (item 1 of the final review round) - offerText there is built from
  // title/specs/brand/template_attributes/colour/size (see
  // matching.service.ts's own comment), so this is a real re-score, not
  // a no-op. Never touches media (no signal there to re-score against -
  // see matching.service.ts).
  @BlockWhenSuspended()
  @Put(':offerId')
  @RequireVendorRole('OWNER')
  async updateOffer(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateVendorOfferDto,
    @Req() req: Request,
  ) {
    const touchesIdentity =
      dto.brand_id !== undefined ||
      dto.category_template !== undefined ||
      dto.template_attributes !== undefined;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
      const offer = await tx.vendorOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'VENDOR_OFFER_NOT_FOUND',
          message: 'Offer not found',
        });
      }
      this.assertOfferIdentityUnlocked(offer, touchesIdentity);

      const nextTemplate =
        dto.category_template !== undefined
          ? dto.category_template
          : (offer.categoryTemplate as ClothingCategoryTemplate | null);
      const nextAttributes =
        dto.template_attributes !== undefined
          ? dto.template_attributes
          : offer.templateAttributes;
      if (nextTemplate) {
        this.assertTemplatePairValid(nextTemplate, nextAttributes);
      } else if (nextAttributes !== null && nextAttributes !== undefined) {
        throw new BadRequestException({
          code: 'INVALID_TEMPLATE_ATTRIBUTES',
          message:
            'template_attributes must not be set without category_template',
        });
      }
      if (dto.brand_id) {
        await this.assertBrandExists(tx, dto.brand_id);
      }

      const data: Prisma.VendorOfferUpdateInput = {};
      if (dto.title_ar !== undefined) data.titleAr = dto.title_ar;
      if (dto.title_en !== undefined) data.titleEn = dto.title_en;
      if (dto.brand_id !== undefined) {
        data.brand = dto.brand_id
          ? { connect: { id: dto.brand_id } }
          : { disconnect: true };
      }
      if (dto.category_template !== undefined) {
        data.categoryTemplate = dto.category_template;
      }
      if (
        dto.template_attributes !== undefined ||
        dto.category_template !== undefined
      ) {
        // Prisma.DbNull, not Prisma.JsonNull - see create()'s own comment.
        data.templateAttributes = nextTemplate
          ? (nextAttributes as Prisma.InputJsonValue)
          : Prisma.DbNull;
      }

      const updated = await tx.vendorOffer.update({
        where: { id: offerId },
        data,
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.updated',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: this.offerToDto(offer),
          afterState: this.offerToDto(updated),
        },
        tx,
      );

      // Sprint 17 (item 1): re-run non-exact matching for every
      // still-unmatched variant, in-transaction, only when a field the
      // scoring function actually reads changed.
      const detailChanged =
        dto.title_ar !== undefined ||
        dto.title_en !== undefined ||
        dto.brand_id !== undefined ||
        dto.category_template !== undefined ||
        dto.template_attributes !== undefined;
      if (detailChanged) {
        const unmatchedVariants = await tx.offerVariant.findMany({
          where: {
            vendorOfferId: offerId,
            matchProposalStatus: { in: ['NONE', 'REJECTED'] },
          },
          select: { id: true },
        });
        for (const v of unmatchedVariants) {
          await this.matching.searchNonExactCandidates(vendorId, v.id, tx);
        }
      }

      return this.offerToDto(updated);
    });
  }

  // Sprint 17 (D5, G-CA-06): archive - a deliberate retirement,
  // distinct from a quick INACTIVE toggle (see OfferStatus.ARCHIVED's
  // own schema comment). Only from ACTIVE or INACTIVE, never from
  // DRAFT (nothing to retire) or already ARCHIVED.
  @BlockWhenSuspended()
  @Post(':offerId/archive')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async archive(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
      const offer = await tx.vendorOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'VENDOR_OFFER_NOT_FOUND',
          message: 'Offer not found',
        });
      }
      if (offer.status !== 'ACTIVE' && offer.status !== 'INACTIVE') {
        throw new ConflictException({
          code: 'OFFER_NOT_ARCHIVABLE',
          message: 'Only an ACTIVE or INACTIVE offer can be archived',
        });
      }
      const updated = await tx.vendorOffer.update({
        where: { id: offerId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.archived',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { status: offer.status },
          afterState: { status: 'ARCHIVED' },
        },
        tx,
      );
      return this.offerToDto(updated);
    });
  }

  // Sprint 17 (D5): restore ALWAYS returns to DRAFT, never straight to
  // ACTIVE - the publish gate must be re-evaluated (stock/media may
  // have changed while archived) before it can sell again.
  @BlockWhenSuspended()
  @Post(':offerId/restore')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async restore(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
      const offer = await tx.vendorOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'VENDOR_OFFER_NOT_FOUND',
          message: 'Offer not found',
        });
      }
      if (offer.status !== 'ARCHIVED') {
        throw new ConflictException({
          code: 'OFFER_NOT_ARCHIVED',
          message: 'Only an ARCHIVED offer can be restored',
        });
      }
      const updated = await tx.vendorOffer.update({
        where: { id: offerId },
        data: { status: 'DRAFT', archivedAt: null },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.restored',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { status: 'ARCHIVED' },
          afterState: { status: 'DRAFT' },
        },
        tx,
      );
      return this.offerToDto(updated);
    });
  }

  // Sprint 8 (RB-STOREF-002/RB-COMP-001): the missing piece that lets an
  // offer ever actually reach OfferStatus.ACTIVE at all.
  //
  // Sprint 17 (blocker 2, item 4 of the final review round): a
  // transition INTO 'ACTIVE' now runs the publish gate - title, a
  // valid category_template+template_attributes pair (only when a
  // template is set - D2), brand_id set, a PRIMARY IMAGE on at least
  // one variant, and LIVE available stock (quantity - live reservation,
  // never the raw reservedQuantity counter - see
  // common/availability.util.ts) on at least one variant/branch. All
  // five are evaluated together, inside ONE transaction that locks the
  // offer row FIRST and then every relevant branch_stock row (FOR
  // SHARE, sorted by stockLockKey - the exact canonical order
  // checkout.service.ts's own reserve()/confirm()/cancel() already use,
  // so a concurrent reservation against the same stock can never
  // deadlock against a concurrent publish attempt - see this method's
  // own reasoning below for why no cycle is possible). The gate never
  // retroactively touches an offer that was already ACTIVE before this
  // sprint, and never blocks saving a DRAFT with partial data - only
  // an actual transition attempt into ACTIVE is checked.
  @BlockWhenSuspended()
  @Patch(':offerId/status')
  @RequireVendorRole('OWNER')
  async updateStatus(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateVendorOfferStatusDto,
    @Req() req: Request,
  ) {
    if (dto.status === 'ARCHIVED') {
      throw new BadRequestException({
        code: 'USE_ARCHIVE_ENDPOINT',
        message: 'Use POST .../offers/:offerId/archive to archive an offer',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // Locks the offer row first - vendor_offers never intersects
      // checkout.service.ts's own lock set (it locks `vendors`, never
      // `vendor_offers`), so a publish transaction and a checkout
      // transaction can never form a lock-order cycle against each
      // other, by construction, not by convention.
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
      const offer = await tx.vendorOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.vendorId !== vendorId) {
        throw new NotFoundException({
          code: 'VENDOR_OFFER_NOT_FOUND',
          message: 'Offer not found',
        });
      }
      if (offer.status === 'ARCHIVED') {
        throw new ConflictException({
          code: 'OFFER_ARCHIVED',
          message: 'Restore this offer before changing its status',
        });
      }

      if (dto.status === 'ACTIVE') {
        await this.assertPublishGate(tx, vendorId, offer);
      }

      const updated = await tx.vendorOffer.update({
        where: { id: offerId },
        data: { status: dto.status },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.status_updated',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { status: offer.status },
          afterState: { status: updated.status },
        },
        tx,
      );
      return this.offerToDto(updated);
    });
  }

  private async assertPublishGate(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offer: {
      id: string;
      titleAr: string;
      titleEn: string;
      brandId: string | null;
      categoryTemplate: string | null;
      templateAttributes: Prisma.JsonValue | null;
    },
  ): Promise<void> {
    const missing: string[] = [];

    if (!offer.titleAr || !offer.titleEn) missing.push('title');
    if (!offer.brandId) missing.push('brand');
    if (offer.categoryTemplate) {
      const problems = validateTemplateAttributes(
        offer.categoryTemplate as ClothingCategoryTemplate,
        offer.templateAttributes,
      );
      if (problems.length > 0) missing.push('template_attributes');
    }

    const variants = await tx.offerVariant.findMany({
      where: { vendorOfferId: offer.id },
      select: { id: true, basePrice: true },
    });
    if (variants.length === 0) {
      missing.push('primary_image', 'available_stock');
    } else {
      const variantIds = variants.map((v) => v.id);

      const primaryImage = await tx.offerVariantMedia.findFirst({
        where: {
          offerVariantId: { in: variantIds },
          kind: 'PRIMARY',
          mediaType: 'IMAGE',
        },
      });
      if (!primaryImage) missing.push('primary_image');

      // Sprint 17 (item 4 of the final review round): lock every
      // relevant branch_stock row FOR SHARE, sorted by the canonical
      // stockLockKey, BEFORE reading live availability - this is what
      // makes the read race-free against a concurrent reserve()/POS
      // movement (which takes FOR UPDATE on the same row): whichever
      // side gets there first is fully committed before the other
      // proceeds. A plain read (no lock) would let a concurrent
      // reserve() consume the last unit between this read and the
      // status UPDATE below.
      const stocks = await tx.branchStock.findMany({
        where: { vendorId, offerVariantId: { in: variantIds } },
        select: { branchId: true, offerVariantId: true, quantity: true },
      });
      const sortedStocks = [...stocks].sort((a, b) => {
        const ka = `${vendorId}:${a.branchId}:${a.offerVariantId}`;
        const kb = `${vendorId}:${b.branchId}:${b.offerVariantId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const s of sortedStocks) {
        await tx.$queryRaw`SELECT id FROM branch_stock WHERE "vendorId" = ${vendorId} AND "branchId" = ${s.branchId} AND "offerVariantId" = ${s.offerVariantId} FOR SHARE`;
      }
      const liveReserved = await liveReservedQuantityByKey(tx, sortedStocks);
      const available = totalAvailableStockLive(sortedStocks, liveReserved);
      if (available <= 0) missing.push('available_stock');
    }

    if (missing.length > 0) {
      // HttpExceptionFilter only ever forwards code/message/details to
      // the client (never an arbitrary custom property) - the same
      // `details` convention CHECKOUT_PRICE_CHANGED already uses is
      // what carries this structured list, not a one-off `missing` key
      // that the filter would silently drop.
      throw new BadRequestException({
        code: 'OFFER_NOT_PUBLISHABLE',
        message: `This offer cannot be published yet: ${missing.join(', ')}`,
        details: missing,
      });
    }
  }

  // Sprint 3 remediation (FR-MATCH-012, Sec 3.2, S3-B03 - not PDR-012,
  // which is unrelated/covers store sections): an exact-identifier match
  // (BR-001/FR-MATCH-002) is now only ever a *proposal* - it never sets
  // canonicalVariantId here, however unambiguous the identifier is. No
  // cross-offer locking is needed at creation time any more either:
  // unlike the pre-remediation auto-link, nothing here writes to the
  // parent VendorOffer or risks the "offer disagrees with its own
  // variant's link" invariant - that write only ever happens in
  // confirmMatch() below, which is where the lock now lives.
  @BlockWhenSuspended()
  @Post(':offerId/variants')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async createVariant(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOfferVariantDto,
    @Req() req: Request,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found for this vendor',
      });
    }

    // Sprint 17 (blocker 1): mutual exclusivity checked before any
    // write, same rule as updateVariant().
    if (dto.sale_price !== undefined && dto.discount_percent !== undefined) {
      throw new BadRequestException({
        code: 'PRICE_MODE_CONFLICT',
        message:
          'sale_price and discount_percent cannot both be set - choose one',
      });
    }
    const priceFields = this.resolveDiscountFields(dto);

    let proposed: { canonicalVariantId: string | null } = {
      canonicalVariantId: null,
    };
    if (dto.identifier_type && dto.identifier_value) {
      const match = await this.matching.findExactMatch(
        dto.identifier_type,
        dto.identifier_value,
      );
      proposed = { canonicalVariantId: match.canonicalVariantId };
    }

    let variant;
    try {
      variant = await this.prisma.$transaction(async (tx) => {
        // Sprint 5 (RB-INV-001): the id is generated up front so a
        // missing store_inventory_barcode can be deterministically
        // derived from it before insert - see barcode.util.ts. A vendor
        // who supplies their own (their product's real manufacturer
        // barcode, per PDR-018) keeps it as-is.
        const id = randomUUID();
        const created = await tx.offerVariant.create({
          data: {
            id,
            vendorId,
            vendorOfferId: offerId,
            proposedCanonicalVariantId: proposed.canonicalVariantId,
            matchProposalStatus: proposed.canonicalVariantId
              ? 'PENDING'
              : 'NONE',
            sellerSku: dto.seller_sku,
            condition: dto.condition,
            basePrice: dto.base_price,
            salePrice: priceFields.salePrice,
            discountPercent: priceFields.discountPercent,
            discountStartAt: priceFields.discountStartAt,
            discountEndAt: priceFields.discountEndAt,
            colour: dto.colour,
            size: dto.size,
            specsTextAr: dto.specs_text_ar,
            specsTextEn: dto.specs_text_en,
            identifierType: dto.identifier_type,
            identifierValue: dto.identifier_value,
            storeInventoryBarcode:
              dto.store_inventory_barcode ?? generateStoreInventoryBarcode(id),
          },
        });

        // Sprint 17 (blocker 1): the very first PriceHistory row - not
        // only PATCH writes one. One captured `now` for both changedAt
        // and the effective-price snapshot.
        const now = new Date();
        await tx.priceHistory.create({
          data: {
            vendorId,
            offerVariantId: created.id,
            basePrice: created.basePrice,
            salePrice: created.salePrice,
            discountPercent: created.discountPercent,
            discountStartAt: created.discountStartAt,
            discountEndAt: created.discountEndAt,
            effectivePriceAtChange: computeEffectivePrice(created, now),
            reason: 'MANUAL_EDIT',
            changedBy: user.id,
            changedAt: now,
          },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: proposed.canonicalVariantId
              ? 'offer_variant.match_proposed'
              : 'offer_variant.created',
            entityType: 'OfferVariant',
            entityId: created.id,
            afterState: this.variantToDto(created),
          },
          tx,
        );

        const body = this.variantToDto(created);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          body,
          201,
        );
        return body;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Sprint 5 (RB-INV-001): two distinct per-vendor unique
        // constraints can now fire here (sellerSku, storeInventoryBarcode)
        // - the response should tell the vendor which one actually
        // conflicted instead of always blaming seller_sku. Classic
        // Prisma reports this as a flat `err.meta.target` field-name
        // array, but this project's Prisma 7 + @prisma/adapter-pg
        // driver-adapter setup does NOT populate that field at all -
        // confirmed empirically (a debug dump of a real P2002 here shows
        // no `target` key whatsoever). Instead the Postgres constraint
        // name only shows up nested, at
        // `err.meta.driverAdapterError.cause.constraint.index`. Rather
        // than hard-coding that specific nested path (liable to change
        // again with the next driver-adapter version), this just
        // stringifies the whole `meta` object and checks it for the
        // column name as a substring - works regardless of exactly
        // where in the shape it ends up.
        const metaText = JSON.stringify(err.meta ?? {});
        if (metaText.includes('storeInventoryBarcode')) {
          throw new ConflictException({
            code: 'STORE_INVENTORY_BARCODE_ALREADY_EXISTS',
            message:
              'You already have an offer variant with this store_inventory_barcode',
          });
        }
        throw new ConflictException({
          code: 'SELLER_SKU_ALREADY_EXISTS',
          message: 'You already have an offer variant with this seller_sku',
        });
      }
      throw err;
    }

    return variant;
  }

  /**
   * Sprint 17 (blocker 1): resolves the create/update DTO's price
   * fields into the exact columns to write - discount_percent/start/end
   * given together become the scheduled discount and clear salePrice;
   * sale_price given becomes the manual override; range/window checks
   * that mirror the DB CHECK constraints exactly, plus the
   * rounding-to-zero guard the CHECK constraints cannot express.
   */
  private resolveDiscountFields(dto: {
    sale_price?: number | null;
    discount_percent?: number | null;
    discount_start_at?: string | null;
    discount_end_at?: string | null;
    base_price?: number;
  }): {
    salePrice: number | null;
    discountPercent: number | null;
    discountStartAt: Date | null;
    discountEndAt: Date | null;
  } {
    const hasDiscount =
      dto.discount_percent !== undefined ||
      dto.discount_start_at !== undefined ||
      dto.discount_end_at !== undefined;
    if (hasDiscount) {
      const pct = dto.discount_percent;
      const start = dto.discount_start_at;
      const end = dto.discount_end_at;
      if (pct == null || !start || !end) {
        throw new BadRequestException({
          code: 'INCOMPLETE_DISCOUNT_WINDOW',
          message:
            'discount_percent, discount_start_at and discount_end_at must all be provided together',
        });
      }
      if (!(pct > 0 && pct < 100)) {
        throw new BadRequestException({
          code: 'DISCOUNT_PERCENT_OUT_OF_RANGE',
          message: 'discount_percent must be greater than 0 and less than 100',
        });
      }
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (!(startDate < endDate)) {
        throw new BadRequestException({
          code: 'INVALID_DISCOUNT_WINDOW',
          message: 'discount_start_at must be before discount_end_at',
        });
      }
      if (dto.base_price !== undefined) {
        // Review-round fix: the same computeDiscountedPrice() the live
        // effective-price read path uses - never a separate
        // Math.round(base*(1-pct/100)*100) floating-point calculation
        // that could disagree with it at a rounding boundary.
        if (computeDiscountedPrice(dto.base_price, pct).lessThanOrEqualTo(0)) {
          throw new BadRequestException({
            code: 'DISCOUNT_RESULTS_IN_ZERO_PRICE',
            message: 'This discount would round the price to zero or less',
          });
        }
      }
      return {
        salePrice: null,
        discountPercent: pct,
        discountStartAt: startDate,
        discountEndAt: endDate,
      };
    }
    if (dto.sale_price !== undefined) {
      // Sprint 17 review fix: this branch is only ever reached from
      // createVariant() (updateVariant() validates sale_price itself,
      // separately, since it must compare against a possibly-unchanged
      // EXISTING basePrice) - without this check, an invalid sale_price
      // at creation skipped all application-level validation and fell
      // through to the raw DB CHECK constraint, crashing with an
      // unhandled 500 instead of a clean 400.
      if (
        dto.base_price !== undefined &&
        !(dto.sale_price > 0 && dto.sale_price < dto.base_price)
      ) {
        throw new BadRequestException({
          code: 'INVALID_SALE_PRICE',
          message: 'sale_price must be positive and less than base_price',
        });
      }
      return {
        salePrice: dto.sale_price,
        discountPercent: null,
        discountStartAt: null,
        discountEndAt: null,
      };
    }
    return {
      salePrice: null,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
  }

  // Sprint 17 (blocker 2, item 1 of the final review round): the
  // owner's real "edit a variant" path. Locks the variant row first
  // (same row PriceHistory is written under). Refuses
  // identifier_type/identifier_value on a CONFIRMED variant (409
  // CONFIRMED_MATCH_IDENTITY_LOCKED). Writes a PriceHistory row only
  // when the resolved price configuration actually differs from what
  // is already stored (never on a no-op PATCH), using ONE captured
  // `now` for both changedAt and effectivePriceAtChange. Re-runs
  // MatchingService in-transaction: findExactMatch() when the
  // identifier changed on an unmatched variant (mirrors createVariant());
  // searchNonExactCandidates() when specs/colour/size changed on an
  // unmatched variant.
  @BlockWhenSuspended()
  @Put(':offerId/variants/:variantId')
  @RequireVendorRole('OWNER')
  async updateVariant(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOfferVariantDto,
    @Req() req: Request,
  ) {
    if (
      dto.sale_price !== undefined &&
      dto.sale_price !== null &&
      (dto.discount_percent !== undefined ||
        dto.discount_start_at !== undefined ||
        dto.discount_end_at !== undefined) &&
      (dto.discount_percent !== null ||
        dto.discount_start_at !== null ||
        dto.discount_end_at !== null)
    ) {
      throw new BadRequestException({
        code: 'PRICE_MODE_CONFLICT',
        message:
          'sale_price and discount_percent cannot both be set - choose one',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${variantId} FOR UPDATE`;
      const variant = await tx.offerVariant.findUnique({
        where: { id: variantId },
      });
      if (
        !variant ||
        variant.vendorId !== vendorId ||
        variant.vendorOfferId !== offerId
      ) {
        throw new NotFoundException({
          code: 'OFFER_VARIANT_NOT_FOUND',
          message: 'Offer variant not found for this offer',
        });
      }
      const touchesIdentifier =
        dto.identifier_type !== undefined || dto.identifier_value !== undefined;
      this.assertVariantIdentityUnlocked(variant, touchesIdentifier);

      // Review-round fix: the RESULTING pair after this request is
      // applied - never each field updated independently, which could
      // leave identifierType set with identifierValue still null (or
      // vice versa) whenever a caller only ever sends one of the two.
      // Both must end up set, or both cleared together; anything else
      // is refused before any write.
      const nextIdentifierType =
        dto.identifier_type !== undefined
          ? dto.identifier_type
          : variant.identifierType;
      const nextIdentifierValue =
        dto.identifier_value !== undefined
          ? dto.identifier_value
          : variant.identifierValue;
      if (!!nextIdentifierType !== !!nextIdentifierValue) {
        throw new BadRequestException({
          code: 'INCOMPLETE_IDENTIFIER_PAIR',
          message:
            'identifier_type and identifier_value must both be set, or both cleared together',
        });
      }

      const nextBasePrice = dto.base_price ?? Number(variant.basePrice);
      let nextSalePrice: number | null = variant.salePrice
        ? Number(variant.salePrice)
        : null;
      let nextDiscountPercent: number | null = variant.discountPercent
        ? Number(variant.discountPercent)
        : null;
      let nextDiscountStartAt: Date | null = variant.discountStartAt;
      let nextDiscountEndAt: Date | null = variant.discountEndAt;

      const discountFieldsTouched =
        dto.discount_percent !== undefined ||
        dto.discount_start_at !== undefined ||
        dto.discount_end_at !== undefined;
      if (dto.sale_price !== undefined) {
        // Setting sale_price (including explicit null) clears any
        // scheduled discount - mutual exclusivity (blocker 1).
        nextSalePrice = dto.sale_price;
        nextDiscountPercent = null;
        nextDiscountStartAt = null;
        nextDiscountEndAt = null;
      } else if (discountFieldsTouched) {
        const resolved = this.resolveDiscountFields({
          discount_percent: dto.discount_percent,
          discount_start_at: dto.discount_start_at,
          discount_end_at: dto.discount_end_at,
          base_price: nextBasePrice,
        });
        // A null in any one discount field means "clear the discount".
        if (
          dto.discount_percent === null ||
          dto.discount_start_at === null ||
          dto.discount_end_at === null
        ) {
          nextDiscountPercent = null;
          nextDiscountStartAt = null;
          nextDiscountEndAt = null;
        } else {
          nextDiscountPercent = resolved.discountPercent;
          nextDiscountStartAt = resolved.discountStartAt;
          nextDiscountEndAt = resolved.discountEndAt;
        }
        nextSalePrice = null;
      } else if (dto.base_price !== undefined && nextDiscountPercent !== null) {
        // base_price alone changed while a scheduled discount is still
        // active - re-check the rounding-to-zero guard against the NEW
        // base price, via the same shared computeDiscountedPrice().
        if (
          computeDiscountedPrice(
            nextBasePrice,
            nextDiscountPercent,
          ).lessThanOrEqualTo(0)
        ) {
          throw new BadRequestException({
            code: 'DISCOUNT_RESULTS_IN_ZERO_PRICE',
            message:
              'This base_price would make the existing discount round the price to zero or less',
          });
        }
      }
      if (
        nextSalePrice !== null &&
        !(nextSalePrice > 0 && nextSalePrice < nextBasePrice)
      ) {
        throw new BadRequestException({
          code: 'INVALID_SALE_PRICE',
          message: 'sale_price must be positive and less than base_price',
        });
      }

      const data: Prisma.OfferVariantUpdateInput = {};
      if (dto.condition !== undefined) data.condition = dto.condition;
      if (dto.base_price !== undefined) data.basePrice = dto.base_price;
      data.salePrice = nextSalePrice;
      data.discountPercent = nextDiscountPercent;
      data.discountStartAt = nextDiscountStartAt;
      data.discountEndAt = nextDiscountEndAt;
      if (dto.colour !== undefined) data.colour = dto.colour;
      if (dto.size !== undefined) data.size = dto.size;
      if (dto.specs_text_ar !== undefined) data.specsTextAr = dto.specs_text_ar;
      if (dto.specs_text_en !== undefined) data.specsTextEn = dto.specs_text_en;
      if (touchesIdentifier) {
        data.identifierType = nextIdentifierType;
        data.identifierValue = nextIdentifierValue;
      }

      const updated = await tx.offerVariant.update({
        where: { id: variantId },
        data,
      });

      const priceChanged =
        Number(variant.basePrice) !== Number(updated.basePrice) ||
        (variant.salePrice ? Number(variant.salePrice) : null) !==
          nextSalePrice ||
        (variant.discountPercent ? Number(variant.discountPercent) : null) !==
          nextDiscountPercent ||
        (variant.discountStartAt?.getTime() ?? null) !==
          (nextDiscountStartAt?.getTime() ?? null) ||
        (variant.discountEndAt?.getTime() ?? null) !==
          (nextDiscountEndAt?.getTime() ?? null);
      if (priceChanged) {
        const now = new Date();
        await tx.priceHistory.create({
          data: {
            vendorId,
            offerVariantId: variantId,
            basePrice: updated.basePrice,
            salePrice: updated.salePrice,
            discountPercent: updated.discountPercent,
            discountStartAt: updated.discountStartAt,
            discountEndAt: updated.discountEndAt,
            effectivePriceAtChange: computeEffectivePrice(updated, now),
            reason: 'MANUAL_EDIT',
            changedBy: user.id,
            changedAt: now,
          },
        });
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'offer_variant.updated',
          entityType: 'OfferVariant',
          entityId: variantId,
          beforeState: this.variantToDto(variant),
          afterState: this.variantToDto(updated),
        },
        tx,
      );

      // Review-round fix (item 1 continued): re-propose only when the
      // identifier PAIR actually changed (never on a resubmission of
      // the same pair, which would otherwise silently reset a
      // REJECTED proposal back to PENDING for no reason) - and, unlike
      // before, this now runs for BOTH directions: a new pair (rerun
      // findExactMatch and write its result even when no match is
      // found - never leave a stale PENDING/candidate from before) and
      // clearing the pair entirely (explicitly reset
      // proposedCanonicalVariantId/matchProposalStatus - previously
      // skipped, since `identifierType && identifierValue` is false
      // for a cleared pair, silently leaving the old proposal behind).
      const identifierPairChanged =
        touchesIdentifier &&
        (variant.identifierType !== nextIdentifierType ||
          variant.identifierValue !== nextIdentifierValue);
      if (
        identifierPairChanged &&
        updated.matchProposalStatus !== 'CONFIRMED'
      ) {
        if (nextIdentifierType && nextIdentifierValue) {
          const match = await this.matching.findExactMatch(
            nextIdentifierType,
            nextIdentifierValue,
            tx,
          );
          await tx.offerVariant.update({
            where: { id: variantId },
            data: {
              proposedCanonicalVariantId: match.canonicalVariantId,
              matchProposalStatus: match.canonicalVariantId
                ? 'PENDING'
                : 'NONE',
            },
          });
        } else {
          await tx.offerVariant.update({
            where: { id: variantId },
            data: {
              proposedCanonicalVariantId: null,
              matchProposalStatus: 'NONE',
            },
          });
        }
      }
      // Sprint 17 (item 1): non-exact rerun on this one variant, only
      // for fields the scoring function reads (specs/colour/size) -
      // never on media (see matching.service.ts's own comment).
      const detailChanged =
        dto.specs_text_ar !== undefined ||
        dto.specs_text_en !== undefined ||
        dto.colour !== undefined ||
        dto.size !== undefined;
      if (detailChanged && updated.matchProposalStatus !== 'CONFIRMED') {
        await this.matching.searchNonExactCandidates(vendorId, variantId, tx);
      }

      const finalVariant = await tx.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      return this.variantToDto(finalVariant);
    });
  }

  // Sprint 17 (FR-PRICE-002): read-only price history for one variant.
  @Get(':offerId/variants/:variantId/price-history')
  @RequireVendorRole('OWNER')
  async priceHistory(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    const rows = await this.prisma.priceHistory.findMany({
      where: { vendorId, offerVariantId: variantId },
      orderBy: { changedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      base_price: r.basePrice.toString(),
      sale_price: r.salePrice?.toString() ?? null,
      discount_percent: r.discountPercent?.toString() ?? null,
      discount_start_at: r.discountStartAt?.toISOString() ?? null,
      discount_end_at: r.discountEndAt?.toISOString() ?? null,
      effective_price_at_change: r.effectivePriceAtChange.toString(),
      currency: r.currency,
      reason: r.reason,
      changed_by: r.changedBy,
      changed_at: r.changedAt.toISOString(),
    }));
  }

  // Sprint 3 remediation (FR-MATCH-012, Sec 3.2, S3-B03 - not PDR-012,
  // which is unrelated/covers store sections): the store owner's
  // explicit confirm/reject of a pending match proposal - the only
  // thing that can ever set canonicalVariantId (and, transitively, the
  // parent VendorOffer's canonicalProductId). Locks the VendorOffer row
  // for the same reason createVariant() used to: two different variants
  // under the same offer being confirmed to two *different* canonical
  // products concurrently could otherwise both read the offer as
  // unlinked and both "win" - see the e2e concurrency test for this
  // exact race.
  //
  // Review-round finding, deliberately NOT implemented here: this
  // method only covers the *matching* half of Sec 3.2 (BR-001/
  // FR-MATCH-002/FR-MATCH-012). It does not implement that section's
  // separate, already-decided naming rule - "the first confirmed
  // matched offer supplies a provisional canonical name... a later
  // matching vendor must adopt the canonical name if it accepts the
  // product is identical... any matched vendor may request a
  // canonical-name change for admin approve/reject." Confirming a match
  // here never touches VendorOffer.titleAr/titleEn or
  // CanonicalProduct.modelName, and there is no admin-approval-request
  // entity for a requested rename - that is real, substantial new scope
  // (new fields, a first-confirmer-sets-the-name mechanic, a whole
  // approval flow) that this remediation's three named blockers
  // (S3-B01/B02/B03) did not include. This deferred requirement belongs
  // in the docs/product-decisions-2026-09 branch's backlog, not this
  // SRS/PR - it is NOT built here; do not treat confirmed matches as
  // having a synchronized display name.
  @BlockWhenSuspended()
  @Post(':offerId/variants/:variantId/match-confirmation')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async confirmMatch(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmMatchDto,
    @Req() req: Request,
  ) {
    const offerExists = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offerExists || offerExists.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found for this vendor',
      });
    }

    // Sprint 7 (RB-MATCH-003): a non-authoritative, pre-transaction
    // lookup of which CanonicalProduct a 'confirm' decision would
    // target - proposedCanonicalVariantId is immutable once an
    // OfferVariant is created (never updated afterward), so this id is
    // stable even though the *decision itself* is re-validated fresh
    // under lock below. Used only to decide lock order: canonical_products
    // is locked BEFORE vendor_offers, consistently with
    // MatchReviewController.decide() - see CanonicalNamingService's own
    // comment for why the fixed order matters (both the "two stores
    // confirm to the same product at once" race this sprint's own
    // requirement calls out, and deadlock avoidance between the two
    // locks).
    let targetCanonicalProductId: string | null = null;
    if (dto.decision === 'confirm') {
      const variantPreCheck = await this.prisma.offerVariant.findUnique({
        where: { id: variantId },
      });
      if (variantPreCheck?.proposedCanonicalVariantId) {
        const proposedVariantPreCheck =
          await this.prisma.canonicalProductVariant.findUnique({
            where: { id: variantPreCheck.proposedCanonicalVariantId },
          });
        targetCanonicalProductId =
          proposedVariantPreCheck?.canonicalProductId ?? null;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (targetCanonicalProductId) {
        await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${targetCanonicalProductId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;

      const freshOffer = await tx.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
      });
      const variant = await tx.offerVariant.findUnique({
        where: { id: variantId },
      });
      if (!variant || variant.vendorOfferId !== offerId) {
        throw new NotFoundException({
          code: 'OFFER_VARIANT_NOT_FOUND',
          message: 'Offer variant not found for this offer',
        });
      }
      if (variant.matchProposalStatus !== 'PENDING') {
        throw new ConflictException({
          code: 'NO_PENDING_MATCH_PROPOSAL',
          message:
            'This offer variant has no pending match proposal to confirm or reject',
        });
      }

      let updated;
      if (dto.decision === 'reject') {
        updated = await tx.offerVariant.update({
          where: { id: variantId },
          data: { matchProposalStatus: 'REJECTED' },
        });
      } else {
        const proposedVariant =
          await tx.canonicalProductVariant.findUniqueOrThrow({
            where: { id: variant.proposedCanonicalVariantId! },
          });
        if (
          freshOffer.canonicalProductId &&
          freshOffer.canonicalProductId !== proposedVariant.canonicalProductId
        ) {
          throw new ConflictException({
            code: 'MATCH_CONFLICTS_WITH_OFFER',
            message:
              'This offer is already linked to a different canonical product via another confirmed variant - reject this proposal or resolve the conflict first',
          });
        }

        updated = await tx.offerVariant.update({
          where: { id: variantId },
          data: {
            canonicalVariantId: variant.proposedCanonicalVariantId,
            matchProposalStatus: 'CONFIRMED',
          },
        });

        if (!freshOffer.canonicalProductId) {
          await tx.vendorOffer.update({
            where: { id: offerId },
            data: { canonicalProductId: proposedVariant.canonicalProductId },
          });
        }

        // Sprint 7 (RB-MATCH-003): first-confirmer sets the provisional
        // canonical name; every later confirmer's own offer adopts it.
        // Safe to call unconditionally here (not just when
        // !freshOffer.canonicalProductId) - a second variant of the
        // *same* already-matched offer being confirmed just re-applies
        // the same already-adopted name, a no-op.
        await this.canonicalNaming.applyOnConfirm(
          tx,
          proposedVariant.canonicalProductId,
          offerId,
          user.id,
          req.correlationId,
        );
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action:
            dto.decision === 'confirm'
              ? 'offer_variant.match_confirmed'
              : 'offer_variant.match_rejected',
          entityType: 'OfferVariant',
          entityId: updated.id,
          beforeState: this.variantToDto(variant),
          afterState: this.variantToDto(updated),
        },
        tx,
      );

      const body = this.variantToDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        200,
      );
      return body;
    });
  }

  @Get(':offerId/variants')
  @RequireVendorRole('OWNER')
  async listVariants(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found for this vendor',
      });
    }
    const variants = await this.prisma.offerVariant.findMany({
      where: { vendorOfferId: offerId },
      orderBy: { createdAt: 'asc' },
    });
    return variants.map((v) => this.variantToDto(v));
  }

  private async requireVariant(
    vendorId: string,
    offerId: string,
    variantId: string,
  ) {
    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: variantId },
    });
    if (
      !variant ||
      variant.vendorId !== vendorId ||
      variant.vendorOfferId !== offerId
    ) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found for this offer',
      });
    }
    return variant;
  }

  // Sprint 6 (RB-MATCH-001): "صلاحيات الوسائط Owner-only" (media
  // permissions are owner-only) - @RequireVendorRole('OWNER'), same as
  // every other route on this controller. A new PRIMARY replaces any
  // existing one atomically (delete-then-insert in one transaction)
  // rather than requiring the vendor to delete the old one first -
  // the partial unique index (offer_variant_media_primary_per_variant_key)
  // is what this would otherwise conflict against if done as a plain
  // insert.
  //
  // Sprint 17 (D9, item 5 of the final review round): media_type is now
  // mandatory; PRIMARY may only be IMAGE (checked here AND by the DB
  // CHECK). The per-variant row lock is now taken for EVERY insert, not
  // only PRIMARY ones - the 10-image/3-video count-then-insert check
  // below is itself a check-then-act race without it. sortOrder is
  // assigned deterministically under the same lock.
  @BlockWhenSuspended()
  @Post(':offerId/variants/:variantId/media')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async addVariantMedia(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOfferVariantMediaDto,
    @Req() req: Request,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    const kind = dto.kind ?? 'ADDITIONAL';
    if (kind === 'PRIMARY' && dto.media_type === 'VIDEO') {
      throw new BadRequestException({
        code: 'PRIMARY_MUST_BE_IMAGE',
        message: 'A PRIMARY media item must be an IMAGE, never a VIDEO',
      });
    }

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
        // Sprint 17: locked for every insert now (not just PRIMARY) -
        // see this method's own comment.
        await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${variantId} FOR UPDATE`;

        const existing = await tx.offerVariantMedia.findMany({
          where: { offerVariantId: variantId, mediaType: dto.media_type },
          select: { id: true },
        });
        if (existing.length >= MEDIA_LIMITS[dto.media_type]) {
          throw new ConflictException({
            code: 'MEDIA_LIMIT_REACHED',
            message: `This variant already has the maximum of ${MEDIA_LIMITS[dto.media_type]} ${dto.media_type.toLowerCase()} items`,
          });
        }

        if (kind === 'PRIMARY') {
          await tx.offerVariantMedia.deleteMany({
            where: { offerVariantId: variantId, kind: 'PRIMARY' },
          });
        }
        const maxSort = await tx.offerVariantMedia.aggregate({
          where: { offerVariantId: variantId },
          _max: { sortOrder: true },
        });
        const media = await tx.offerVariantMedia.create({
          data: {
            vendorId,
            offerVariantId: variantId,
            url: dto.url,
            kind,
            mediaType: dto.media_type,
            altTextAr: dto.alt_text_ar,
            altTextEn: dto.alt_text_en,
            sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'offer_variant_media.added',
            entityType: 'OfferVariantMedia',
            entityId: media.id,
            afterState: this.mediaToDto(media),
          },
          tx,
        );

        const responseBody = this.mediaToDto(media);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          responseBody,
          201,
        );
        return responseBody;
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // Defensive only - the FOR UPDATE lock above already makes this
      // unreachable for PRIMARY under normal operation; kept in case a
      // future caller ever creates ADDITIONAL/PRIMARY rows through a
      // path that bypasses this lock (e.g. a direct write).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'PRIMARY_MEDIA_ALREADY_EXISTS',
          message: 'This offer variant already has a primary image',
        });
      }
      throw err;
    }

    return body;
  }

  @Get(':offerId/variants/:variantId/media')
  @RequireVendorRole('OWNER')
  async listVariantMedia(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    const media = await this.prisma.offerVariantMedia.findMany({
      where: { offerVariantId: variantId },
      orderBy: { sortOrder: 'asc' },
    });
    return media.map((m) => this.mediaToDto(m));
  }

  // Sprint 17 (FR-CAT-005): alt text only.
  @BlockWhenSuspended()
  @Patch(':offerId/variants/:variantId/media/:mediaId')
  @RequireVendorRole('OWNER')
  async updateVariantMedia(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOfferVariantMediaDto,
    @Req() req: Request,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    const media = await this.prisma.offerVariantMedia.findUnique({
      where: { id: mediaId },
    });
    if (!media || media.offerVariantId !== variantId) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_MEDIA_NOT_FOUND',
        message: 'Media not found for this offer variant',
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.offerVariantMedia.update({
        where: { id: mediaId },
        data: {
          altTextAr:
            dto.alt_text_ar !== undefined ? dto.alt_text_ar : undefined,
          altTextEn:
            dto.alt_text_en !== undefined ? dto.alt_text_en : undefined,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'offer_variant_media.updated',
          entityType: 'OfferVariantMedia',
          entityId: mediaId,
          beforeState: this.mediaToDto(media),
          afterState: this.mediaToDto(result),
        },
        tx,
      );
      return result;
    });
    return this.mediaToDto(updated);
  }

  // Sprint 17 (D9): reorder - same pattern as
  // StoreSectionsController.reorder() (BOLA-safe: the provided id set
  // must be EXACTLY this variant's own media ids, no more, no fewer).
  @BlockWhenSuspended()
  @Put(':offerId/variants/:variantId/media/reorder')
  @RequireVendorRole('OWNER')
  async reorderVariantMedia(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderOfferVariantMediaDto,
    @Req() req: Request,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${variantId} FOR UPDATE`;
      const existing = await tx.offerVariantMedia.findMany({
        where: { offerVariantId: variantId },
      });
      const existingIds = new Set(existing.map((m) => m.id));
      const providedIds = dto.media_ids;
      const providedSet = new Set(providedIds);
      if (
        providedSet.size !== providedIds.length ||
        providedSet.size !== existingIds.size ||
        ![...providedSet].every((id) => existingIds.has(id))
      ) {
        throw new ForbiddenException({
          code: 'MEDIA_REORDER_MISMATCH',
          message:
            "media_ids must contain exactly this variant's own media ids, each exactly once",
        });
      }
      for (let i = 0; i < providedIds.length; i += 1) {
        await tx.offerVariantMedia.update({
          where: { id: providedIds[i] },
          data: { sortOrder: i },
        });
      }
      const reordered = await tx.offerVariantMedia.findMany({
        where: { offerVariantId: variantId },
        orderBy: { sortOrder: 'asc' },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'offer_variant_media.reordered',
          entityType: 'OfferVariant',
          entityId: variantId,
          afterState: { media_ids: providedIds },
        },
        tx,
      );
      return reordered.map((m) => this.mediaToDto(m));
    });
  }

  @BlockWhenSuspended()
  @Delete(':offerId/variants/:variantId/media/:mediaId')
  @HttpCode(204)
  @RequireVendorRole('OWNER')
  async removeVariantMedia(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    const media = await this.prisma.offerVariantMedia.findUnique({
      where: { id: mediaId },
    });
    if (!media || media.offerVariantId !== variantId) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_MEDIA_NOT_FOUND',
        message: 'Media not found for this offer variant',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.offerVariantMedia.delete({ where: { id: mediaId } });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'offer_variant_media.removed',
          entityType: 'OfferVariantMedia',
          entityId: mediaId,
          beforeState: this.mediaToDto(media),
        },
        tx,
      );
    });
  }
}
