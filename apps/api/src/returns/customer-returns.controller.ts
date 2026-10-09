import {
  Body,
  Controller,
  Get,
  NotFoundException,
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
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitReturnDto } from './dto/submit-return.dto';
import { ReturnsService } from './returns.service';

@Controller('customers/me')
@UseGuards(SessionAuthGuard)
export class CustomerReturnsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly returns: ReturnsService,
  ) {}

  private async requireCustomerId(user: AuthenticatedUser): Promise<string> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
        message: 'Customer profile not found',
      });
    }
    return profile.id;
  }

  @Post('orders/:branchOrderId/items/:itemId/returns')
  @UseInterceptors(IdempotencyInterceptor)
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Param('itemId') itemId: string,
    @Body() dto: SubmitReturnDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.returns.submit(
      customerId,
      branchOrderId,
      itemId,
      {
        reason: dto.reason,
        reason_note: dto.reason_note,
        photo_urls: dto.photo_urls,
      },
      req.correlationId,
    );
  }

  @Get('returns/:returnId')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('returnId') returnId: string,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.returns.getOwnReturn(customerId, returnId);
  }

  @Post('returns/:returnId/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('returnId') returnId: string,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.returns.cancel(customerId, returnId, req.correlationId);
  }

  @Post('returns/:returnId/dispute')
  @UseInterceptors(IdempotencyInterceptor)
  async dispute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('returnId') returnId: string,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.returns.dispute(customerId, returnId, req.correlationId);
  }
}
