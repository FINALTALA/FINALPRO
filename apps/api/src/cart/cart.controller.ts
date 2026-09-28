import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
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
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import {
  bucketForStock,
  liveReservedQuantityByKey,
  maxSingleBranchAvailable,
} from '../common/availability.util';
import { PrismaService } from '../prisma/prisma.service';
import { assertItemsPurchasable } from '../checkout/purchase-eligibility.util';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { PriceConfig, computeEffectivePrice } from '../offers/pricing/effective-price.util';

function cartItemDto(item: {
  id: string;
  vendorId: string;
  offerVariantId: string;
  quantity: number;
  offerVariant: PriceConfig & {
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
    // Sprint 17 (blocker 1): the one shared, read-only price
    // computation - see offers/pricing/effective-price.util.ts.
    unit_price: computeEffectivePrice(item.offerVariant),
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionGate: SubscriptionGateService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

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
          discountPercent: true,
          discountStartAt: true,
          discountEndAt: true,
          sellerSku: true,
          vendorOffer: { select: { titleAr: true, titleEn: true } },
        },
      },
    } as const;
  }

  // Sprint 14 (PDR-017, approved baseline 3.4): the cart is the one
  // surface that may show a quantity limit - each line reports its
  // availability bucket, the maximum currently available to buy
  // (`max_quantity` - the most ONE branch can fulfil, live-reservation
  // aware, since checkout never splits a line across branches; 0 when
  // the line can't be bought at all) and whether the offer/store is still purchasable.
  // Purely additive fields; add/update responses are unchanged, and the
  // real stock/eligibility enforcement stays in quote/reserve/confirm.
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.requireCustomerId(user);
    const items = await this.prisma.cartItem.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        offerVariant: {
          select: {
            basePrice: true,
            salePrice: true,
            discountPercent: true,
            discountStartAt: true,
            discountEndAt: true,
            sellerSku: true,
            vendorOffer: {
              select: { titleAr: true, titleEn: true, status: true },
            },
            vendor: { select: { storefrontPublished: true, status: true } },
            branchStocks: { select: { branchId: true, quantity: true } },
          },
        },
      },
    });
    const liveReserved = await liveReservedQuantityByKey(
      this.prisma,
      items.flatMap((i) =>
        i.offerVariant.branchStocks.map((bs) => ({
          branchId: bs.branchId,
          offerVariantId: i.offerVariantId,
        })),
      ),
    );
    return items.map((item) => {
      const available = maxSingleBranchAvailable(
        item.offerVariant.branchStocks.map((bs) => ({
          branchId: bs.branchId,
          offerVariantId: item.offerVariantId,
          quantity: bs.quantity,
        })),
        liveReserved,
      );
      const purchasable =
        item.offerVariant.vendorOffer.status === 'ACTIVE' &&
        item.offerVariant.vendor.storefrontPublished &&
        item.offerVariant.vendor.status === 'ACTIVE';
      return {
        ...cartItemDto(item),
        availability: bucketForStock(purchasable ? available : 0),
        max_quantity: purchasable ? available : 0,
        purchasable,
      };
    });
  }

  // Adding an already-present (customer, vendor, variant) line
  // increments its quantity rather than creating a duplicate row - the
  // model's own @@unique enforces this is the only possible outcome.
  // Codex review round 2 on commit d0ea80d:
  //  - eligibility (offer/vendor/subscription state) is now checked
  //    here too, not just at checkout - reusing the exact same
  //    predicate quote/reserve/confirm use (assertItemsPurchasable).
  //  - IdempotencyInterceptor + recording completion inside the same
  //    transaction, so a network retry can never double the quantity -
  //    the exact bug flagged in review (a plain upsert's own
  //    `increment` is NOT naturally idempotent on retry).
  @Post('items')
  @UseInterceptors(IdempotencyInterceptor)
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCartItemDto,
    @Req() req: Request,
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

    const responseBody = await this.prisma.$transaction(async (tx) => {
      await assertItemsPurchasable(
        tx,
        this.subscriptionGate,
        req.correlationId,
        [{ vendorId: dto.vendor_id, offerVariantId: dto.offer_variant_id }],
      );
      const item = await tx.cartItem.upsert({
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
      const body = cartItemDto(item);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
    return responseBody;
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
