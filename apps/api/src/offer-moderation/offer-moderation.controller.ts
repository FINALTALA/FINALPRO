import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  PlaceOfferHoldDto,
  RestoreOfferDto,
  ReturnCorrectionDto,
  SubmitCorrectionDto,
} from './offer-moderation.dto';
import { OfferModerationService } from './offer-moderation.service';

const uuid = new ParseUUIDPipe();

/**
 * VIA phase 2C - platform offer moderation, PLATFORM_ADMIN only (a
 * VERIFICATION_REVIEWER reviews store evidence, never catalogue content).
 * Every decision is audited (offer-moderation.service.ts).
 */
@Controller('admin/offers')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminOfferModerationController {
  constructor(private readonly moderation: OfferModerationService) {}

  @Get()
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  list(
    @Query('q') q?: string,
    @Query('hold') hold?: string,
    @Query('vendor_id') vendorId?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.moderation.list({ q, hold, vendorId, status, cursor, limit });
  }

  @Get(':offerId')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  detail(@Param('offerId', uuid) offerId: string) {
    return this.moderation.detail(offerId);
  }

  @Post(':offerId/hold')
  @HttpCode(201)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  placeHold(
    @Param('offerId', uuid) offerId: string,
    @Body() dto: PlaceOfferHoldDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.moderation.placeHold(
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
      offerId,
      dto,
    );
  }

  @Post(':offerId/hold/return-correction')
  @HttpCode(201)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  returnCorrection(
    @Param('offerId', uuid) offerId: string,
    @Body() dto: ReturnCorrectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.moderation.returnCorrection(
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
      offerId,
      dto,
    );
  }

  @Post(':offerId/hold/restore')
  @HttpCode(201)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  restore(
    @Param('offerId', uuid) offerId: string,
    @Body() dto: RestoreOfferDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.moderation.restore(
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
      offerId,
      dto,
    );
  }
}

/**
 * The store's side: the owner sees the hold and its reason, and submits a
 * correction (one exact content revision) for review. Owner only - the
 * same rule as every other catalogue edit. Editing and republishing go
 * through the existing offer screens; neither lifts the hold.
 */
@Controller('vendors/:vendorId/offers/:offerId/platform-hold')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OwnerOfferHoldController {
  constructor(private readonly moderation: OfferModerationService) {}

  @Get()
  @RequireVendorRole('OWNER')
  view(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
  ) {
    return this.moderation.ownerView(vendorId, offerId);
  }

  @Post('correction')
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  submitCorrection(
    @Param('vendorId') vendorId: string,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: SubmitCorrectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.moderation.submitCorrection(
      user.id,
      req.correlationId,
      req.idempotencyClaimId,
      vendorId,
      offerId,
      dto,
    );
  }
}
