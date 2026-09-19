import {
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Prisma } from '../../generated/prisma/client';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { MatchingService } from '../matching/matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { ConfirmMatchDto } from './dto/confirm-match.dto';
import { CreateOfferVariantDto } from './dto/create-offer-variant.dto';
import { CreateOfferVariantMediaDto } from './dto/create-offer-variant-media.dto';
import { CreateVendorOfferDto } from './dto/create-vendor-offer.dto';

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
@Controller('vendors/:vendorId/offers')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorOffersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly matching: MatchingService,
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

  @Get()
  @RequireVendorRole('OWNER')
  async list(@Param('vendorId') vendorId: string) {
    const offers = await this.prisma.vendorOffer.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' },
    });
    return offers.map((o) => this.offerToDto(o));
  }

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

  // Sprint 3 remediation (FR-MATCH-012, Sec 3.2, S3-B03 - not PDR-012,
  // which is unrelated/covers store sections): an exact-identifier match
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
            salePrice: dto.sale_price,
            specsTextAr: dto.specs_text_ar,
            specsTextEn: dto.specs_text_en,
            identifierType: dto.identifier_type,
            identifierValue: dto.identifier_value,
            storeInventoryBarcode:
              dto.store_inventory_barcode ?? generateStoreInventoryBarcode(id),
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

  private mediaToDto(media: {
    id: string;
    offerVariantId: string;
    url: string;
    kind: string;
    createdAt: Date;
  }) {
    return {
      id: media.id,
      offer_variant_id: media.offerVariantId,
      url: media.url,
      kind: media.kind,
      created_at: media.createdAt.toISOString(),
    };
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
  }

  // Sprint 6 (RB-MATCH-001): "صلاحيات الوسائط Owner-only" (media
  // permissions are owner-only) - @RequireVendorRole('OWNER'), same as
  // every other route on this controller. A new PRIMARY replaces any
  // existing one atomically (delete-then-insert in one transaction)
  // rather than requiring the vendor to delete the old one first -
  // the partial unique index (offer_variant_media_primary_per_variant_key)
  // is what this would otherwise conflict against if done as a plain
  // insert.
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

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
        if (kind === 'PRIMARY') {
          // Review-round finding: two concurrent PRIMARY requests for
          // the same variant could both pass deleteMany() (each seeing
          // the same pre-race state, or no existing row at all) and
          // then race each other's create() against the partial unique
          // index (offer_variant_media_primary_per_variant_key) - the
          // index correctly stops a second PRIMARY row from ever
          // existing, but the *loser* of that race got there via a
          // raw P2002/500, not the atomic replace this endpoint's own
          // contract promises. Locking the OfferVariant row itself
          // first (a fixed, per-variant key - ADDITIONAL inserts never
          // take this lock and stay fully concurrent) serializes the
          // two delete-then-insert sequences, so the second transaction
          // always sees the first's already-committed delete before it
          // deletes/inserts anything itself.
          await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${variantId} FOR UPDATE`;
          await tx.offerVariantMedia.deleteMany({
            where: { offerVariantId: variantId, kind: 'PRIMARY' },
          });
        }
        const media = await tx.offerVariantMedia.create({
          data: { vendorId, offerVariantId: variantId, url: dto.url, kind },
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
      orderBy: { createdAt: 'asc' },
    });
    return media.map((m) => this.mediaToDto(m));
  }

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
