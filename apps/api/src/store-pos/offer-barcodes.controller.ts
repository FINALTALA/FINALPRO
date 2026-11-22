import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { AddOfferBarcodeDto } from './dto/store-pos.dto';
import { OfferBarcodesService } from './offer-barcodes.service';
import { requireCashierEnabled } from './store-pos.flags';

/**
 * A product's barcodes and the label data (owner only). Writes are catalogue
 * operations - blocked while the store is suspended, like every other
 * catalogue write (vendor-route-classification.ts).
 */
@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class OfferBarcodesController {
  constructor(
    private readonly barcodes: OfferBarcodesService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Get('offers/:offerId/barcodes')
  async list(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.list(vendorId, offerId);
  }

  @BlockWhenSuspended()
  @Post('offers/:offerId/barcodes')
  @HttpCode(201)
  async add(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Body() dto: AddOfferBarcodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.addExternal(vendorId, offerId, dto.code, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }

  @BlockWhenSuspended()
  @Post('offers/:offerId/barcodes/generate')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async generate(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.generate(vendorId, offerId, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }

  @BlockWhenSuspended()
  @Patch('offers/:offerId/barcodes/:barcodeId/primary')
  async setPrimary(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('barcodeId') barcodeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.setPrimary(vendorId, offerId, barcodeId, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }

  @BlockWhenSuspended()
  @Delete('offers/:offerId/barcodes/:barcodeId')
  async remove(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('barcodeId') barcodeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.remove(vendorId, offerId, barcodeId, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }

  /** ?offer_ids=a,b,c&codes=x,y - what the label page prints for each product (by product, or by code). */
  @Get('barcode-labels')
  async labels(
    @Param('vendorId') vendorId: string,
    @Query('offer_ids') offerIdsRaw?: string,
    @Query('codes') codesRaw?: string,
  ) {
    await requireCashierEnabled(this.featureFlags);
    const ids = (offerIdsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    const codes = (codesRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9A-Z-]{4,32}$/.test(s));
    return this.barcodes.labels(vendorId, ids, codes);
  }

  /** The wizard's «إنشاء باركود من النظام»: a free in-store code for a new product's draft. */
  @BlockWhenSuspended()
  @Post('barcodes/reserve')
  @HttpCode(201)
  async reserve(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await requireCashierEnabled(this.featureFlags);
    return this.barcodes.reserve(vendorId, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }
}
