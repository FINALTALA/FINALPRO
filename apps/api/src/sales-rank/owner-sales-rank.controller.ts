import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { SalesRankReadService } from './sales-rank-read.service';

// PD-5.3: a store owner's own sales in the ranking window - their own
// offers only (VendorMembershipGuard scopes :vendorId), no rank among
// other stores. OWNER only: an employee gets 403.
@Controller('vendors/:vendorId/sales-rank')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OwnerSalesRankController {
  constructor(private readonly read: SalesRankReadService) {}

  @Get()
  @RequireVendorRole('OWNER')
  view(@Param('vendorId') vendorId: string) {
    return this.read.ownerView(vendorId);
  }
}
