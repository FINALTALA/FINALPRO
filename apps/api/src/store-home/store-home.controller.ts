import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
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
import {
  SaveStoreHomeDraftDto,
  StoreHomeVersionDto,
} from './dto/store-home.dto';
import { StoreHomeService } from './store-home.service';

// «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the owner's home page
// designer. Owner-only, per method (VendorMembershipGuard reads
// @RequireVendorRole from the handler) - an employee never edits the store's
// page. Editing it is storefront editing: a suspended store can read it but
// not change it (vendor-route-classification.ts).
@Controller('vendors/:vendorId/storefront/home')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StoreHomeController {
  constructor(private readonly home: StoreHomeService) {}

  @Get()
  @RequireVendorRole('OWNER')
  async get(@Param('vendorId') vendorId: string) {
    await this.home.requireEnabled();
    return this.home.ownerView(vendorId);
  }

  /** «اختيار المنتجات» for a «منتجات مختارة» block or a button's product. */
  @Get('products')
  @RequireVendorRole('OWNER')
  async products(
    @Param('vendorId') vendorId: string,
    @Query('q') q: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    await this.home.requireEnabled();
    return this.home.products(vendorId, q, page);
  }

  /** The autosave: the whole draft document, with the version it was based on. */
  @BlockWhenSuspended()
  @Put('draft')
  @RequireVendorRole('OWNER')
  async saveDraft(
    @Param('vendorId') vendorId: string,
    @Body() dto: SaveStoreHomeDraftDto,
  ) {
    await this.home.requireEnabled();
    return this.home.saveDraft(vendorId, dto.version, dto.layout);
  }

  @BlockWhenSuspended()
  @Post('publish')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async publish(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StoreHomeVersionDto,
    @Req() req: Request,
  ) {
    await this.home.requireEnabled();
    return this.home.publish(vendorId, dto.version, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }

  @BlockWhenSuspended()
  @Post('discard')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async discard(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StoreHomeVersionDto,
    @Req() req: Request,
  ) {
    await this.home.requireEnabled();
    return this.home.discard(vendorId, dto.version, {
      userId: user.id,
      correlationId: req.correlationId,
    });
  }
}
