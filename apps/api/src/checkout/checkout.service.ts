import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import {
  BranchOrderPaymentMethod,
  FulfilmentMethod,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { lockDeliveryWindowRow } from '../delivery-windows/delivery-window-locking.util';
import {
  BranchAvailability,
  GroupingItem,
  groupByVendorAndBranch,
} from './checkout-grouping.util';
import { computeAvailableSlots } from './slot-availability.util';
import { SandboxPaymentService } from './sandbox-payment.service';
import { QuoteCheckoutDto } from './dto/quote-checkout.dto';
import { ReserveCheckoutDto } from './dto/reserve-checkout.dto';

const RESERVATION_TTL_MS = 10 * 60 * 1000;

function effectivePrice(variant: {
  basePrice: unknown;
  salePrice: unknown;
}): number {
  return Number(variant.salePrice ?? variant.basePrice);
}

function utcDateOnly(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function parseDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * Sprint 10 (RB-ORD-003): a region is actually usable for delivery
 * only when BOTH `enabled` is true (Sprint 5's own lazy-default-true
 * convention - no row at all still counts as enabled) AND `fee` has
 * been explicitly set by the owner (never defaulted or inferred - see
 * VendorDeliveryZone's own schema.prisma comment). Centralized here so
 * quote(), reserveDeliverySlot(), and confirm()'s re-validation all
 * agree on exactly the same rule.
 */
function resolveDeliveryFee(
  row: { enabled: boolean; fee: unknown } | null,
): number | null {
  if (!row) return null; // no row = enabled, but never priced yet.
  if (!row.enabled) return null;
  if (row.fee === null || row.fee === undefined) return null;
  return Number(row.fee);
}

function generatePickupCode(): string {
  // Sprint 10 (RB-ORD-004): a courtesy identifier, not a security
  // credential - see BranchOrder.pickupCode's own schema.prisma
  // comment for why no uniqueness/retry-loop is needed.
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

/**
 * Sprint 10 (RB-ORD-002/003/004). See schema.prisma's own Sprint 10
 * section comment for the overall reservation design. Three phases:
 * quote() (read-only preview, no writes at all), reserve() (the real,
 * atomic 10-minute hold - stock AND slot capacity both actually held,
 * not just a signed promise), confirm() (re-validates everything
 * inside one transaction, then creates the real BranchOrders/payment/
 * pickup codes and consumes the reservation).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sandboxPayment: SandboxPaymentService,
  ) {}

  // ============================================================
  // QUOTE - pure read, no reservation, no side effects.
  // ============================================================

  async quote(customerId: string, dto: QuoteCheckoutDto) {
    const cartItems = await this.prisma.cartItem.findMany({
      where: { id: { in: dto.cart_item_ids }, customerId },
      include: {
        offerVariant: {
          select: {
            basePrice: true,
            salePrice: true,
            vendorOffer: { select: { titleAr: true, titleEn: true } },
          },
        },
      },
    });
    if (cartItems.length !== dto.cart_item_ids.length) {
      throw new NotFoundException({
        code: 'CART_ITEM_NOT_FOUND',
        message: 'One or more cart items were not found in your cart',
      });
    }

    const addressRow = dto.address_id
      ? await this.prisma.address.findFirst({
          where: { id: dto.address_id, customerId },
        })
      : null;
    if (dto.address_id && !addressRow) {
      throw new NotFoundException({
        code: 'ADDRESS_NOT_FOUND',
        message: 'Address not found',
      });
    }

    const groupingItems: GroupingItem[] = cartItems.map((ci) => ({
      cartItemId: ci.id,
      vendorId: ci.vendorId,
      offerVariantId: ci.offerVariantId,
      quantity: ci.quantity,
    }));

    const availabilityByVariant =
      await this.buildAvailabilityMap(groupingItems);
    const { groups, unavailableItems } = groupByVendorAndBranch(
      groupingItems,
      availabilityByVariant,
    );

    const cartItemById = new Map(cartItems.map((ci) => [ci.id, ci]));
    const branches = await this.prisma.storeBranch.findMany({
      where: { id: { in: groups.flatMap((g) => g.eligibleBranchIds) } },
    });
    const branchById = new Map(branches.map((b) => [b.id, b]));

    const zoneSettingsByVendor = new Map<
      string,
      { region: string; fee: unknown; enabled: boolean }[]
    >();
    const vendorIds = [...new Set(groups.map((g) => g.vendorId))];
    for (const vendorId of vendorIds) {
      const settings = await this.prisma.vendorDeliveryZone.findMany({
        where: { vendorId },
      });
      zoneSettingsByVendor.set(vendorId, settings);
    }

    const groupDtos = await Promise.all(
      groups.map(async (g) => {
        const items = g.cartItemIds.map((id) => {
          const ci = cartItemById.get(id)!;
          return {
            cart_item_id: ci.id,
            offer_variant_id: ci.offerVariantId,
            title_ar: ci.offerVariant.vendorOffer.titleAr,
            title_en: ci.offerVariant.vendorOffer.titleEn,
            quantity: ci.quantity,
            unit_price: effectivePrice(ci.offerVariant),
          };
        });
        const subtotal = items.reduce(
          (sum, i) => sum + i.unit_price * i.quantity,
          0,
        );
        const eligibleBranches = await Promise.all(
          g.eligibleBranchIds.map(async (branchId) => {
            const branch = branchById.get(branchId)!;
            let deliveryFee: number | null = null;
            if (addressRow?.zone) {
              const setting = zoneSettingsByVendor
                .get(g.vendorId)
                ?.find((s) => s.region === addressRow.zone);
              deliveryFee = resolveDeliveryFee(setting ?? null);
            }
            const availableSlots = await computeAvailableSlots(
              this.prisma,
              g.vendorId,
              branchId,
            );
            return {
              branch_id: branch.id,
              branch_name: branch.name,
              is_physical: branch.isPhysical,
              delivery_fee: deliveryFee,
              available_slots: availableSlots.map((s) => ({
                delivery_window_id: s.deliveryWindowId,
                date: s.date,
                day_of_week: s.dayOfWeek,
                start_time: s.startTime,
                end_time: s.endTime,
                remaining_capacity: s.remainingCapacity,
              })),
            };
          }),
        );
        return {
          vendor_id: g.vendorId,
          cart_item_ids: g.cartItemIds,
          items,
          subtotal,
          fragmented: g.fragmented,
          eligible_branches: eligibleBranches,
          // "Suggested" = first in the deterministic order the
          // grouping util already sorted eligibleBranchIds into - NEVER
          // presented as nearest-by-distance (see
          // checkout-grouping.util.ts's own top comment).
          suggested_branch_id: g.eligibleBranchIds[0] ?? null,
        };
      }),
    );

    return {
      groups: groupDtos,
      unavailable_items: unavailableItems.map((u) => ({
        cart_item_id: u.cartItemId,
        reason: u.reason,
      })),
    };
  }

  private async buildAvailabilityMap(
    items: GroupingItem[],
  ): Promise<Map<string, BranchAvailability[]>> {
    const variantIds = [...new Set(items.map((i) => i.offerVariantId))];
    const stocks = await this.prisma.branchStock.findMany({
      where: { offerVariantId: { in: variantIds } },
    });
    const branchIds = [...new Set(stocks.map((s) => s.branchId))];
    const branches = await this.prisma.storeBranch.findMany({
      where: { id: { in: branchIds } },
    });
    const branchCreatedAtById = new Map(
      branches.map((b) => [b.id, b.createdAt]),
    );

    const map = new Map<string, BranchAvailability[]>();
    for (const stock of stocks) {
      const list = map.get(stock.offerVariantId) ?? [];
      list.push({
        branchId: stock.branchId,
        availableQuantity: stock.quantity - stock.reservedQuantity,
        createdAt: branchCreatedAtById.get(stock.branchId) ?? new Date(0),
      });
      map.set(stock.offerVariantId, list);
    }
    return map;
  }

  // ============================================================
  // RESERVE - the real, atomic 10-minute hold.
  // ============================================================

  async reserve(customerId: string, dto: ReserveCheckoutDto) {
    const branchIds = dto.groups.map((g) => g.branch_id);
    if (new Set(branchIds).size !== branchIds.length) {
      throw new ConflictException({
        code: 'DUPLICATE_BRANCH_IN_CHECKOUT',
        message:
          'Each branch may only appear once across the groups of one checkout',
      });
    }
    const allCartItemIds = dto.groups.flatMap((g) => g.cart_item_ids);
    if (new Set(allCartItemIds).size !== allCartItemIds.length) {
      throw new ConflictException({
        code: 'DUPLICATE_CART_ITEM_IN_CHECKOUT',
        message: 'Each cart item may only appear in one group',
      });
    }

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

    return this.prisma.$transaction(async (tx) => {
      const cartItems = await tx.cartItem.findMany({
        where: { id: { in: allCartItemIds }, customerId },
        include: {
          offerVariant: { select: { basePrice: true, salePrice: true } },
        },
      });
      if (cartItems.length !== allCartItemIds.length) {
        throw new NotFoundException({
          code: 'CART_ITEM_NOT_FOUND',
          message: 'One or more cart items were not found in your cart',
        });
      }
      const cartItemById = new Map(cartItems.map((ci) => [ci.id, ci]));

      const reservation = await tx.checkoutReservation.create({
        data: { customerId, expiresAt },
      });

      for (const group of dto.groups) {
        const branch = await tx.storeBranch.findUnique({
          where: { id: group.branch_id },
        });
        if (!branch) {
          throw new NotFoundException({
            code: 'BRANCH_NOT_FOUND',
            message: 'Branch not found',
          });
        }
        const vendorId = branch.vendorId;

        const groupItems = group.cart_item_ids.map((id) => {
          const ci = cartItemById.get(id);
          if (!ci || ci.vendorId !== vendorId) {
            throw new ConflictException({
              code: 'CART_ITEM_VENDOR_MISMATCH',
              message:
                "A cart item in this group does not belong to the selected branch's vendor",
            });
          }
          return ci;
        });

        if (group.fulfilment_method === 'PICKUP') {
          if (!branch.isPhysical) {
            throw new ConflictException({
              code: 'PICKUP_REQUIRES_PHYSICAL_BRANCH',
              message: 'This branch cannot be used for pickup',
            });
          }
        } else {
          if (
            !group.address_id ||
            !group.delivery_window_id ||
            !group.scheduled_date
          ) {
            throw new ConflictException({
              code: 'DELIVERY_REQUIRES_ADDRESS_AND_SLOT',
              message:
                'A DELIVERY group requires address_id, delivery_window_id, and scheduled_date',
            });
          }
        }

        for (const ci of groupItems) {
          await this.reserveStockUnit(
            tx,
            reservation.id,
            vendorId,
            group.branch_id,
            ci.offerVariantId,
            ci.quantity,
            effectivePrice(ci.offerVariant),
            group.fulfilment_method,
            group.payment_method,
          );
        }

        if (group.fulfilment_method === 'DELIVERY') {
          await this.reserveDeliverySlot(
            tx,
            reservation.id,
            customerId,
            vendorId,
            group.branch_id,
            group.address_id!,
            group.delivery_window_id!,
            group.scheduled_date!,
          );
        }
      }

      return this.reservationSummary(tx, reservation.id);
    });
  }

  private async reserveStockUnit(
    tx: Prisma.TransactionClient,
    reservationId: string,
    vendorId: string,
    branchId: string,
    offerVariantId: string,
    quantity: number,
    unitPrice: number,
    fulfilmentMethod: FulfilmentMethod,
    paymentMethod: BranchOrderPaymentMethod,
  ): Promise<void> {
    // Lock the specific BranchStock row FIRST - every writer of this
    // row (this reserve, checkout confirm's real decrement,
    // InventoryController's POS/manual decrement) takes the same lock
    // on the same row, so they fully serialize against each other.
    const rows = await tx.$queryRaw<
      { id: string; quantity: number; reservedQuantity: number }[]
    >`SELECT id, quantity, "reservedQuantity" FROM branch_stock
      WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
      FOR UPDATE`;
    const stock = rows[0];
    if (!stock) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: 'No stock recorded for this item at the selected branch',
      });
    }

    // Lazily release any of THIS row's expired holds before checking
    // availability - see CheckoutReservation's own schema.prisma
    // comment for why this sweep (not a scheduled job) is how expiry
    // actually takes effect.
    const expired = await tx.checkoutReservationItem.findMany({
      where: {
        vendorId,
        branchId,
        offerVariantId,
        reservation: { expiresAt: { lt: new Date() } },
      },
    });
    let currentlyReserved = stock.reservedQuantity;
    if (expired.length > 0) {
      const releasedQty = expired.reduce((sum, e) => sum + e.quantity, 0);
      await tx.checkoutReservationItem.deleteMany({
        where: { id: { in: expired.map((e) => e.id) } },
      });
      await tx.branchStock.update({
        where: { id: stock.id },
        data: { reservedQuantity: { decrement: releasedQty } },
      });
      currentlyReserved -= releasedQty;
    }

    const available = stock.quantity - currentlyReserved;
    if (available < quantity) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: `Only ${available} unit(s) available for this item at this branch`,
      });
    }

    await tx.branchStock.update({
      where: { id: stock.id },
      data: { reservedQuantity: { increment: quantity } },
    });
    await tx.checkoutReservationItem.create({
      data: {
        reservationId,
        vendorId,
        branchId,
        offerVariantId,
        quantity,
        unitPriceAtReserve: unitPrice,
        fulfilmentMethod,
        paymentMethod,
      },
    });
  }

  private async reserveDeliverySlot(
    tx: Prisma.TransactionClient,
    reservationId: string,
    customerId: string,
    vendorId: string,
    branchId: string,
    addressId: string,
    windowId: string,
    scheduledDateStr: string,
  ): Promise<void> {
    const address = await tx.address.findUnique({ where: { id: addressId } });
    if (!address || address.customerId !== customerId) {
      throw new NotFoundException({
        code: 'ADDRESS_NOT_FOUND',
        message: 'Address not found',
      });
    }
    if (!address.zone) {
      throw new ConflictException({
        code: 'ADDRESS_ZONE_NOT_SET',
        message:
          'This address has no delivery zone set - re-save it with a zone to use delivery',
      });
    }

    const zoneSetting = await tx.vendorDeliveryZone.findUnique({
      where: { vendorId_region: { vendorId, region: address.zone } },
    });
    const deliveryFee = resolveDeliveryFee(zoneSetting);
    if (deliveryFee === null) {
      throw new ConflictException({
        code: 'DELIVERY_NOT_AVAILABLE_IN_ZONE',
        message: 'This vendor does not deliver to your zone',
      });
    }

    const window = await tx.deliveryWindow.findUnique({
      where: { id: windowId },
    });
    if (
      !window ||
      window.vendorId !== vendorId ||
      window.branchId !== branchId
    ) {
      throw new NotFoundException({
        code: 'DELIVERY_WINDOW_NOT_FOUND',
        message: 'Delivery window not found for this branch',
      });
    }
    await lockDeliveryWindowRow(tx, windowId);

    const scheduledDate = parseDateOnly(scheduledDateStr);
    const today = utcDateOnly(new Date());
    const diffDays = Math.round(
      (scheduledDate.getTime() - today.getTime()) / 86_400_000,
    );
    // PDR-023: "the next three days" - today, tomorrow, the day after.
    if (diffDays < 0 || diffDays > 2) {
      throw new ConflictException({
        code: 'INVALID_SLOT_DATE',
        message: 'The slot date must be within the next three days',
      });
    }
    if (scheduledDate.getUTCDay() !== window.dayOfWeek) {
      throw new ConflictException({
        code: 'INVALID_SLOT_DATE',
        message: "This date does not match the window's day of week",
      });
    }

    const exception = await tx.deliveryWindowException.findUnique({
      where: {
        windowId_exceptionDate: { windowId, exceptionDate: scheduledDate },
      },
    });
    if (exception?.isClosed) {
      throw new ConflictException({
        code: 'SLOT_CLOSED',
        message: 'This branch is closed on this date',
      });
    }
    const effectiveCapacity = exception?.capacityOverride ?? window.capacity;

    const expiredSlots = await tx.checkoutReservationSlot.findMany({
      where: {
        deliveryWindowId: windowId,
        scheduledDate,
        reservation: { expiresAt: { lt: new Date() } },
      },
    });
    if (expiredSlots.length > 0) {
      await tx.checkoutReservationSlot.deleteMany({
        where: { id: { in: expiredSlots.map((s) => s.id) } },
      });
    }

    const [activeReservationCount, activeOrderCount] = await Promise.all([
      tx.checkoutReservationSlot.count({
        where: {
          deliveryWindowId: windowId,
          scheduledDate,
          reservation: { expiresAt: { gt: new Date() } },
        },
      }),
      tx.branchOrder.count({
        where: {
          deliveryWindowId: windowId,
          scheduledDate,
          status: { notIn: [...TERMINAL_BRANCH_ORDER_STATUSES] },
        },
      }),
    ]);
    if (activeReservationCount + activeOrderCount >= effectiveCapacity) {
      throw new ConflictException({
        code: 'SLOT_CAPACITY_EXCEEDED',
        message: 'This slot is now fully booked - choose another',
      });
    }

    await tx.checkoutReservationSlot.create({
      data: {
        reservationId,
        vendorId,
        branchId,
        deliveryWindowId: windowId,
        scheduledDate,
        deliveryFeeAtReserve: deliveryFee,
        addressId,
      },
    });
  }

  private async reservationSummary(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ) {
    const reservation = await tx.checkoutReservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: { items: true, slots: true },
    });
    return {
      reservation_id: reservation.id,
      expires_at: reservation.expiresAt.toISOString(),
      items: reservation.items.map((i) => ({
        vendor_id: i.vendorId,
        branch_id: i.branchId,
        offer_variant_id: i.offerVariantId,
        quantity: i.quantity,
        unit_price: Number(i.unitPriceAtReserve),
        fulfilment_method: i.fulfilmentMethod,
        payment_method: i.paymentMethod,
      })),
      slots: reservation.slots.map((s) => ({
        vendor_id: s.vendorId,
        branch_id: s.branchId,
        delivery_window_id: s.deliveryWindowId,
        scheduled_date: s.scheduledDate.toISOString().slice(0, 10),
        delivery_fee: Number(s.deliveryFeeAtReserve),
      })),
    };
  }

  // ============================================================
  // CANCEL - explicit early release, idempotent.
  // ============================================================

  async cancelReservation(
    customerId: string,
    reservationId: string,
  ): Promise<{ released: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.checkoutReservation.findUnique({
        where: { id: reservationId },
        include: { items: true, slots: true },
      });
      if (!reservation || reservation.customerId !== customerId) {
        // Idempotent: cancelling an already-gone (or never-owned)
        // reservation is a benign no-op, not an error - the caller's
        // goal ("this hold should not exist") is already true.
        return { released: false };
      }
      await this.releaseReservationHolds(tx, reservation.items);
      await tx.checkoutReservation.delete({ where: { id: reservationId } });
      return { released: true };
    });
  }

  private async releaseReservationHolds(
    tx: Prisma.TransactionClient,
    items: {
      vendorId: string;
      branchId: string;
      offerVariantId: string;
      quantity: number;
    }[],
  ): Promise<void> {
    for (const item of items) {
      await tx.$executeRaw`SELECT id FROM branch_stock WHERE "vendorId" = ${item.vendorId} AND "branchId" = ${item.branchId} AND "offerVariantId" = ${item.offerVariantId} FOR UPDATE`;
      await tx.branchStock.updateMany({
        where: {
          vendorId: item.vendorId,
          branchId: item.branchId,
          offerVariantId: item.offerVariantId,
        },
        data: { reservedQuantity: { decrement: item.quantity } },
      });
    }
  }

  // ============================================================
  // CONFIRM - re-validate everything, create the real order(s).
  // ============================================================

  async confirm(
    customerId: string,
    reservationId: string,
    actorId: string,
    correlationId: string,
  ) {
    // Expiry is checked (and, if expired, released) in its OWN
    // transaction, committed BEFORE the error is thrown - if this were
    // inside the same transaction as the rejection below, Prisma would
    // roll back the whole thing INCLUDING the release, leaving the
    // stock/slot hold stuck until some unrelated future reserve()
    // happens to sweep it. A rolled-back transaction can never
    // "release, but still fail" atomically; the two have to be
    // separate commits.
    const expiryOutcome = await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.checkoutReservation.findUnique({
        where: { id: reservationId },
        include: { items: true },
      });
      if (!reservation || reservation.customerId !== customerId) {
        return 'not_found' as const;
      }
      if (reservation.expiresAt.getTime() < Date.now()) {
        await this.releaseReservationHolds(tx, reservation.items);
        await tx.checkoutReservation.delete({ where: { id: reservationId } });
        return 'expired' as const;
      }
      return 'ok' as const;
    });
    if (expiryOutcome === 'not_found') {
      throw new NotFoundException({
        code: 'RESERVATION_NOT_FOUND',
        message: 'Reservation not found',
      });
    }
    if (expiryOutcome === 'expired') {
      throw new ConflictException({
        code: 'RESERVATION_EXPIRED',
        message:
          'This checkout hold has expired - please quote and reserve again',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.checkoutReservation.findUnique({
        where: { id: reservationId },
        include: { items: true, slots: true },
      });
      if (!reservation || reservation.customerId !== customerId) {
        // Genuinely rare TOCTOU (e.g. cancelled between the two
        // transactions above) - same response as the first check.
        throw new NotFoundException({
          code: 'RESERVATION_NOT_FOUND',
          message: 'Reservation not found',
        });
      }

      // Re-validate every item's price against what was snapshotted at
      // reserve time - never silently charge a changed price.
      const priceChanges: {
        offer_variant_id: string;
        old_price: number;
        new_price: number;
      }[] = [];
      const variantIds = [
        ...new Set(reservation.items.map((i) => i.offerVariantId)),
      ];
      const variants = await tx.offerVariant.findMany({
        where: { id: { in: variantIds } },
      });
      const variantById = new Map(variants.map((v) => [v.id, v]));
      for (const item of reservation.items) {
        const variant = variantById.get(item.offerVariantId);
        if (!variant) continue;
        const currentPrice = effectivePrice(variant);
        if (currentPrice !== Number(item.unitPriceAtReserve)) {
          priceChanges.push({
            offer_variant_id: item.offerVariantId,
            old_price: Number(item.unitPriceAtReserve),
            new_price: currentPrice,
          });
        }
      }

      const feeChanges: {
        delivery_window_id: string;
        old_fee: number;
        new_fee: number | null;
      }[] = [];
      for (const slot of reservation.slots) {
        const address = await tx.address.findUnique({
          where: { id: slot.addressId },
        });
        const currentSetting = address?.zone
          ? await tx.vendorDeliveryZone.findUnique({
              where: {
                vendorId_region: {
                  vendorId: slot.vendorId,
                  region: address.zone,
                },
              },
            })
          : null;
        const currentFee = resolveDeliveryFee(currentSetting);
        if (
          currentFee === null ||
          currentFee !== Number(slot.deliveryFeeAtReserve)
        ) {
          feeChanges.push({
            delivery_window_id: slot.deliveryWindowId,
            old_fee: Number(slot.deliveryFeeAtReserve),
            new_fee: currentFee,
          });
        }
      }

      if (priceChanges.length > 0 || feeChanges.length > 0) {
        // HttpExceptionFilter's response shape is fixed to
        // {code, message, details, correlation_id} (Part 4, H.1) and
        // drops any other field on the exception body - so the diff
        // itself is encoded directly into `message`, never silently
        // lost, rather than added as a custom field nothing would ever
        // surface to the caller.
        const priceLines = priceChanges.map(
          (c) =>
            `variant ${c.offer_variant_id}: ${c.old_price} -> ${c.new_price}`,
        );
        const feeLines = feeChanges.map(
          (c) =>
            `delivery fee for window ${c.delivery_window_id}: ${c.old_fee} -> ${c.new_fee ?? 'unavailable'}`,
        );
        throw new ConflictException({
          code: 'CHECKOUT_PRICE_CHANGED',
          message: `One or more prices changed since this checkout was reserved: ${[...priceLines, ...feeLines].join('; ')}`,
        });
      }

      // Group reservation items by (vendorId, branchId) - PDR-004: one
      // BranchOrder per branch, and every item in that group already
      // agrees on fulfilment/payment method (see
      // CheckoutReservationItem's own schema.prisma comment).
      const itemsByBranch = new Map<string, typeof reservation.items>();
      for (const item of reservation.items) {
        const key = `${item.vendorId}:${item.branchId}`;
        const list = itemsByBranch.get(key) ?? [];
        list.push(item);
        itemsByBranch.set(key, list);
      }
      const slotByBranchKey = new Map(
        reservation.slots.map((s) => [`${s.vendorId}:${s.branchId}`, s]),
      );

      // Sandbox payment: one transaction for the sum of every
      // ONLINE-paid group's total (PDR-005/RB-ORD-003).
      let onlineTotal = 0;
      for (const [key, items] of itemsByBranch) {
        if (items[0].paymentMethod !== 'ONLINE') continue;
        const subtotal = items.reduce(
          (sum, i) => sum + Number(i.unitPriceAtReserve) * i.quantity,
          0,
        );
        const slot = slotByBranchKey.get(key);
        const deliveryFee = slot ? Number(slot.deliveryFeeAtReserve) : 0;
        onlineTotal += subtotal + deliveryFee;
      }

      const customerOrder = await tx.customerOrder.create({
        data: { customerId },
      });

      let paymentTransactionId: string | null = null;
      if (onlineTotal > 0) {
        const result = await this.sandboxPayment.charge(onlineTotal);
        if (!result.success) {
          throw new ConflictException({
            code: 'PAYMENT_FAILED',
            message: 'The sandbox payment was not successful',
          });
        }
        const transaction = await tx.paymentTransaction.create({
          data: {
            customerOrderId: customerOrder.id,
            amount: onlineTotal,
            status: 'SUCCEEDED',
            sandboxReference: result.reference,
          },
        });
        paymentTransactionId = transaction.id;
      }

      const createdBranchOrders: {
        id: string;
        pickup_code: string | null;
        fulfilment_method: string;
        total: number;
      }[] = [];

      for (const [key, items] of itemsByBranch) {
        const [vendorId, branchId] = key.split(':');
        const fulfilmentMethod = items[0].fulfilmentMethod;
        const paymentMethod = items[0].paymentMethod;
        const slot = slotByBranchKey.get(key);
        const subtotal = items.reduce(
          (sum, i) => sum + Number(i.unitPriceAtReserve) * i.quantity,
          0,
        );
        const deliveryFee = slot ? Number(slot.deliveryFeeAtReserve) : null;
        const total = subtotal + (deliveryFee ?? 0);
        const pickupCode =
          fulfilmentMethod === 'PICKUP' ? generatePickupCode() : null;

        const branchOrder = await tx.branchOrder.create({
          data: {
            customerOrderId: customerOrder.id,
            vendorId,
            branchId,
            deliveryWindowId: slot?.deliveryWindowId,
            scheduledDate: slot?.scheduledDate,
            addressId: slot?.addressId,
            fulfilmentMethod,
            paymentMethod,
            subtotal,
            deliveryFee,
            total,
            pickupCode,
            paymentTransactionId:
              paymentMethod === 'ONLINE' ? paymentTransactionId : null,
          },
        });

        // Real, final stock decrement - the reservation's hold is
        // "spent" here, atomically, against the true physical
        // counter (see reserveStockUnit's own comment on why this is
        // still the authoritative check even though the reservation
        // already held it virtually).
        for (const item of items) {
          const updated = await tx.$queryRaw<{ id: string }[]>`
            UPDATE branch_stock
            SET quantity = quantity - ${item.quantity}, "reservedQuantity" = "reservedQuantity" - ${item.quantity}, "updatedAt" = now()
            WHERE "vendorId" = ${item.vendorId} AND "branchId" = ${item.branchId} AND "offerVariantId" = ${item.offerVariantId}
              AND quantity - ${item.quantity} >= 0 AND "reservedQuantity" - ${item.quantity} >= 0
            RETURNING id
          `;
          if (updated.length === 0) {
            throw new ConflictException({
              code: 'INSUFFICIENT_STOCK',
              message: 'Stock changed unexpectedly - please try again',
            });
          }
          await tx.branchOrderItem.create({
            data: {
              vendorId: item.vendorId,
              branchOrderId: branchOrder.id,
              offerVariantId: item.offerVariantId,
              quantity: item.quantity,
              unitPrice: item.unitPriceAtReserve,
            },
          });
        }

        await this.auditLog.record(
          {
            actorId,
            correlationId,
            action: 'branch_order.created',
            entityType: 'BranchOrder',
            entityId: branchOrder.id,
            afterState: {
              status: branchOrder.status,
              total: Number(branchOrder.total),
              fulfilment_method: branchOrder.fulfilmentMethod,
            },
          },
          tx,
        );

        createdBranchOrders.push({
          id: branchOrder.id,
          pickup_code: pickupCode,
          fulfilment_method: fulfilmentMethod,
          total,
        });
      }

      // Consumed - the cart lines that were actually purchased are
      // removed; anything the customer left unselected at quote time
      // was never part of this reservation and stays untouched.
      const cartItemIdsToRemove = await tx.cartItem.findMany({
        where: {
          customerId,
          vendorId: {
            in: [...new Set(reservation.items.map((i) => i.vendorId))],
          },
          offerVariantId: {
            in: [...new Set(reservation.items.map((i) => i.offerVariantId))],
          },
        },
        select: { id: true, vendorId: true, offerVariantId: true },
      });
      const purchasedKeys = new Set(
        reservation.items.map((i) => `${i.vendorId}:${i.offerVariantId}`),
      );
      const idsToDelete = cartItemIdsToRemove
        .filter((ci) =>
          purchasedKeys.has(`${ci.vendorId}:${ci.offerVariantId}`),
        )
        .map((ci) => ci.id);
      if (idsToDelete.length > 0) {
        await tx.cartItem.deleteMany({ where: { id: { in: idsToDelete } } });
      }

      await tx.checkoutReservation.delete({ where: { id: reservationId } });

      return {
        customer_order_id: customerOrder.id,
        branch_orders: createdBranchOrders,
      };
    });
  }
}
