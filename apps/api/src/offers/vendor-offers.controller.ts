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
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { ConfirmMatchDto } from './dto/confirm-match.dto';
import { CreateOfferVariantDto } from './dto/create-offer-variant.dto';
import { CreateVendorOfferDto } from './dto/create-vendor-offer.dto';

// FR-MATCH-001/BL-VEND-004/BR-014: a vendor's offers, nested under
// their vendor record. Only that vendor's own OWNER may create/manage
// them (VendorUser check below) - there is no public browse/search
// endpoint in Sprint 3 scope, so "vendor status gates offer visibility"
// (BR-014) is enforced at *creation* time: an offer cannot be created
// at all until the vendor's subscription is ACTIVE (FR-VEND-004,
// PDR-033's sandbox trial - see SubscriptionGateService for the lazy
// expiry check this gate now runs first).
@Controller('vendors/:vendorId/offers')
@UseGuards(SessionAuthGuard)
export class VendorOffersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly matching: MatchingService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
    private readonly subscriptionGate: SubscriptionGateService,
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
    proposedCanonicalVariantId: string | null;
    matchProposalStatus: string;
    sellerSku: string;
    condition: string;
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
      // Sprint 3 remediation (PDR-012): canonical_variant_id is set
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
      this.subscriptionGate.refreshStatus(tx, vendorId),
    );
    if (subscriptionStatus !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: 'An active subscription is required before creating offers',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const offer = await tx.vendorOffer.create({
        data: { vendorId, titleAr: dto.title_ar, titleEn: dto.title_en },
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

  // Sprint 3 remediation (PDR-012, S3-B03): an exact-identifier match
  // (BR-001/FR-MATCH-002) is now only ever a *proposal* - it never sets
  // canonicalVariantId here, however unambiguous the identifier is. No
  // cross-offer locking is needed at creation time any more either:
  // unlike the pre-remediation auto-link, nothing here writes to the
  // parent VendorOffer or risks the "offer disagrees with its own
  // variant's link" invariant - that write only ever happens in
  // confirmMatch() below, which is where the lock now lives.
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
        const created = await tx.offerVariant.create({
          data: {
            vendorId,
            vendorOfferId: offerId,
            proposedCanonicalVariantId: proposed.canonicalVariantId,
            matchProposalStatus: proposed.canonicalVariantId
              ? 'PENDING'
              : 'NONE',
            sellerSku: dto.seller_sku,
            condition: dto.condition,
            basePrice: dto.base_price,
            salePrice: dto.sale_price,
            specsTextAr: dto.specs_text_ar,
            specsTextEn: dto.specs_text_en,
            identifierType: dto.identifier_type,
            identifierValue: dto.identifier_value,
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
        throw new ConflictException({
          code: 'SELLER_SKU_ALREADY_EXISTS',
          message: 'You already have an offer variant with this seller_sku',
        });
      }
      throw err;
    }

    return variant;
  }

  // Sprint 3 remediation (PDR-012, S3-B03): the store owner's explicit
  // confirm/reject of a pending match proposal - the only thing that
  // can ever set canonicalVariantId (and, transitively, the parent
  // VendorOffer's canonicalProductId). Locks the VendorOffer row for
  // the same reason createVariant() used to: two different variants
  // under the same offer being confirmed to two *different* canonical
  // products concurrently could otherwise both read the offer as
  // unlinked and both "win" - see the e2e concurrency test for this
  // exact race.
  @Post(':offerId/variants/:variantId/match-confirmation')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async confirmMatch(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmMatchDto,
    @Req() req: Request,
  ) {
    await this.requireOwner(vendorId, user.id);

    const offerExists = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offerExists || offerExists.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found for this vendor',
      });
    }

    return this.prisma.$transaction(async (tx) => {
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
