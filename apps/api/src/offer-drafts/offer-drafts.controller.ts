import { OfferEditDraftsService } from './offer-edit-drafts.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { BrandRequestsService } from './brand-requests.service';
import { OfferDraftsService } from './offer-drafts.service';

export class DraftRevisionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_revision!: number;
}

export class SaveDraftDto extends DraftRevisionDto {
  @IsObject()
  payload!: Record<string, unknown>;
}

/** Edit drafts: the draft revision the seller acted on. */
export class ExpectedRevisionDto {
  @IsInt()
  @Min(1)
  expected_revision!: number;
}

/** Edit drafts: «تحديث المسودة» - for each group changed in both places: 'mine' or 'current'. */
export class RebaseEditDto {
  @IsInt()
  @Min(1)
  expected_revision!: number;

  @IsOptional()
  @IsObject()
  choices?: Record<string, 'mine' | 'current'>;
}

/** Phase A++ (item 2): «نسخ من فرع…» - one atomic change at the current revision. */
export class CopyStockDto {
  @IsInt()
  @Min(1)
  expected_revision!: number;

  @IsUUID()
  from_branch_id!: string;

  @IsUUID()
  to_branch_id!: string;
}

/** Phase A++ (item 1): «نسخ كمنتج جديد» - the source, one of the two. */
export class CopyFromDto {
  @IsOptional()
  @IsUUID()
  offer_id?: string;

  @IsOptional()
  @IsUUID()
  draft_id?: string;
}

/** Wizard phase A: the draft is created with the seller's first real information. */
export class CreateDraftDto {
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /** Phase A++: a new draft copied from one of the store's products or drafts (built by the server). */
  @IsOptional()
  @ValidateNested()
  @Type(() => CopyFromDto)
  copy_from?: CopyFromDto;

  /** Phase A++: copy the colours' images too (default: no - see the wizard's copy dialog). */
  @IsOptional()
  @IsBoolean()
  with_images?: boolean;
}

export class BrandDecisionDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional()
  @IsUUID()
  brand_id?: string;

  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

/**
 * Product-entry wizard drafts (owner only - catalogue editing). Store
 * workspace routes: VendorMembershipGuard (and its workspace token when
 * workspace_scoping_enabled is on); writes are blocked for a suspended
 * store like every other catalogue edit.
 */
export class DraftIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  draft_ids!: string[];
}

export class StoreBarcodeDto {
  @IsString()
  @MaxLength(64)
  code!: string;
}

