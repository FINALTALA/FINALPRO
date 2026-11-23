import { BadRequestException, Injectable } from '@nestjs/common';
import {
  loadOpeningStates,
  type OpeningState,
} from '../common/branch-opening.util';
import { DeliveryZoneRegion, Prisma } from '../../generated/prisma/client';
import {
  AvailabilityBucket,
  bucketForStock,
  liveReservedQuantityByKey,
} from '../common/availability.util';
import { resolveDeliveryFee } from '../checkout/delivery-fee.util';
import {
  normalizeMinimumOrderValue,
  resolveDeliveryMinimumOrderValue,
} from '../checkout/minimum-order.util';
import {
  computeAvailableSlots,
  SlotOption,
} from '../checkout/slot-availability.util';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';

// PD-2 (docs/srs/10-product-detail-enhancement-roadmap.md, PD-FR-004):
// the ONE server-side source of "can this variant be delivered / picked
// up right now, and how much of it is there". Checkout's quote/reserve,
// the cart, the product page, the store comparison and every public card
// (catalogue, discovery, home, men/women/kids, following, favourites)
// read it, so a page can never promise a path checkout refuses. Reserve
// still re-checks everything under its locks - this is the read side.

export const ZONES: DeliveryZoneRegion[] = ['WEST_BANK', 'JERUSALEM', 'INSIDE'];

/**
 * A branch can take a NEW order only while approved, not archived and
 * not under a temporary closure right now. Reserve applies this same
 * predicate under its branch lock.
 */
export function isBranchSellable(
  branch: { verificationStatus: string; archivedAt: Date | null },
  closedNow: boolean,
): boolean {
  return (
    branch.verificationStatus === 'APPROVED' &&
    branch.archivedAt === null &&
    !closedNow
  );
}

/** Live stock of one variant in one sellable branch (never public). */
export interface SellableStock {
  branchId: string;
  branchName: string;
  isPhysical: boolean;
  branchCreatedAt: Date;
  minimumOrderValue: number | null;
  /** quantity - live checkout holds, floored at 0. */
  available: number;
}

/** A variant's public availability: what its cards and cart lines show. */
export interface VariantAvailability {
  /** The vendor can take an order right now. */
  purchasable: boolean;
  /** Sum over sellable branches (the availability bucket). */
  total: number;
  /** The most one branch can supply (one cart line's maximum). */
  maxSingleBranch: number;
}

export type DeliveryStatus =
  | 'AVAILABLE'
  | 'NO_ZONE_SELECTED'
  | 'NOT_IN_ZONE'
  | 'NO_UPCOMING_SLOTS'
  | 'NO_ELIGIBLE_STOCK'
  | 'NOT_OFFERED'
  | 'NOT_PURCHASABLE';
export type PickupStatus =
  'AVAILABLE' | 'NO_PICKUP_BRANCH_WITH_STOCK' | 'NOT_PURCHASABLE';

/** The public, quantity-free fulfilment facts of one variant. */
export interface VariantFulfilment {
  availability: AvailabilityBucket;
  delivery: {
    status: DeliveryStatus;
    fee: number | null;
    minimum_order_value: number | null;
    earliest_slot_date: string | null;
    /** PD-5.1: the earliest bookable window itself (date + hours). */
    earliest_slot: {
      date: string;
      start_time: string;
      end_time: string;
    } | null;
    /** PD-5.1: the last calendar day with a bookable window, when later
     * than the earliest one ("ومواعيد أخرى حتى …"), else null. */
    latest_slot_date: string | null;
  };
  pickup: {
    status: PickupStatus;
    branches: {
      name: string;
      minimum_order_value: number | null;
      /** PD-5.1: the branch has opening hours set at all (a branch with
       * none says nothing - "not set" is not "closed"). */
      hours_set: boolean;
      /** PD-5.1 + «ساعات العمل والإغلاقات v1»: today's periods in
       * Palestine (several a day); empty = closed today (or no hours set). */
      hours_today: { open: string; close: string }[];
      /** v1: open now / until when / next opening (a closure always wins);
       * informational - pickup is never refused by hours. null = no hours. */
      opening: OpeningState | null;
    }[];
  };
}

/** «ساعات العمل والإغلاقات v1»: one pickup branch's hours today + state. */
export interface BranchHoursToday {
  periods: { open: string; close: string }[];
  opening: OpeningState;
}

/** One branch's bookable delivery windows, earliest first. */
interface BranchSlots {
  earliest: SlotOption | null;
  latestDate: string | null;
}

export interface ZoneChoice {
  zone: DeliveryZoneRegion | null;
  zone_source: 'REQUEST' | 'DEFAULT_ADDRESS' | 'NONE';
  default_zone: DeliveryZoneRegion | null;
}

