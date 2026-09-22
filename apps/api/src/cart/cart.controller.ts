import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

function cartItemDto(item: {
  id: string;
  vendorId: string;
  offerVariantId: string;
  quantity: number;
  offerVariant: {
    basePrice: unknown;
    salePrice: unknown;
    sellerSku: string;
    vendorOffer: { titleAr: string; titleEn: string };
  };
}) {
  return {
    id: item.id,
    vendor_id: item.vendorId,
    offer_variant_id: item.offerVariantId,
    quantity: item.quantity,
    title_ar: item.offerVariant.vendorOffer.titleAr,
    title_en: item.offerVariant.vendorOffer.titleEn,
    // Same "salePrice wins if present, else basePrice" rule as
    // discovery/comparison (comparison.service.ts) - the one source of
    // truth for "current price" this codebase already established.
    unit_price: Number(
      item.offerVariant.salePrice ?? item.offerVariant.basePrice,
    ),
  };
}

// Sprint 10 (PDR-002/003): a signed-in customer's server-side cart.
// Deliberately no fulfilment/branch concept here at all - that's
// chosen at checkout (RB-ORD-002), not add-to-cart. PDR-002 restricts
// cart entirely to signed-in customers - SessionAuthGuard is the whole
// boundary; there is no guest cart anywhere in this codebase to merge.
@Controller('cart')
@UseGuards(SessionAuthGuard)
export class CartController {
  constructor(private readonly prisma: PrismaService) {}

  private async requireCustomerId(user: AuthenticatedUser): Promise<string> {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    return profile.id;
  }

  private itemInclude() {
    return {
      offerVariant: {
        select: {
          basePrice: true,
          salePrice: true,
          sellerSku: true,
          vendorOffer: { select: { titleAr: true, titleEn: true } },
        },
      },
    } as const;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.requireCustomerId(user);
    const items = await this.prisma.cartItem.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: this.itemInclude(),
    });
    return items.map(cartItemDto);
  }

  // Adding an already-present (customer, vendor, variant) line
  // increments its quantity rather than creating a duplicate row - the
  // model's own @@unique enforces this is the only possible outcome.
  @Post('items')
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCartItemDto,
  ) {
    const customerId = await this.requireCustomerId(user);
    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: dto.offer_variant_id },
    });
    if (!variant || variant.vendorId !== dto.vendor_id) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found for this vendor',
      });
    }

    const item = await this.prisma.cartItem.upsert({
      where: {
        customerId_vendorId_offerVariantId: {
          customerId,
          vendorId: dto.vendor_id,
          offerVariantId: dto.offer_variant_id,
        },
      },
      create: {
        customerId,
        vendorId: dto.vendor_id,
        offerVariantId: dto.offer_variant_id,
        quantity: dto.quantity,
      },
      update: { quantity: { increment: dto.quantity } },
      include: this.itemInclude(),
    });
    return cartItemDto(item);
  }

  @Put('items/:id')
  async updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    const customerId = await this.requireCustomerId(user);
    const existing = await this.prisma.cartItem.findUnique({ where: { id } });
    if (!existing || existing.customerId !== customerId) {
      throw new NotFoundException({
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Cart item not found',
      });
    }
    const item = await this.prisma.cartItem.update({
      where: { id },
      data: { quantity: dto.quantity },
      include: this.itemInclude(),
    });
    return cartItemDto(item);
  }

  @Delete('items/:id')
  async removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const customerId = await this.requireCustomerId(user);
    const existing = await this.prisma.cartItem.findUnique({ where: { id } });
    if (!existing || existing.customerId !== customerId) {
      throw new NotFoundException({
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Cart item not found',
      });
    }
    await this.prisma.cartItem.delete({ where: { id } });
    return { deleted: true };
  }
}
