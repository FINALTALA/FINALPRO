import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CheckoutService } from './checkout.service';
import { ConfirmCheckoutDto } from './dto/confirm-checkout.dto';
import { QuoteCheckoutDto } from './dto/quote-checkout.dto';
import { ReserveCheckoutDto } from './dto/reserve-checkout.dto';

// Sprint 10 (RB-ORD-002): PDR-002 restricts checkout entirely to
// signed-in customers - SessionAuthGuard is the whole boundary, no
// guest path exists to gate separately.
@Controller('checkout')
@UseGuards(SessionAuthGuard)
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly prisma: PrismaService,
  ) {}

  private async requireCustomerId(user: AuthenticatedUser): Promise<string> {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    return profile.id;
  }

  @Post('quote')
  async quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: QuoteCheckoutDto,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.checkoutService.quote(customerId, dto);
  }

  @Post('reserve')
  async reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReserveCheckoutDto,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.checkoutService.reserve(customerId, dto);
  }

  @Post('confirm')
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmCheckoutDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.checkoutService.confirm(
      customerId,
      dto.reservation_id,
      user.id,
      req.correlationId,
    );
  }

  @Post('reservations/:id/cancel')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const customerId = await this.requireCustomerId(user);
    return this.checkoutService.cancelReservation(customerId, id);
  }
}
