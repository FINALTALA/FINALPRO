import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { ReturnDecisionDto } from './dto/return-decision.dto';
import { ReturnsService } from './returns.service';

// Sprint 21: branch-scoped (the decision stays with the ORIGINATING
// branch only - see ReturnsVendorController's own comment for why
// redemption, unlike this, is vendor-wide not branch-scoped).
@Controller('vendors/:vendorId/branches/:branchId/returns')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  async list(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.returns.listForBranch(vendorId, branchId);
  }

  // Sprint 21: ALLOW when the branch is archived - "let an existing
  // return finish," same reasoning as cancel/approve-refund on an
  // existing order (branch-archived-route-classification.ts) - never
  // new footprint, so no @BlockWhenBranchArchived() here.
  @Patch(':returnId/decision')
  @UseInterceptors(IdempotencyInterceptor)
  async decide(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('returnId') returnId: string,
    @Body() dto: ReturnDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.returns.decide(
      vendorId,
      branchId,
      returnId,
      user.id,
      req.correlationId,
      dto,
    );
  }
}