@Injectable()
export class FulfilmentEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionGate: SubscriptionGateService,
  ) {}

  /**
   * Per variant: its stock rows in SELLABLE branches only, live holds
   * subtracted. The same rows checkout's grouping chooses a branch from.
   */
  async stockByVariant(
    variantIds: string[],
    db: Prisma.TransactionClient = this.prisma,
    now: Date = new Date(),
  ): Promise<Map<string, SellableStock[]>> {
    const result = new Map<string, SellableStock[]>();
    const ids = [...new Set(variantIds)];
    if (ids.length === 0) return result;
    const stocks = await db.branchStock.findMany({
      where: { offerVariantId: { in: ids } },
      select: {
        branchId: true,
        offerVariantId: true,
        quantity: true,
        branch: {
          select: {
            name: true,
            isPhysical: true,
            verificationStatus: true,
            archivedAt: true,
            createdAt: true,
            minimumOrderValue: true,
          },
        },
      },
    });
    const branchIds = [...new Set(stocks.map((s) => s.branchId))];
    const closures = branchIds.length
      ? await db.branchClosure.findMany({
          where: {
            branchId: { in: branchIds },
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          select: { branchId: true },
        })
      : [];
    const closed = new Set(closures.map((c) => c.branchId));
    const sellable = stocks.filter((s) =>
      isBranchSellable(s.branch, closed.has(s.branchId)),
    );
    const reserved = await liveReservedQuantityByKey(
      db,
      sellable.map((s) => ({
        branchId: s.branchId,
        offerVariantId: s.offerVariantId,
      })),
    );
    for (const s of sellable) {
      const list = result.get(s.offerVariantId) ?? [];
      list.push({
        branchId: s.branchId,
        branchName: s.branch.name,
        isPhysical: s.branch.isPhysical,
        branchCreatedAt: s.branch.createdAt,
        minimumOrderValue: normalizeMinimumOrderValue(
          s.branch.minimumOrderValue,
        ),
        available: Math.max(
          0,
          s.quantity - (reserved.get(`${s.branchId}:${s.offerVariantId}`) ?? 0),
        ),
      });
      result.set(s.offerVariantId, list);
    }
    // Checkout's deterministic branch order: oldest branch first, then id.
    for (const list of result.values()) {
      list.sort(
        (a, b) =>
          a.branchCreatedAt.getTime() - b.branchCreatedAt.getTime() ||
          (a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0),
      );
    }
    return result;
  }

  /**
   * The vendors whose offers can be bought right now: published, ACTIVE,
   * and an effectively ACTIVE subscription (read-only peek, exactly as
   * quote() checks it - never persists a lapse).
   */
  async purchasableVendorIds(
    vendorIds: string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Set<string>> {
    const ids = [...new Set(vendorIds)];
    const result = new Set<string>();
    if (ids.length === 0) return result;
    const vendors = await db.vendor.findMany({
      where: { id: { in: ids }, storefrontPublished: true, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const v of vendors) {
      if (
        (await this.subscriptionGate.peekEffectiveStatus(db, v.id)) === 'ACTIVE'
      ) {
        result.add(v.id);
      }
    }
    return result;
  }

  /**
   * What every public card shows: per variant, the total sellable
   * quantity (for the bucket) and the most one branch can supply (what
   * one cart line can get). 0 for a vendor that can't sell right now.
   */
  async availableByVariant(
    variants: { id: string; vendorId: string }[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, VariantAvailability>> {
    const [stock, purchasable] = await Promise.all([
      this.stockByVariant(
        variants.map((v) => v.id),
        db,
      ),
      this.purchasableVendorIds(
        variants.map((v) => v.vendorId),
        db,
      ),
    ]);
    const result = new Map<string, VariantAvailability>();
    for (const v of variants) {
      const canSell = purchasable.has(v.vendorId);
      const rows = canSell ? (stock.get(v.id) ?? []) : [];
      result.set(v.id, {
        purchasable: canSell,
        total: rows.reduce((n, r) => n + r.available, 0),
        maxSingleBranch: rows.reduce((m, r) => Math.max(m, r.available), 0),
      });
    }
    return result;
  }

  /** The signed-in customer's default address zone (never GPS). */
  async defaultZone(userId: string | null): Promise<DeliveryZoneRegion | null> {
    if (!userId) return null;
    const address = await this.prisma.address.findFirst({
      where: { customer: { userId }, isDefault: true, archivedAt: null },
      select: { zone: true },
    });
    return address?.zone ?? null;
  }

  /** An explicit `zone` (or ALL) wins over the default address zone. */
  async resolveZone(
    raw: string | undefined,
    userId: string | null,
  ): Promise<ZoneChoice> {
    const defaultZone = await this.defaultZone(userId);
    const value = raw?.trim().toUpperCase();
    if (value) {
      if (value === 'ALL') {
        return {
          zone: null,
          zone_source: 'REQUEST',
          default_zone: defaultZone,
        };
      }
      const zone = ZONES.find((z) => z === value);
      if (!zone) {
        throw new BadRequestException({
          code: 'INVALID_ZONE',
          message: `zone must be one of ALL, ${ZONES.join(', ')}`,
        });
      }
      return { zone, zone_source: 'REQUEST', default_zone: defaultZone };
    }
    return defaultZone
      ? {
          zone: defaultZone,
          zone_source: 'DEFAULT_ADDRESS',
          default_zone: defaultZone,
        }
      : { zone: null, zone_source: 'NONE', default_zone: null };
  }

  /** Each vendor's deliverable zones: enabled and priced (checkout's rule). */
  async deliveryZones(vendorIds: string[]): Promise<
    Map<
      string,
      {
        region: DeliveryZoneRegion;
        fee: number;
        minimumOrderValue: number | null;
      }[]
    >
  > {
    const ids = [...new Set(vendorIds)];
    const rows = ids.length
      ? await this.prisma.vendorDeliveryZone.findMany({
          where: { vendorId: { in: ids } },
          select: {
            vendorId: true,
            region: true,
            enabled: true,
            fee: true,
            minimumOrderValue: true,
          },
        })
      : [];
    const result = new Map<
      string,
      {
        region: DeliveryZoneRegion;
        fee: number;
        minimumOrderValue: number | null;
      }[]
    >();
    for (const id of ids) result.set(id, []);
    for (const r of rows) {
      const fee = resolveDeliveryFee(r);
      if (fee === null) continue;
      result.get(r.vendorId)!.push({
        region: r.region,
        fee,
        minimumOrderValue: normalizeMinimumOrderValue(r.minimumOrderValue),
      });
    }
    for (const list of result.values()) {
      list.sort((a, b) => ZONES.indexOf(a.region) - ZONES.indexOf(b.region));
    }
    return result;
  }

  /** Per branch, its bookable delivery windows in checkout's 3-day
   * calendar (the very list quote() offers): the earliest and the last
   * day that still has one. */
  async slotsByBranch(
    vendorId: string,
    branchIds: string[],
  ): Promise<Map<string, BranchSlots>> {
    const result = new Map<string, BranchSlots>();
    for (const branchId of [...new Set(branchIds)]) {
      const open = (
        await computeAvailableSlots(this.prisma, vendorId, branchId)
      ).filter((s) => s.remainingCapacity > 0);
      result.set(branchId, {
        earliest: open[0] ?? null,
        latestDate: open.length ? open[open.length - 1].date : null,
      });
    }
    return result;
  }

  /** «ساعات العمل والإغلاقات v1»: per branch that has opening hours set -
   * today's periods (Palestine) and the opening state (closures included,
   * common/branch-opening.util.ts). A branch with no hours is absent. */
  async hoursToday(
    branchIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, BranchHoursToday>> {
    const states = await loadOpeningStates(this.prisma, branchIds, now);
    const result = new Map<string, BranchHoursToday>();
    for (const [id, st] of states) {
      if (st.open_now === null) continue; // no hours set at all
      result.set(id, {
        periods: st.today,
        opening: {
          open_now: st.open_now,
          open_until: st.open_until,
          next_open_at: st.next_open_at,
        },
      });
    }
    return result;
  }

  /**
   * PD-5b.2: the ONE "can a shopper buy this right now" rule shared by
   * every curated list (PD-5.4 «نسّقي معه», PD-5b platform collections):
   * the store can sell (published, active, active subscription), the
   * variant is in stock in a sellable branch, and it can reach the
   * shopper - picked up from a physical branch, or delivered: to the zone
   * when one is known (request or default address), to some zone the
   * store serves when not. Returns the ids of the variants that qualify.
   */
  async reachableVariantIds(
    variants: { id: string; vendorId: string }[],
    zone: DeliveryZoneRegion | null,
  ): Promise<Set<string>> {
    const byVendor = new Map<string, string[]>();
    for (const v of variants) {
      const list = byVendor.get(v.vendorId) ?? [];
      list.push(v.id);
      byVendor.set(v.vendorId, list);
    }
    const reachable = new Set<string>();
    for (const [vendorId, ids] of byVendor) {
      const facts = await this.variantFulfilment(vendorId, ids, zone);
      if (!facts.purchasable) continue;
      for (const id of ids) {
        const f = facts.variants.get(id);
        if (!f) continue;
        const pickup = f.pickup.status === 'AVAILABLE';
        const delivery = zone
          ? f.delivery.status === 'AVAILABLE'
          : f.delivery.status === 'AVAILABLE' ||
            f.delivery.status === 'NO_ZONE_SELECTED';
        if (pickup || delivery) reachable.add(id);
      }
    }
    return reachable;
  }

  /**
   * The quantity-free delivery/pickup facts of one vendor's variants for
   * a zone: delivery needs a deliverable zone, a sellable branch with the
   * variant in stock AND an upcoming slot there; pickup needs a sellable
   * PHYSICAL branch with the variant in stock.
   */
  async variantFulfilment(
    vendorId: string,
    variantIds: string[],
    zone: DeliveryZoneRegion | null,
  ): Promise<{
    purchasable: boolean;
    deliveryZones: { region: DeliveryZoneRegion; fee: number }[];
    variants: Map<string, VariantFulfilment>;
  }> {
    const [stock, purchasableSet, zonesByVendor] = await Promise.all([
      this.stockByVariant(variantIds),
      this.purchasableVendorIds([vendorId]),
      this.deliveryZones([vendorId]),
    ]);
    const purchasable = purchasableSet.has(vendorId);
    const zones = zonesByVendor.get(vendorId) ?? [];
    const inStockBranchIds = [...stock.values()]
      .flat()
      .filter((s) => s.available > 0)
      .map((s) => s.branchId);
    const slots =
      purchasable && zones.length > 0
        ? await this.slotsByBranch(vendorId, inStockBranchIds)
        : new Map<string, BranchSlots>();
    const hours = purchasable
      ? await this.hoursToday(
          [...stock.values()]
            .flat()
            .filter((s) => s.available > 0 && s.isPhysical)
            .map((s) => s.branchId),
        )
      : new Map<string, BranchHoursToday>();
    const zoneRow = zone
      ? (zones.find((z) => z.region === zone) ?? null)
      : null;

    const variants = new Map<string, VariantFulfilment>();
    for (const id of variantIds) {
      const rows = purchasable
        ? (stock.get(id) ?? []).filter((r) => r.available > 0)
        : [];
      const total = rows.reduce((n, r) => n + r.available, 0);
      const pickupRows = rows.filter((r) => r.isPhysical);
      const withSlot = rows.filter((r) => slots.get(r.branchId)?.earliest);
      // The earliest window over every branch the customer could pick at
      // checkout (quote lists each eligible branch with its own slots).
      const earliestSlot =
        withSlot
          .map((r) => slots.get(r.branchId)!.earliest!)
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              a.startTime.localeCompare(b.startTime),
          )[0] ?? null;
      const latestDate =
        withSlot
          .map((r) => slots.get(r.branchId)!.latestDate!)
          .sort()
          .pop() ?? null;
      let status: DeliveryStatus;
      if (!purchasable) status = 'NOT_PURCHASABLE';
      else if (rows.length === 0) status = 'NO_ELIGIBLE_STOCK';
      else if (zones.length === 0) status = 'NOT_OFFERED';
      else if (withSlot.length === 0) status = 'NO_UPCOMING_SLOTS';
      else if (!zone) status = 'NO_ZONE_SELECTED';
      else if (!zoneRow) status = 'NOT_IN_ZONE';
      else status = 'AVAILABLE';
      const suggested = withSlot[0];
      const showSlot = status === 'AVAILABLE' || status === 'NO_ZONE_SELECTED';
      variants.set(id, {
        availability: bucketForStock(total),
        delivery: {
          status,
          fee: status === 'AVAILABLE' ? zoneRow!.fee : null,
          minimum_order_value:
            status === 'AVAILABLE' && suggested
              ? resolveDeliveryMinimumOrderValue(
                  suggested.minimumOrderValue,
                  zoneRow!.minimumOrderValue,
                )
              : null,
          earliest_slot_date: showSlot ? (earliestSlot?.date ?? null) : null,
          earliest_slot:
            showSlot && earliestSlot
              ? {
                  date: earliestSlot.date,
                  start_time: earliestSlot.startTime,
                  end_time: earliestSlot.endTime,
                }
              : null,
          latest_slot_date:
            showSlot &&
            earliestSlot &&
            latestDate &&
            latestDate > earliestSlot.date
              ? latestDate
              : null,
        },
        pickup: {
          status: !purchasable
            ? 'NOT_PURCHASABLE'
            : pickupRows.length
              ? 'AVAILABLE'
              : 'NO_PICKUP_BRANCH_WITH_STOCK',
          branches: pickupRows.map((r) => ({
            name: r.branchName,
            minimum_order_value: r.minimumOrderValue,
            hours_set: hours.has(r.branchId),
            hours_today: hours.get(r.branchId)?.periods ?? [],
            opening: hours.get(r.branchId)?.opening ?? null,
          })),
        },
      });
    }
    return {
      purchasable,
      deliveryZones: zones.map((z) => ({ region: z.region, fee: z.fee })),
      variants,
    };
  }
}
