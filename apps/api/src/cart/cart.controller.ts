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
import { bucketForStock } from '../common/availability.util';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertItemsPurchasable } from '../checkout/purchase-eligibility.util';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import {
  CART_LINE_LIMIT,
  assertWithinCartLineLimit,
  lockCartVariant,
} from './cart-line-limit';
import {
  PriceConfig,
  computeEffectivePrice,
} from '../offers/pricing/effective-price.util';

function cartItemDto(item: {
  id: string;
  vendorId: string;
  offerVariantId: string;
  quantity: number;
  offerVariant: PriceConfig & {
    sellerSku: string;
    colorCode?: string | null;
    sizeCode?: string | null;
    size?: string | null;
    offerColor?: {
      nameAr: string;
      nameEn: string | null;
      hex: string | null;
      swatchUrl: string | null;
    } | null;
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
    // Product colours: the line's colour (name + swatch) and size.
    color_code: item.offerVariant.colorCode ?? null,
    color_name_ar: item.offerVariant.offerColor?.nameAr ?? null,
    color_name_en: item.offerVariant.offerColor?.nameEn ?? null,
    color_hex: item.offerVariant.offerColor?.hex ?? null,
    color_swatch_url: item.offerVariant.offerColor?.swatchUrl ?? null,
    size_code: item.offerVariant.sizeCode ?? null,
    size_label: item.offerVariant.size ?? null,
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
    private readonly fulfilment: FulfilmentEligibilityService,
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
          colorCode: true,
          sizeCode: true,
          size: true,
          offerColor: {
            select: { nameAr: true, nameEn: true, hex: true, swatchUrl: true },
          },
          vendorOffer: { select: { titleAr: true, titleEn: true } },
        },
      },
    } as const;
  }

  // Sprint 14 (PDR-017, approved baseline 3.4): the cart is the one
  // surface that may show a quantity limit - each line reports its
  // availability bucket, whether the offer/store is still purchasable,
  // the public per-line `purchase_limit`, and - TB-1 - `max_quantity`
  // ONLY when the line asks for more than it can get: the most ONE
  // branch can fulfil right now (checkout never splits a line), capped
  // at the purchase limit, so the cart never reveals stock above it.
  // Otherwise null. The real stock/eligibility enforcement stays in
  // quote/reserve/confirm.
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
            colorCode: true,
            sizeCode: true,
            size: true,
            offerColor: {
              select: {
                nameAr: true,
                nameEn: true,
                hex: true,
                swatchUrl: true,
              },
            },
            vendorOffer: {
              select: { titleAr: true, titleEn: true, status: true },
            },
            vendor: { select: { storefrontPublished: true, status: true } },
            branchStocks: { select: { branchId: true, quantity: true } },
          },
        },
      },
    });
    // PD-2: the shared read side - sellable branches only, the most ONE
    // branch can supply (checkout never splits a line), and a vendor
    // that can't sell right now (incl. its subscription) gives 0.
    const available = await this.fulfilment.availableByVariant(
      items.map((i) => ({ id: i.offerVariantId, vendorId: i.vendorId })),
    );
    return items.map((item) => {
      const purchasable =
        item.offerVariant.vendorOffer.status === 'ACTIVE' &&
        (available.get(item.offerVariantId)?.purchasable ?? false);
      const stock = purchasable
        ? (available.get(item.offerVariantId)?.maxSingleBranch ?? 0)
        : 0;
      const canGet = Math.min(stock, CART_LINE_LIMIT);
      return {
        ...cartItemDto(item),
        availability: bucketForStock(stock),
        purchase_limit: CART_LINE_LIMIT,
        max_quantity:
          purchasable && stock > 0 && item.quantity > canGet ? canGet : null,
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
      // TB-1: the variant's whole cart total stays within the limit, even
      // under concurrent adds/updates (serialised per customer+variant).
      await lockCartVariant(tx, customerId, dto.offer_variant_id);
      const existing = await tx.cartItem.findUnique({
        where: {
          customerId_vendorId_offerVariantId: {
            customerId,
            vendorId: dto.vendor_id,
            offerVariantId: dto.offer_variant_id,
          },
        },
        select: { id: true, quantity: true },
      });
      await assertWithinCartLineLimit(
        tx,
        customerId,
        dto.offer_variant_id,
        (existing?.quantity ?? 0) + dto.quantity,
        existing?.id ?? null,
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
    const item = await this.prisma.$transaction(async (tx) => {
      // TB-1: same per-variant limit as add, under the same lock.
      await lockCartVariant(tx, customerId, existing.offerVariantId);
      await assertWithinCartLineLimit(
        tx,
        customerId,
        existing.offerVariantId,
        dto.quantity,
        id,
      );
      return tx.cartItem.update({
        where: { id },
        data: { quantity: dto.quantity },
        include: this.itemInclude(),
      });
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
