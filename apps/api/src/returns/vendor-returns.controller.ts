import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { OrderActorContextInterceptor } from '../orders/order-actor-context.interceptor';
import { BranchReturnQueueService } from './branch-return-queue.service';
import { LookupReturnDto, RedeemReturnDto } from './dto/redeem-return.dto';
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
// IX-P2: the return's timeline shows who received it, as they were then
@UseInterceptors(OrderActorContextInterceptor)
export class VendorReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    private readonly queue: BranchReturnQueueService,
  ) {}

  /**
   * IX-P2: what this code would receive at this branch, BEFORE «استلام» -
   * never writes, never consumes the code, the same who-may-receive-where
   * rule as redeem (checked first). Throttled: a code is a credential, so
   * guessing one by trying many is slowed down here as well.
   */
  @Post('lookup')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async lookup(
    @Param('vendorId') vendorId: string,
    @Body() dto: LookupReturnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.queue.lookup(vendorId, user.id, dto);
  }

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
