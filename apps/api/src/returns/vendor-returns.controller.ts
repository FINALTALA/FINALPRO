import {
  Body,
  Controller,
  Param,
  Post,
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
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { RedeemReturnDto } from './dto/redeem-return.dto';
import { ReturnsService } from './returns.service';

// Sprint 21 (PDR-031 cross-branch acceptance, review-round
// requirement): deliberately NO `:branchId` in this route - the
// shared VendorMembershipGuard only applies its branch-lock check
// when the route itself has a `:branchId` param (verified directly
// against that guard's own code before choosing this design), so
// omitting it here - and ONLY here - lets any OWNER/BRANCH_EMPLOYEE
// of this vendor redeem a code at whichever branch they're actually
// standing in, without touching the guard itself or widening any
// OTHER route's permissions. ReturnsService.redeem() re-verifies
// receiving_branch_id belongs to this exact vendorId as the real BOLA
// guarantee - the guard here is only ever a fast-path, same
// convention as every other transaction-level re-check in this
// codebase.
@Controller('vendors/:vendorId/returns')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post('redeem')
  @UseInterceptors(IdempotencyInterceptor)
  async redeem(
    @Param('vendorId') vendorId: string,
    @Body() dto: RedeemReturnDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.returns.redeem(vendorId, user.id, req.correlationId, dto);
  }
}
