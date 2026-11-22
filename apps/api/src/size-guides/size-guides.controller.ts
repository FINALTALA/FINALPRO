import { ContentViaEditDraft } from '../offers/content-via-edit-draft.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformRole } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  ChooseSizeGuideDto,
  CreateSizeGuideDto,
  OfferMeasurementsDto,
  DecideSizeGuideRequestDto,
  RenameSizeGuideDto,
  RequestSizeGuideDto,
  SaveDraftDto,
  SetApplicabilityDto,
} from './dto/size-guide.dto';
import {
  DraftInput,
  parseMeasurementsInput,
  SizeGuideRuleError,
} from './size-guide-rules';
import { SizeGuidesService } from './size-guides.service';

const uuid = new ParseUUIDPipe();

/**
 * PD-4: size-guide administration - PLATFORM_ADMIN only (decision:
 * guides are platform data; a store never authors measurements).
 */
@Controller('admin')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminSizeGuidesController {
  constructor(private readonly guides: SizeGuidesService) {}

  @Get('size-guides')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list() {
    return this.guides.list();
  }

  @Get('size-guides/coverage')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  coverage() {
    return this.guides.coverage();
  }

  @Post('size-guides')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreateSizeGuideDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.create(user.id, req.correlationId, dto);
  }

  @Get('size-guides/:id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(@Param('id', uuid) id: string) {
    return this.guides.detail(id);
  }

  @Put('size-guides/:id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  rename(
    @Param('id', uuid) id: string,
    @Body() dto: RenameSizeGuideDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.rename(user.id, req.correlationId, id, dto);
  }

  @Post('size-guides/:id/versions')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  newDraft(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.newDraft(user.id, req.correlationId, id);
  }

  @Put('size-guides/:id/versions/:versionId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  saveDraft(
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Body() dto: SaveDraftDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.saveDraft(
      user.id,
      req.correlationId,
      id,
      versionId,
      dto as unknown as DraftInput,
    );
  }

  @Post('size-guides/:id/versions/:versionId/publish')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  publish(
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.publish(user.id, req.correlationId, id, versionId);
  }

  @Post('size-guides/:id/retire')
  @HttpCode(200)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  retire(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.retire(user.id, req.correlationId, id);
  }

  @Put('size-guides/:id/applicability')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  applicability(
    @Param('id', uuid) id: string,
    @Body() dto: SetApplicabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.setApplicability(
      user.id,
      req.correlationId,
      id,
      dto.pairs,
    );
  }

  @Get('size-guide-requests')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  requests(@Query('status') status?: string) {
    return this.guides.listRequests(
      status === 'PENDING' || status === 'RESOLVED' || status === 'REJECTED'
        ? status
        : undefined,
    );
  }

  @Patch('size-guide-requests/:id')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  decide(
    @Param('id', uuid) id: string,
    @Body() dto: DecideSizeGuideRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.decideRequest(user.id, req.correlationId, id, dto);
  }
}

/**
 * PD-4: the owner's view of an offer's guide, the choice among
 * applicable published guides, and guide requests. OWNER only - a
 * branch employee is refused (decision: no size-guide permission).
 */
@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class OwnerSizeGuidesController {
  constructor(private readonly guides: SizeGuidesService) {}

  @Get('offers/:offerId/size-guide')
  view(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
  ) {
    return this.guides.ownerView(vendorId, offerId);
  }

  @BlockWhenSuspended()
  @Put('offers/:offerId/size-guide')
  @UseInterceptors(IdempotencyInterceptor)
  choose(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: ChooseSizeGuideDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.choose(
      user.id,
      req.correlationId,
      vendorId,
      offerId,
      dto.size_guide_id ?? null,
    );
  }

  @BlockWhenSuspended()
  @Post('offers/:offerId/size-guide-requests')
  @UseInterceptors(IdempotencyInterceptor)
  request(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: RequestSizeGuideDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guides.request(
      user.id,
      req.correlationId,
      vendorId,
      offerId,
      dto.message,
    );
  }

  @Get('size-guide-requests')
  requests(@Param('vendorId') vendorId: string) {
    return this.guides.ownerRequests(vendorId);
  }

  /** Phase A+: the product's own measurements table (cm), what it may hold. */
  @Get('offers/:offerId/measurements')
  measurements(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
  ) {
    return this.guides.offerMeasurements(vendorId, offerId);
  }

  /** Every save after publishing is a new version; orders keep theirs. */
  @BlockWhenSuspended()
  @ContentViaEditDraft()
  @Put('offers/:offerId/measurements')
  saveMeasurements(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: OfferMeasurementsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    let input;
    try {
      input = parseMeasurementsInput(dto.measurements);
    } catch (err) {
      if (err instanceof SizeGuideRuleError)
        throw new BadRequestException({ code: err.code, message: err.message });
      throw err;
    }
    return this.guides.saveOfferMeasurements(
      user.id,
      req.correlationId,
      vendorId,
      offerId,
      input,
    );
  }
}

/** PD-4: public reads - published guides only, never a draft. */
@Controller()
export class PublicSizeGuidesController {
  constructor(private readonly guides: SizeGuidesService) {}

  @Get('storefronts/:slug/offers/:offerId/size-guide')
  forOffer(
    @Param('slug') slug: string,
    @Param('offerId', uuid) offerId: string,
  ) {
    return this.guides.publicForOffer(slug, offerId);
  }

  @Get('size-guides/:id')
  byId(@Param('id', uuid) id: string) {
    return this.guides.publicById(id);
  }
}