@Controller('vendors/:vendorId/offer-drafts')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class OfferDraftsController {
  constructor(
    private readonly drafts: OfferDraftsService,
    private readonly edits: OfferEditDraftsService,
  ) {}

  @Get()
  list(@Param('vendorId') vendorId: string) {
    return this.drafts.list(vendorId);
  }

  /**
   * A draft exists only once the seller has entered something real: the
   * wizard sends that first information here as `payload` (phase A) - a
   * panel opened and closed without any leaves nothing behind.
   */
  @Post()
  @HttpCode(201)
  @BlockWhenSuspended()
  create(
    @Param('vendorId') vendorId: string,
    @Body() dto: CreateDraftDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    if (dto.copy_from) {
      return this.drafts.createCopy(
        vendorId,
        user.id,
        req.correlationId,
        dto.copy_from,
        dto.with_images === true,
      );
    }
    return this.drafts.create(
      vendorId,
      user.id,
      req.correlationId,
      dto.payload,
    );
  }

  @Get(':draftId')
  get(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drafts.get(vendorId, draftId, user.id);
  }

  /** Autosave: the whole draft, based on `expected_revision` (409 DRAFT_REVISION_CONFLICT otherwise). */
  @Patch(':draftId')
  @BlockWhenSuspended()
  save(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: SaveDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drafts.save(
      vendorId,
      draftId,
      dto.expected_revision,
      dto.payload,
      user.id,
    );
  }

  @Delete(':draftId')
  @BlockWhenSuspended()
  discard(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Query('expected_revision') expected: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.discard(
      vendorId,
      draftId,
      Number(expected),
      user.id,
      req.correlationId,
    );
  }

  /** Phase A++ (item 2): copy one branch's quantities to another - all or nothing. */
  @Post(':draftId/copy-stock')
  @HttpCode(200)
  @BlockWhenSuspended()
  copyStock(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: CopyStockDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.copyStock(
      vendorId,
      draftId,
      dto.expected_revision,
      dto.from_branch_id,
      dto.to_branch_id,
      user.id,
      req.correlationId,
    );
  }

  /** Phase A++ (item 3): the draft as the shopper's product page will show it (read-only). */
  @Get(':draftId/preview')
  preview(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.drafts.preview(vendorId, draftId);
  }

  /** Edit drafts: «تعديل المنتج» - the product's ONE open edit draft (created, or the existing one). */
  @Post('edit-of/:offerId')
  @BlockWhenSuspended()
  async openEdit(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.edits.open(
      vendorId,
      offerId,
      user.id,
      req.correlationId,
    );
    res.status(r.created ? 201 : 200);
    return r.draft;
  }

  /** Edit drafts: «مراجعة التعديلات» - the groups changed, and any conflict (read-only). */
  @Get(':draftId/review')
  review(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.edits.review(vendorId, draftId);
  }

  /** Edit drafts: «تطبيق التعديلات» - everything in one transaction, or nothing. */
  @Post(':draftId/apply')
  @HttpCode(200)
  @BlockWhenSuspended()
  apply(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: ExpectedRevisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // e2e only (E2E_TEST_SUPPORT=1, never production): fail after a step to prove the rollback
    const failAfter =
      process.env.E2E_TEST_SUPPORT === '1' &&
      process.env.NODE_ENV !== 'production'
        ? (req.headers['x-e2e-edit-fail-after'] as string | undefined)
        : undefined;
    return this.edits.apply(
      vendorId,
      draftId,
      dto.expected_revision,
      user.id,
      req.correlationId,
      failAfter,
    );
  }

  /** Edit drafts: «تحديث المسودة» after a conflict - each group by the seller's explicit choice. */
  @Post(':draftId/rebase')
  @HttpCode(200)
  @BlockWhenSuspended()
  rebase(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: RebaseEditDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.edits.rebase(
      vendorId,
      draftId,
      dto.expected_revision,
      dto.choices ?? {},
      user.id,
      req.correlationId,
    );
  }

  /** Phase A+: what still prevents publishing (read-only). */
  @Get(':draftId/publish-check')
  publishCheck(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.drafts.publishCheck(vendorId, draftId);
  }

  /** Before bulk publishing: one store barcode generated for each chosen draft that has none. */
  @Post('store-barcodes/generate')
  @HttpCode(201)
  @BlockWhenSuspended()
  generateStoreBarcodes(
    @Param('vendorId') vendorId: string,
    @Body() dto: DraftIdsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.generateStoreBarcodes(
      vendorId,
      dto.draft_ids,
      user.id,
      req.correlationId,
    );
  }

  /** Before bulk publishing: the code on the item, for this draft's whole product. */
  @Put(':draftId/store-barcode')
  @BlockWhenSuspended()
  setStoreBarcode(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: StoreBarcodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.setStoreBarcode(
      vendorId,
      draftId,
      dto.code,
      user.id,
      req.correlationId,
    );
  }

  /** Phase A+: creates AND publishes the product, in one transaction - once. */
  @Post(':draftId/publish')
  @HttpCode(201)
  @BlockWhenSuspended()
  publish(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: DraftRevisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.publish(
      vendorId,
      draftId,
      dto.expected_revision,
      user.id,
      req.correlationId,
    );
  }

  /** Creates the product from the draft, in one transaction. */
  @Post(':draftId/submit')
  @HttpCode(201)
  @BlockWhenSuspended()
  submit(
    @Param('vendorId') vendorId: string,
    @Param('draftId') draftId: string,
    @Body() dto: DraftRevisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.drafts.submit(
      vendorId,
      draftId,
      dto.expected_revision,
      user.id,
      req.correlationId,
    );
  }
}

/**
 * Wizard phase A: the owner's own unpublished products and open drafts,
 * for cards inside the store workspace only (owner role; the public pages
 * never call this).
 */
@Controller('vendors/:vendorId/unpublished-products')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class VendorUnpublishedProductsController {
  constructor(private readonly drafts: OfferDraftsService) {}

  @Get()
  list(@Param('vendorId') vendorId: string) {
    return this.drafts.unpublished(vendorId);
  }
}

/** The seller's own brand requests and their state. */
@Controller('vendors/:vendorId/brand-requests')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class VendorBrandRequestsController {
  constructor(private readonly requests: BrandRequestsService) {}

  @Get()
  list(@Param('vendorId') vendorId: string) {
    return this.requests.listForVendor(vendorId);
  }
}

/** Platform administrators decide brand requests. */
@Controller('admin/brand-requests')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminBrandRequestsController {
  constructor(private readonly requests: BrandRequestsService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list(@Query('status') status?: string) {
    return this.requests.listForAdmin(status);
  }

  @Post(':requestId/decision')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  decide(
    @Param('requestId') requestId: string,
    @Body() dto: BrandDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.requests.decide(requestId, user.id, req.correlationId, dto);
  }
}
