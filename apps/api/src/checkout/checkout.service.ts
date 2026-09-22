import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import {
  BranchOrderPaymentMethod,
  FulfilmentMethod,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { lockDeliveryWindowRow } from '../delivery-windows/delivery-window-locking.util';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';
import { groupByVendorAndBranch, GroupingItem } from './checkout-grouping.util';
import { assertItemsPurchasable } from './purchase-eligibility.util';
import { lockAndSweepStockRow } from './stock-lock.util';
import { computeAvailableSlots } from './slot-availability.util';
import { SandboxPaymentService } from './sandbox-payment.service';
import { QuoteCheckoutDto } from './dto/quote-checkout.dto';
import { ReserveCheckoutDto } from './dto/reserve-checkout.dto';

const RESERVATION_TTL_MS = 10 * 60 * 1000;
const PICKUP_CODE_MAX_ATTEMPTS = 10;

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
 * VendorDeliveryZone's own schema.prisma comment).
 */
function resolveDeliveryFee(
  row: { enabled: boolean; fee: unknown } | null,
): number | null {
  if (!row) return null;
  if (!row.enabled) return null;
  if (row.fee === null || row.fee === undefined) return null;
  return Number(row.fee);
}

function generatePickupCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Codex review round 2 on commit d0ea80d (deadlock fix): every
 * transaction that locks more than one BranchStock/DeliveryWindow row
 * must acquire those locks in the EXACT same global order, or two
 * concurrent multi-item/multi-branch checkouts can lock in opposite
 * orders and deadlock. Sorting by these string keys before locking (in
 * reserve()) and before the final decrement (in confirm()) is what
 * makes that order consistent across every caller, regardless of what
 * order the customer's own request happened to list groups/items in.
 */
function stockLockKey(
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): string {
  return `${vendorId}:${branchId}:${offerVariantId}`;
}
function windowLockKey(
  vendorId: string,
  branchId: string,
  windowId: string,
  scheduledDate: string,
): string {
  return `${vendorId}:${branchId}:${windowId}:${scheduledDate}`;
}

interface ResolvedItem {
  cartItemId: string;
  offerVariantId: string;
  quantity: number;
  unitPrice: number;
}
interface ResolvedGroup {
  vendorId: string;
  branchId: string;
  items: ResolvedItem[];
  fulfilmentMethod: FulfilmentMethod;
  paymentMethod: BranchOrderPaymentMethod;
  addressId?: string;
  windowId?: string;
  scheduledDate?: string;
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
    private readonly subscriptionGate: SubscriptionGateService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  // ============================================================
  // QUOTE - pure read, no reservation, no side effects.
  // ============================================================

  async quote(
    customerId: string,
    dto: QuoteCheckoutDto,
    correlationId: string,
  ) {
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

    // Codex review round 2: eligibility (offer/vendor/subscription
    // state) must be checked at quote too, not just reserve/confirm -
    // a stale preview showing a now-unsellable item is misleading.
    // SubscriptionGateService.refreshStatus() itself needs a tx (it
    // may lazily flip an expired subscription's status) - scoped to
    // its own small transaction, separate from the plain reads below,
    // so quote() as a whole is still "no reservation held," just not
    // literally zero writes ever (the same lazy-expiry-on-read pattern
    // this codebase already uses for subscriptions elsewhere).
    await this.prisma.$transaction((tx) =>
      assertItemsPurchasable(
        tx,
        this.subscriptionGate,
        correlationId,
        cartItems.map((ci) => ({
          vendorId: ci.vendorId,
          offerVariantId: ci.offerVariantId,
        })),
      ),
    );

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

  /**
   * Codex review round 2 (lazy-expiry fix): quote must stay read-only,
   * so this ignores the (possibly stale) BranchStock.reservedQuantity
   * counter entirely and instead sums only LIVE (unexpired)
   * CheckoutReservationItem rows directly, batched in one query - the
   * mathematically correct "available right now" figure without
   * taking any lock or writing anything.
   */
  private async buildAvailabilityMap(
    items: GroupingItem[],
  ): Promise<
    Map<
      string,
      { branchId: string; availableQuantity: number; createdAt: Date }[]
    >
  > {
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

    const liveReservations = await this.prisma.checkoutReservationItem.findMany(
      {
        where: {
          offerVariantId: { in: variantIds },
          branchId: { in: branchIds },
          reservation: { expiresAt: { gt: new Date() } },
        },
        select: { branchId: true, offerVariantId: true, quantity: true },
      },
    );
    const liveReservedByKey = new Map<string, number>();
    for (const r of liveReservations) {
      const key = `${r.branchId}:${r.offerVariantId}`;
      liveReservedByKey.set(
        key,
        (liveReservedByKey.get(key) ?? 0) + r.quantity,
      );
    }

    const map = new Map<
      string,
      { branchId: string; availableQuantity: number; createdAt: Date }[]
    >();
    for (const stock of stocks) {
      const key = `${stock.branchId}:${stock.offerVariantId}`;
      const liveReserved = liveReservedByKey.get(key) ?? 0;
      const list = map.get(stock.offerVariantId) ?? [];
      list.push({
        branchId: stock.branchId,
        availableQuantity: stock.quantity - liveReserved,
        createdAt: branchCreatedAtById.get(stock.branchId) ?? new Date(0),
      });
      map.set(stock.offerVariantId, list);
    }
    return map;
  }

  // ============================================================
  // RESERVE - the real, atomic 10-minute hold.
  // ============================================================

  async reserve(
    customerId: string,
    dto: ReserveCheckoutDto,
    correlationId: string,
    idempotencyClaimId: string | undefined,
  ) {
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

      // Phase 1: resolve every group (read-only validation, no locks yet).
      const resolvedGroups: ResolvedGroup[] = [];
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
        const items: ResolvedItem[] = group.cart_item_ids.map((id) => {
          const ci = cartItemById.get(id);
          if (!ci || ci.vendorId !== vendorId) {
            throw new ConflictException({
              code: 'CART_ITEM_VENDOR_MISMATCH',
              message:
                "A cart item in this group does not belong to the selected branch's vendor",
            });
          }
          return {
            cartItemId: id,
            offerVariantId: ci.offerVariantId,
            quantity: ci.quantity,
            unitPrice: effectivePrice(ci.offerVariant),
          };
        });

        if (group.fulfilment_method === 'PICKUP') {
          if (!branch.isPhysical) {
            throw new ConflictException({
              code: 'PICKUP_REQUIRES_PHYSICAL_BRANCH',
              message: 'This branch cannot be used for pickup',
            });
          }
        } else if (
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

        resolvedGroups.push({
          vendorId,
          branchId: branch.id,
          items,
          fulfilmentMethod: group.fulfilment_method,
          paymentMethod: group.payment_method,
          addressId: group.address_id,
          windowId: group.delivery_window_id,
          scheduledDate: group.scheduled_date,
        });
      }

      // Eligibility - every item, before any lock is taken.
      await assertItemsPurchasable(
        tx,
        this.subscriptionGate,
        correlationId,
        resolvedGroups.flatMap((g) =>
          g.items.map((i) => ({
            vendorId: g.vendorId,
            offerVariantId: i.offerVariantId,
          })),
        ),
      );

      // Phase 2: lock EVERY stock row, then EVERY window row, both in
      // canonical order - see stockLockKey/windowLockKey's own comment
      // for why this ordering is what actually prevents deadlock.
      const stockKeys = new Map<
        string,
        { vendorId: string; branchId: string; offerVariantId: string }
      >();
      for (const g of resolvedGroups) {
        for (const item of g.items) {
          stockKeys.set(
            stockLockKey(g.vendorId, g.branchId, item.offerVariantId),
            {
              vendorId: g.vendorId,
              branchId: g.branchId,
              offerVariantId: item.offerVariantId,
            },
          );
        }
      }
      const sortedStockKeys = [...stockKeys.keys()].sort();

      const windowIdByKey = new Map<string, string>();
      for (const g of resolvedGroups) {
        if (g.fulfilmentMethod === 'DELIVERY') {
          windowIdByKey.set(
            windowLockKey(
              g.vendorId,
              g.branchId,
              g.windowId!,
              g.scheduledDate!,
            ),
            g.windowId!,
          );
        }
      }
      const sortedWindowIds = [...new Set([...windowIdByKey.values()])].sort();

      const lockedStock = new Map<
        string,
        { id: string; quantity: number; reservedQuantity: number }
      >();
      for (const key of sortedStockKeys) {
        const { vendorId, branchId, offerVariantId } = stockKeys.get(key)!;
        const locked = await lockAndSweepStockRow(
          tx,
          vendorId,
          branchId,
          offerVariantId,
        );
        if (!locked) {
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: 'No stock recorded for this item at the selected branch',
          });
        }
        lockedStock.set(key, locked);
      }
      for (const windowId of sortedWindowIds) {
        await lockDeliveryWindowRow(tx, windowId);
      }

      // Phase 3: locks held - check availability and write.
      const reservation = await tx.checkoutReservation.create({
        data: { customerId, expiresAt },
      });

      for (const g of resolvedGroups) {
        for (const item of g.items) {
          const key = stockLockKey(g.vendorId, g.branchId, item.offerVariantId);
          const stock = lockedStock.get(key)!;
          const available = stock.quantity - stock.reservedQuantity;
          if (available < item.quantity) {
            throw new ConflictException({
              code: 'INSUFFICIENT_STOCK',
              message: `Only ${available} unit(s) available for this item at this branch`,
            });
          }
          await tx.branchStock.update({
            where: { id: stock.id },
            data: { reservedQuantity: { increment: item.quantity } },
          });
          stock.reservedQuantity += item.quantity;
          await tx.checkoutReservationItem.create({
            data: {
              reservationId: reservation.id,
              vendorId: g.vendorId,
              branchId: g.branchId,
              offerVariantId: item.offerVariantId,
              quantity: item.quantity,
              unitPriceAtReserve: item.unitPrice,
              fulfilmentMethod: g.fulfilmentMethod,
              paymentMethod: g.paymentMethod,
              cartItemId: item.cartItemId,
            },
          });
        }

        if (g.fulfilmentMethod === 'DELIVERY') {
          await this.reserveDeliverySlotAlreadyLocked(
            tx,
            reservation.id,
            customerId,
            g.vendorId,
            g.branchId,
            g.addressId!,
            g.windowId!,
            g.scheduledDate!,
          );
        }
      }

      const responseBody = await this.reservationSummary(tx, reservation.id);
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        responseBody,
        201,
      );
      return responseBody;
    });
  }

  /**
   * Assumes the caller already locked this window row (in canonical
   * order, alongside every other lock this transaction needs) - see
   * reserve()'s own Phase 2 comment.
   */
  private async reserveDeliverySlotAlreadyLocked(
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

    const scheduledDate = parseDateOnly(scheduledDateStr);
    const today = utcDateOnly(new Date());
    const diffDays = Math.round(
      (scheduledDate.getTime() - today.getTime()) / 86_400_000,
    );
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
    // Canonical order - see stockLockKey's own comment.
    const sorted = [...items].sort((a, b) => {
      const ka = stockLockKey(a.vendorId, a.branchId, a.offerVariantId);
      const kb = stockLockKey(b.vendorId, b.branchId, b.offerVariantId);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (const item of sorted) {
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
    idempotencyClaimId: string | undefined,
  ) {
    // Expiry is checked (and, if expired, released) in its OWN
    // transaction, committed BEFORE the error is thrown - see this
    // method's own long-standing comment (unchanged from commit
    // d0ea80d): a rolled-back transaction can never "release, but
    // still fail" atomically.
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
        throw new NotFoundException({
          code: 'RESERVATION_NOT_FOUND',
          message: 'Reservation not found',
        });
      }

      // Codex review round 2: eligibility can change DURING the
      // 10-minute hold (owner unpublishes, offer goes DRAFT,
      // subscription lapses) - re-check at confirm, not just reserve.
      await assertItemsPurchasable(
        tx,
        this.subscriptionGate,
        correlationId,
        reservation.items.map((i) => ({
          vendorId: i.vendorId,
          offerVariantId: i.offerVariantId,
        })),
      );

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

      // Codex review round 2 (deadlock fix): the real decrement locks
      // one row per statement - sort ALL items by canonical stock key
      // FIRST, decrement in that global order, before any BranchOrder
      // is created, so lock-acquisition order never depends on how the
      // items happened to group by branch.
      const sortedItems = [...reservation.items].sort((a, b) => {
        const ka = stockLockKey(a.vendorId, a.branchId, a.offerVariantId);
        const kb = stockLockKey(b.vendorId, b.branchId, b.offerVariantId);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const item of sortedItems) {
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
      }

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

        const baseData = {
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
          paymentTransactionId:
            paymentMethod === 'ONLINE' ? paymentTransactionId : null,
        };

        const branchOrder =
          fulfilmentMethod === 'PICKUP'
            ? await this.createPickupBranchOrderWithRetry(tx, baseData)
            : await tx.branchOrder.create({
                data: { ...baseData, pickupCode: null },
              });

        for (const item of items) {
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
          pickup_code: branchOrder.pickupCode,
          fulfilment_method: fulfilmentMethod,
          total,
        });
      }

      // Codex review round 2 (fix #2): decrement only the RESERVED
      // amount from the ORIGINAL cart line (tracked via cartItemId at
      // reserve time), never bulk-delete by vendor+variant match - a
      // customer who raised this line's quantity during the hold keeps
      // the extra, never-reserved units. Two conditional statements,
      // not one: cart_items.quantity has its own CHECK (quantity > 0),
      // so an UPDATE can never be the one to write it down to exactly
      // zero - the first statement only succeeds when positive
      // quantity remains; if it matches nothing, the line is either
      // already gone or exactly (or over-)consumed, and the second,
      // separately-scoped DELETE removes it in precisely that case (a
      // concurrent quantity bump between the two re-evaluates fresh
      // under this same transaction's snapshot, so it's never wrongly
      // deleted). If the line was deleted or its quantity dropped
      // below what's being reconciled, both statements simply match
      // zero rows: the cart is secondary bookkeeping that must never
      // block a valid checkout.
      for (const item of reservation.items) {
        if (!item.cartItemId) continue;
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE cart_items
          SET quantity = quantity - ${item.quantity}, "updatedAt" = now()
          WHERE id = ${item.cartItemId} AND quantity - ${item.quantity} > 0
          RETURNING id
        `;
        if (updated.length === 0) {
          await tx.cartItem.deleteMany({
            where: { id: item.cartItemId, quantity: { lte: item.quantity } },
          });
        }
      }

      await tx.checkoutReservation.delete({ where: { id: reservationId } });

      const responseBody = {
        customer_order_id: customerOrder.id,
        branch_orders: createdBranchOrders,
      };
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        responseBody,
        201,
      );
      return responseBody;
    });
  }

  /**
   * Codex review round 2 (fix #7): a partial unique index on
   * (branchId, pickupCode) for active PICKUP orders (see
   * BranchOrder.pickupCode's own schema.prisma comment) makes a
   * collision a real, if rare, possibility - retried with a fresh
   * random code rather than ever surfacing the raw unique-violation.
   *
   * Found via the round-2 collision e2e test: a plain try/catch around
   * tx.branchOrder.create() is NOT enough - Postgres aborts the WHOLE
   * transaction the instant one statement errors (25P02, "current
   * transaction is aborted"), so a caught P2002 still leaves every
   * later statement on this same `tx` failing until a rollback happens.
   * Each attempt is wrapped in its own SAVEPOINT so a collision only
   * rolls back that one failed INSERT, not the entire confirm()
   * transaction (the BranchOrders/stock decrements already written for
   * OTHER branches in this same checkout must survive).
   */
  private async createPickupBranchOrderWithRetry(
    tx: Prisma.TransactionClient,
    baseData: Prisma.BranchOrderUncheckedCreateInput,
  ) {
    for (let attempt = 0; attempt < PICKUP_CODE_MAX_ATTEMPTS; attempt++) {
      await tx.$executeRaw`SAVEPOINT pickup_code_attempt`;
      try {
        const order = await tx.branchOrder.create({
          data: { ...baseData, pickupCode: generatePickupCode() },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT pickup_code_attempt`;
        return order;
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT pickup_code_attempt`;
        if (isUniqueViolation(err) && attempt < PICKUP_CODE_MAX_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      'unreachable: pickup code retry loop exhausted without returning or throwing',
    );
  }
}
