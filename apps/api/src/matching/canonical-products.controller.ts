import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { PlatformRole, Prisma } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { generatePlatformProductBarcode } from '../common/barcode.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { findSimilarCanonicalProducts } from '../catalog/duplicate-check.util';
import { CanonicalNamingService } from './canonical-naming.service';
import { CanonicalProductLifecycleService } from './canonical-product-lifecycle.service';
import { CanonicalProductMergeService } from './canonical-product-merge.service';
import { CanonicalProductStatusTransitionDto } from './dto/canonical-product-status-transition.dto';
import { CreateCanonicalProductDto } from './dto/create-canonical-product.dto';
import { CreateCanonicalVariantDto } from './dto/create-canonical-variant.dto';
import { DecideNameChangeRequestDto } from './dto/decide-name-change-request.dto';
import { MergeCanonicalProductDto } from './dto/merge-canonical-product.dto';
import { RestrictCanonicalProductDto } from './dto/restrict-canonical-product.dto';
import { SplitCanonicalProductDto } from './dto/split-canonical-product.dto';
import { UpdateCanonicalProductDto } from './dto/update-canonical-product.dto';
import { nameChangeRequestDto } from './match-review.controller';

// FR-MATCH-008 / BL-MATCH-001: level 1 + 2 of the four-level canonical
// model. Read routes are public; writes require PLATFORM_ADMIN (Part 3:
// CanonicalProduct/CanonicalProductVariant are Platform-owned).
@Controller('canonical-products')
export class CanonicalProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly canonicalNaming: CanonicalNamingService,
    private readonly lifecycle: CanonicalProductLifecycleService,
    private readonly mergeService: CanonicalProductMergeService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  private toDto(product: {
    id: string;
    brandId: string;
    categoryId: string;
    modelName: string;
    status: string;
    canonicalNameAr: string | null;
    canonicalNameEn: string | null;
    productType: string;
    warrantyPeriod: string | null;
    warrantyType: string | null;
    tags: string[];
    seoTitleAr: string | null;
    seoTitleEn: string | null;
    seoDescriptionAr: string | null;
    seoDescriptionEn: string | null;
    isRestricted: boolean;
    mergedIntoId: string | null;
  }) {
    return {
      id: product.id,
      brand_id: product.brandId,
      category_id: product.categoryId,
      model_name: product.modelName,
      status: product.status,
      // Sprint 7 (RB-MATCH-003): the customer-facing name, once a
      // first vendor has confirmed a match - null until then. Never
      // the internal platformProductBarcode (see that field's own
      // comment on CanonicalProductVariant, which this DTO already
      // never includes either).
      canonical_name_ar: product.canonicalNameAr,
      canonical_name_en: product.canonicalNameEn,
      // Sprint 17b (BL-CAT-003/FR-CAT-006/FR-MATCH-006).
      product_type: product.productType,
      warranty_period: product.warrantyPeriod,
      warranty_type: product.warrantyType,
      tags: product.tags,
      seo_title_ar: product.seoTitleAr,
      seo_title_en: product.seoTitleEn,
      seo_description_ar: product.seoDescriptionAr,
      seo_description_en: product.seoDescriptionEn,
      // restrictionReason is PLATFORM_ADMIN-visible only, returned
      // only by restrict()/unrestrict() themselves - same convention
      // as CategoriesController's own toDto().
      is_restricted: product.isRestricted,
      merged_into_id: product.mergedIntoId,
    };
  }

  private variantToDto(variant: {
    id: string;
    canonicalProductId: string;
    structuralAttributes: Prisma.JsonValue;
    mpn: string | null;
    gtin: string | null;
  }) {
    return {
      id: variant.id,
      canonical_product_id: variant.canonicalProductId,
      structural_attributes: variant.structuralAttributes,
      mpn: variant.mpn,
      gtin: variant.gtin,
    };
  }

  @Get()
  async list() {
    const products = await this.prisma.canonicalProduct.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return products.map((p) => this.toDto(p));
  }

  // Sprint 7 (RB-MATCH-003): the admin queue - every vendor's PENDING
  // rename request across every canonical product, oldest first (a
  // reviewer works through it in submission order). Created by
  // MatchReviewController.requestNameChange() (owner-only, vendor-
  // scoped); only ever decided here. Declared before @Get(':id') below
  // deliberately - NestJS/Express matches routes in declaration order,
  // and :id would otherwise swallow the literal "name-change-requests"
  // segment as if it were an id.
  @Get('name-change-requests')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async listNameChangeRequests() {
    const requests = await this.prisma.canonicalNameChangeRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return requests.map(nameChangeRequestDto);
  }

  // Approval propagates the new name to the CanonicalProduct itself and
  // every VendorOffer currently matched to it (CanonicalNamingService.
  // applyApprovedRename()) - "the new name becomes canonical for every
  // related matched offer." Locks the CanonicalProduct row first (same
  // fixed lock order as confirmMatch()/decide(), so this can never race
  // a concurrent first-confirmation or another decision for the same
  // product) and auto-rejects every other still-PENDING request for
  // the same product - only one name can stand, the same "no
  // conflicting outcome left dangling" pattern this codebase already
  // uses for match candidates/staff invites. Same route-ordering
  // reasoning as listNameChangeRequests above - must precede
  // @Get(':id').
  @Post('name-change-requests/:requestId/decision')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async decideNameChangeRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
    @Body() dto: DecideNameChangeRequestDto,
    @Req() req: Request,
  ) {
    const preCheck = await this.prisma.canonicalNameChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!preCheck) {
      throw new NotFoundException({
        code: 'NAME_CHANGE_REQUEST_NOT_FOUND',
        message: 'Name change request not found',
      });
    }

    const body = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${preCheck.canonicalProductId} FOR UPDATE`;

      const request = await tx.canonicalNameChangeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      if (request.status !== 'PENDING') {
        throw new ConflictException({
          code: 'NAME_CHANGE_REQUEST_ALREADY_DECIDED',
          message: 'This name change request has already been decided',
        });
      }

      let updated;
      if (dto.decision === 'reject') {
        updated = await tx.canonicalNameChangeRequest.update({
          where: { id: requestId },
          data: {
            status: 'REJECTED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
      } else {
        updated = await tx.canonicalNameChangeRequest.update({
          where: { id: requestId },
          data: {
            status: 'APPROVED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
        await this.canonicalNaming.applyApprovedRename(
          tx,
          request.canonicalProductId,
          request.requestedNameAr,
          request.requestedNameEn,
          user.id,
          req.correlationId,
        );
        await tx.canonicalNameChangeRequest.updateMany({
          where: {
            canonicalProductId: request.canonicalProductId,
            status: 'PENDING',
            id: { not: requestId },
          },
          data: {
            status: 'REJECTED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action:
            dto.decision === 'approve'
              ? 'canonical_name_change_request.approved'
              : 'canonical_name_change_request.rejected',
          entityType: 'CanonicalNameChangeRequest',
          entityId: requestId,
          afterState: nameChangeRequestDto(updated),
        },
        tx,
      );

      const responseBody = nameChangeRequestDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });

    return body;
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    return {
      ...this.toDto(product),
      variants: product.variants.map((v) => this.variantToDto(v)),
    };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCanonicalProductDto,
    @Req() req: Request,
  ) {
    const [brand, category] = await Promise.all([
      this.prisma.brand.findUnique({ where: { id: dto.brand_id } }),
      this.prisma.category.findUnique({ where: { id: dto.category_id } }),
    ]);
    if (!brand) {
      throw new NotFoundException({
        code: 'BRAND_NOT_FOUND',
        message: 'brand_id does not reference an existing brand',
      });
    }
    if (!category) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'category_id does not reference an existing category',
      });
    }
    // Sprint 17b (FR-CAT-006): forward-looking - a restricted category
    // blocks NEW products from being created under it. Pre-existing
    // products already there are untouched (not this check's concern).
    if (category.isRestricted) {
      throw new ConflictException({
        code: 'CATEGORY_RESTRICTED',
        message:
          'This category is restricted - new products cannot be created under it',
      });
    }

    if (!dto.confirm_despite_duplicate_warning) {
      const similar = await findSimilarCanonicalProducts(
        this.prisma,
        dto.model_name,
      );
      if (similar.length > 0) {
        throw new ConflictException({
          code: 'POSSIBLE_DUPLICATE',
          message:
            'A similarly-named canonical product already exists - resubmit with confirm_despite_duplicate_warning to proceed anyway',
          details: similar.map((s) => ({
            id: s.id,
            model_name: s.model_name,
            similarity: s.similarity,
          })),
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Sprint 17b (FR-CAT-008 review-round fix): always DRAFT - see
      // CreateCanonicalProductDto's own comment, `status` is no longer
      // accepted from the caller at all.
      const product = await tx.canonicalProduct.create({
        data: {
          brandId: dto.brand_id,
          categoryId: dto.category_id,
          modelName: dto.model_name,
          status: 'DRAFT',
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'canonical_product.created',
          entityType: 'CanonicalProduct',
          entityId: product.id,
          afterState: this.toDto(product),
        },
        tx,
      );

      const body = this.toDto(product);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  @Post(':id/variants')
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async createVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: CreateCanonicalVariantDto,
    @Req() req: Request,
  ) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Sprint 5 (RB-INV-001): the id is generated up front (rather
        // than left to the column's own @default(uuid())) so
        // platformProductBarcode can be derived from it deterministically
        // before the row is inserted - see barcode.util.ts.
        const id = randomUUID();
        const variant = await tx.canonicalProductVariant.create({
          data: {
            id,
            canonicalProductId: productId,
            structuralAttributes:
              dto.structural_attributes as Prisma.InputJsonValue,
            mpn: dto.mpn,
            gtin: dto.gtin,
            platformProductBarcode: generatePlatformProductBarcode(id),
          },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'canonical_product_variant.created',
            entityType: 'CanonicalProductVariant',
            entityId: variant.id,
            afterState: this.variantToDto(variant),
          },
          tx,
        );

        const body = this.variantToDto(variant);
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
          code: 'VARIANT_IDENTIFIER_ALREADY_EXISTS',
          message: 'A variant with this mpn/gtin already exists',
        });
      }
      throw err;
    }
  }

  @Get(':id/variants')
  async listVariants(@Param('id') productId: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const variants = await this.prisma.canonicalProductVariant.findMany({
      where: { canonicalProductId: productId },
      orderBy: { createdAt: 'asc' },
    });
    return variants.map((v) => this.variantToDto(v));
  }

  // Sprint 17b (BL-CAT-003/FR-CAT-007/010/011/012): the "catalog detail
  // polish" fields only - never status (see the dedicated
  // status-transition endpoint) or isRestricted/restrictionReason (see
  // restrict()/unrestrict(), which require a reason).
  @Patch(':id')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCanonicalProductDto,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.canonicalProduct.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const product = await this.prisma.canonicalProduct.update({
      where: { id },
      data: {
        ...(dto.product_type !== undefined && {
          productType: dto.product_type,
        }),
        ...(dto.warranty_period !== undefined && {
          warrantyPeriod: dto.warranty_period,
        }),
        ...(dto.warranty_type !== undefined && {
          warrantyType: dto.warranty_type,
        }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
        ...(dto.seo_title_ar !== undefined && { seoTitleAr: dto.seo_title_ar }),
        ...(dto.seo_title_en !== undefined && { seoTitleEn: dto.seo_title_en }),
        ...(dto.seo_description_ar !== undefined && {
          seoDescriptionAr: dto.seo_description_ar,
        }),
        ...(dto.seo_description_en !== undefined && {
          seoDescriptionEn: dto.seo_description_en,
        }),
      },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'canonical_product.updated',
      entityType: 'CanonicalProduct',
      entityId: id,
      beforeState: this.toDto(existing),
      afterState: this.toDto(product),
    });
    return this.toDto(product);
  }

  // Sprint 17b (FR-CAT-008 review-round fix): the only way to change
  // status - DRAFT -> PENDING_REVIEW -> PUBLISHED -> ARCHIVED, explicit
  // and audited. See CanonicalProductLifecycleService for the full
  // transition table, locking, and rejected-attempt audit mechanics.
  @Post(':id/status-transition')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async transitionStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CanonicalProductStatusTransitionDto,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.canonicalProduct.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const result = await this.prisma.$transaction((tx) =>
      this.lifecycle.attemptTransition(
        tx,
        id,
        dto.to_status,
        user.id,
        req.correlationId,
      ),
    );
    if (result.outcome === 'rejected') {
      throw new UnprocessableEntityException({
        code: 'INVALID_STATUS_TRANSITION',
        message: result.reason,
      });
    }
    return { id, status: result.status };
  }

  // Sprint 17b (FR-CAT-006) - see Category.restrict()'s own comment,
  // identical forward-looking-only semantics applied to the product
  // directly.
  @Post(':id/restrict')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async restrict(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RestrictCanonicalProductDto,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.canonicalProduct.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const product = await this.prisma.canonicalProduct.update({
      where: { id },
      data: { isRestricted: true, restrictionReason: dto.reason },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'canonical_product.restricted',
      entityType: 'CanonicalProduct',
      entityId: id,
      beforeState: { is_restricted: existing.isRestricted },
      afterState: { is_restricted: true, reason: dto.reason },
    });
    return { ...this.toDto(product), restriction_reason: dto.reason };
  }

  @Post(':id/unrestrict')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async unrestrict(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.canonicalProduct.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const product = await this.prisma.canonicalProduct.update({
      where: { id },
      data: { isRestricted: false, restrictionReason: null },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'canonical_product.unrestricted',
      entityType: 'CanonicalProduct',
      entityId: id,
      beforeState: { is_restricted: existing.isRestricted },
      afterState: { is_restricted: false },
    });
    return this.toDto(product);
  }

  // Sprint 17b (FR-MATCH-006): :id is the LOSER (merged away);
  // into_canonical_product_id is the admin-picked survivor. See
  // CanonicalProductMergeService for the full locking/pairing/audit
  // algorithm - zero manual variant mapping, all-or-nothing.
  @Post(':id/merge')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MergeCanonicalProductDto,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction((tx) =>
      this.mergeService.merge(
        tx,
        id,
        dto.into_canonical_product_id,
        user.id,
        req.correlationId,
      ),
    );
    return {
      survivor_id: result.survivorId,
      loser_id: result.loserId,
      merged_variant_pairs: result.mergedVariantPairs,
      repointed_vendor_offer_ids: result.repointedVendorOfferIds,
    };
  }

  // Sprint 17b (FR-MATCH-006/L-24): :id is the SOURCE product; the
  // selected variant_ids move to a brand-new product that always
  // starts DRAFT. Rejected outright (no writes) if it would leave any
  // VendorOffer spanning two canonical products.
  @Post(':id/split')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async split(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SplitCanonicalProductDto,
    @Req() req: Request,
  ) {
    const [brand, category] = await Promise.all([
      this.prisma.brand.findUnique({ where: { id: dto.brand_id } }),
      this.prisma.category.findUnique({ where: { id: dto.category_id } }),
    ]);
    if (!brand) {
      throw new NotFoundException({
        code: 'BRAND_NOT_FOUND',
        message: 'brand_id does not reference an existing brand',
      });
    }
    if (!category) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'category_id does not reference an existing category',
      });
    }
    const result = await this.prisma.$transaction((tx) =>
      this.mergeService.split(
        tx,
        id,
        dto.variant_ids,
        {
          brandId: dto.brand_id,
          categoryId: dto.category_id,
          modelName: dto.model_name,
        },
        user.id,
        req.correlationId,
      ),
    );
    return {
      new_product_id: result.newProductId,
      moved_variant_ids: result.movedVariantIds,
      moved_vendor_offer_ids: result.movedVendorOfferIds,
    };
  }
}
