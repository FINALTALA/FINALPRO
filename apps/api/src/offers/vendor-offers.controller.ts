import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Prisma } from '../../generated/prisma/client';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOfferVariantDto } from './dto/create-offer-variant.dto';
import { CreateVendorOfferDto } from './dto/create-vendor-offer.dto';

// FR-MATCH-001/BL-VEND-004/BR-014: a vendor's offers, nested under
// their vendor record. Only that vendor's own OWNER may create/manage
// them (VendorUser check below) - there is no public browse/search
// endpoint in Sprint 3 scope, so "vendor status gates offer visibility"
// (BR-014) is enforced at *creation* time: an offer cannot be created
// at all until the vendor's subscription is ACTIVE (FR-VEND-004).
@Controller('vendors/:vendorId/offers')
@UseGuards(SessionAuthGuard)
export class VendorOffersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly matching: MatchingService,
  ) {}

  private async requireOwner(vendorId: string, userId: string) {
    const membership = await this.prisma.vendorUser.findUnique({
      where: { userId_vendorId: { userId, vendorId } },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_VENDOR_OWNER',
        message: 'You are not a member of this vendor account',
      });
    }
  }

  private offerToDto(offer: {
    id: string;
    vendorId: string;
    canonicalProductId: string | null;
    titleAr: string;
    titleEn: string;
    status: string;
  }) {
    return {
      id: offer.id,
      vendor_id: offer.vendorId,
      canonical_product_id: offer.canonicalProductId,
      title_ar: offer.titleAr,
      title_en: offer.titleEn,
      status: offer.status,
    };
  }

  private variantToDto(variant: {
    id: string;
    vendorOfferId: string;
    canonicalVariantId: string | null;
    sellerSku: string;
    condition: string;
    currency: string;
    basePrice: Prisma.Decimal;
    salePrice: Prisma.Decimal | null;
    specsTextAr: string | null;
    specsTextEn: string | null;
    identifierType: string | null;
    identifierValue: string | null;
  }) {
    return {
      id: variant.id,
      vendor_offer_id: variant.vendorOfferId,
      canonical_variant_id: variant.canonicalVariantId,
      seller_sku: variant.sellerSku,
      condition: variant.condition,
      currency: variant.currency,
      base_price: variant.basePrice.toString(),
      sale_price: variant.salePrice?.toString() ?? null,
      specs_text_ar: variant.specsTextAr,
      specs_text_en: variant.specsTextEn,
      identifier_type: variant.identifierType,
      identifier_value: variant.identifierValue,
    };
  }

  @Get()
  async list(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.requireOwner(vendorId, user.id);
    const offers = await this.prisma.vendorOffer.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' },
    });
    return offers.map((o) => this.offerToDto(o));
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorOfferDto,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    // FR-VEND-004 / BR-014: catalog publication gated on an ACTIVE
    // subscription. OPEN-003 leaves real plan/grace-period policy
    // undecided - see VendorSubscription's schema comment - but the
    // gate itself is real, not simulated.
    if (vendor.subscriptionStatus !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required before creating offers',
      });
    }

    const offer = await this.prisma.vendorOffer.create({
      data: { vendorId, titleAr: dto.title_ar, titleEn: dto.title_en },
    });

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor_offer.created',
      entityType: 'VendorOffer',
      entityId: offer.id,
      afterState: this.offerToDto(offer),
    });

    return this.offerToDto(offer);
  }

  @Post(':offerId/variants')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async createVariant(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOfferVariantDto,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found for this vendor',
      });
    }

    // The identifier lookup itself is a pure read of CanonicalProductVariant,
    // which this endpoint never writes to - safe to resolve before the
    // transaction. What is NOT safe outside the transaction is deciding
    // *compatibility* against offer.canonicalProductId (see below).
    let rawMatch: {
      canonicalVariantId: string | null;
      canonicalProductId: string | null;
    } = {
      canonicalVariantId: null,
      canonicalProductId: null,
    };
    if (dto.identifier_type && dto.identifier_value) {
      rawMatch = await this.matching.findExactMatch(
        dto.identifier_type,
        dto.identifier_value,
      );
    }

    let variant;
    try {
      variant = await this.prisma.$transaction(async (tx) => {
        // Serializes concurrent variant-creations under the SAME offer:
        // without this lock, two requests each matching a *different*
        // canonical product could both read offer.canonicalProductId as
        // still null, both decide their match is "compatible", and both
        // commit - leaving the offer pointing at one product while one
        // of its own variants links to a different one (Part 3's
        // tightened invariant). Re-reading the offer fresh after the
        // lock makes the second request see the first's already-
        // committed link and correctly treat an incompatible match as
        // unmatched instead.
        await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
        const freshOffer = await tx.vendorOffer.findUniqueOrThrow({
          where: { id: offerId },
        });

        const match =
          rawMatch.canonicalProductId &&
          freshOffer.canonicalProductId &&
          freshOffer.canonicalProductId !== rawMatch.canonicalProductId
            ? { canonicalVariantId: null, canonicalProductId: null }
            : rawMatch;

        const created = await tx.offerVariant.create({
          data: {
            vendorId,
            vendorOfferId: offerId,
            canonicalVariantId: match.canonicalVariantId,
            sellerSku: dto.seller_sku,
            condition: dto.condition,
            currency: dto.currency,
            basePrice: dto.base_price,
            salePrice: dto.sale_price,
            specsTextAr: dto.specs_text_ar,
            specsTextEn: dto.specs_text_en,
            identifierType: dto.identifier_type,
            identifierValue: dto.identifier_value,
          },
        });

        if (match.canonicalProductId && !freshOffer.canonicalProductId) {
          await tx.vendorOffer.update({
            where: { id: offerId },
            data: { canonicalProductId: match.canonicalProductId },
          });
        }

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: match.canonicalVariantId
              ? 'offer_variant.auto_linked'
              : 'offer_variant.created',
            entityType: 'OfferVariant',
            entityId: created.id,
            afterState: this.variantToDto(created),
          },
          tx,
        );

        return created;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'SELLER_SKU_ALREADY_EXISTS',
          message: 'You already have an offer variant with this seller_sku',
        });
      }
      throw err;
    }

    return this.variantToDto(variant);
  }

  @Get(':offerId/variants')
  async listVariants(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.requireOwner(vendorId, user.id);
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
}
