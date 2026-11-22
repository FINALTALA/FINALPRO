import { ContentViaEditDraft } from './content-via-edit-draft.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { ownUploadProblem, parseOwnUploadUrl } from '../uploads/uploads.util';
import {
  MAX_SHARED_IMAGES,
  MODEL_SIZE_MAX,
  modelProblem,
} from './offer-presentation';

type Tx = Prisma.TransactionClient;

export class SetOfferModelDto {
  /** null (with size null) removes the model information. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  height_cm!: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(MODEL_SIZE_MAX)
  size!: string | null;
}

export class SetSharedImagesDto {
  @IsArray()
  @ArrayMaxSize(MAX_SHARED_IMAGES)
  @IsString({ each: true })
  urls!: string[];
}

/**
 * Phase A++ (items 5 and 6): a published product's model information and
 * its shared images, edited from the product page with the SAME rules the
 * wizard's draft check applies (offer-presentation.ts). Owner-only and
 * scoped to the :vendorId the membership guard proved - another store's
 * product reads as 404.
 *
 * Shared images: the product's own rows are replaced; no file is ever
 * deleted here (the same file may be used by another product, a draft or
 * the store; only the draft clean-up removes a file, and only once nothing
 * uses it).
 */
@Controller('vendors/:vendorId/offers/:offerId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OfferPresentationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async lockOffer(tx: Tx, vendorId: string, offerId: string) {
    await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
    const offer = await tx.vendorOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found for this store',
      });
    }
    return offer;
  }

  /** The product's own sizes (its versions'), in the taxonomy's order. */
  private async sizesOf(db: Tx | PrismaService, offerId: string) {
    const rows = await db.offerVariant.findMany({
      where: { vendorOfferId: offerId, sizeCode: { not: null } },
      select: { sizeCode: true },
      distinct: ['sizeCode'],
    });
    const t = await this.taxonomy.get();
    const order = new Map(t.sizes.map((s) => [s.code, s.sortOrder]));
    return rows
      .map((r) => r.sizeCode!)
      .map((code) => ({
        code,
        label: t.sizeByCode.get(code)?.label ?? code,
        order: order.get(code) ?? 0,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ code, label }) => ({ code, label }));
  }

  private async dto(db: Tx | PrismaService, offerId: string) {
    const offer = await db.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
      include: { sharedMedia: { orderBy: { sortOrder: 'asc' } } },
    });
    return {
      model:
        offer.modelHeightCm !== null && offer.modelSize !== null
          ? { height_cm: offer.modelHeightCm, size: offer.modelSize }
          : null,
      shared_images: offer.sharedMedia.map((m) => m.url),
      sizes: await this.sizesOf(db, offerId),
    };
  }

  @Get('presentation')
  @RequireVendorRole('OWNER')
  async get(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: { vendorId: true },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found for this store',
      });
    }
    return this.dto(this.prisma, offerId);
  }

  @BlockWhenSuspended()
  @ContentViaEditDraft()
  @Put('model')
  @RequireVendorRole('OWNER')
  async setModel(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() body: SetOfferModelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockOffer(tx, vendorId, offerId);
      const height = body.height_cm ?? null;
      const size = (body.size ?? '').trim() || null;
      const sizes = (await this.sizesOf(tx, offerId)).map((s) => s.code);
      const problem = modelProblem(height, size, sizes);
      if (problem) {
        throw new BadRequestException({
          code: problem,
          message:
            problem === 'MODEL_SIZE_NOT_IN_PRODUCT'
              ? "The model's size must be one of this product's sizes"
              : problem === 'MODEL_HEIGHT_RANGE'
                ? "The model's height must be 100-220 cm"
                : 'Give both the height and the size, or neither',
        });
      }
      await tx.vendorOffer.update({
        where: { id: offerId },
        data: { modelHeightCm: height, modelSize: size },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.model_updated',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: {
            height_cm: before.modelHeightCm,
            size: before.modelSize,
          },
          afterState: { height_cm: height, size },
        },
        tx,
      );
      return this.dto(tx, offerId);
    });
  }

  @BlockWhenSuspended()
  @ContentViaEditDraft()
  @Put('shared-images')
  @RequireVendorRole('OWNER')
  async setSharedImages(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() body: SetSharedImagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const urls = [...new Set(body.urls)];
    for (const url of urls) {
      const problem = parseOwnUploadUrl(url)
        ? ownUploadProblem(url, vendorId)
        : 'Only images uploaded to this store can be used';
      if (problem) {
        throw new BadRequestException({
          code: 'UPLOAD_NOT_USABLE',
          message: problem,
        });
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockOffer(tx, vendorId, offerId);
      const before = await tx.vendorOfferSharedMedia.findMany({
        where: { vendorOfferId: offerId },
        orderBy: { sortOrder: 'asc' },
        select: { url: true },
      });
      await tx.vendorOfferSharedMedia.deleteMany({
        where: { vendorOfferId: offerId },
      });
      if (urls.length > 0) {
        await tx.vendorOfferSharedMedia.createMany({
          data: urls.map((url, i) => ({
            vendorId,
            vendorOfferId: offerId,
            url,
            sortOrder: i,
          })),
        });
      }
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'vendor_offer.shared_images_updated',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { urls: before.map((m) => m.url) },
          afterState: { urls },
        },
        tx,
      );
      return this.dto(tx, offerId);
    });
  }
}
