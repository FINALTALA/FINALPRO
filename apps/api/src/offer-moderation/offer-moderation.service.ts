import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { isLockTimeout, SWEEP_LOCK_TIMEOUT } from '../common/sweep-runner.util';
import { AuditLogService } from '../audit/audit-log.service';
import {
  lockReservationRowIfExists,
  releaseReservationItemHolds,
} from '../checkout/stock-lock.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { assertNoPlatformVendorConflict } from '../platform-admin/vendor-conflict.util';
import { PrismaService } from '../prisma/prisma.service';

/** How often the recovery pass runs, and how many reservations one pass takes. */
export const PLATFORM_HOLD_RECOVERY_INTERVAL_MS = 60_000;
export const PLATFORM_HOLD_RECOVERY_BATCH = 200;

/**
 * VIA phase 2C - Platform Hold (offer moderation).
 *
 * A platform-owned hold on one VendorOffer, separate from the owner's own
 * `status`: HIDE or REQUEST_CHANGES. While OPEN the offer is out of every
 * public read and every purchase step (platform-hold.util.ts) - its status,
 * stock, store verification and publication are never touched, so RESTORE
 * only closes the hold and the offer's ordinary rules apply again.
 *
 * Concurrency:
 *  - at most one open hold per offer: checked under the vendor-row lock
 *    and backed by a partial unique index (two admins -> one 409);
 *  - against checkout: placing a hold takes the vendor row FOR UPDATE -
 *    the lock reserve()/confirm() take (assertItemsPurchasable) before
 *    they read the offer. A confirm that got the lock first completes its
 *    order normally; one that waits reads the open hold and is refused,
 *    and nothing is ordered.
 *  - unconfirmed reservations holding the offer are released inside the
 *    hold's own transaction when their row can be locked without waiting
 *    (SKIP LOCKED - never a wait against a confirm's lock order); any
 *    still busy are released right after commit, one transaction each, in
 *    cancel()'s lock order (reservation row, then stock rows). Every
 *    release goes through releaseReservationItemHolds, which gives stock
 *    back only for an item row it actually deleted - never twice. Slot
 *    holds go with the reservation row. A refused confirm also releases
 *    its own reservation (CheckoutService.confirm).
 *  - confirmed orders, their fulfilment, returns and refunds are never
 *    touched; no stock of a confirmed order changes.
 */

export type HoldAction = 'HIDE' | 'REQUEST_CHANGES';

const REASON_MIN = 3;
const REASON_MAX = 1000;

function cleanText(
  raw: unknown,
  field: string,
  required: boolean,
): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    if (!required) return null;
    throw new BadRequestException({
      code: 'MODERATION_REASON_REQUIRED',
      message: `${field} is required (${REASON_MIN}-${REASON_MAX} characters)`,
    });
  }
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    throw new BadRequestException({
      code: 'MODERATION_REASON_LENGTH',
      message: `${field} must be ${REASON_MIN}-${REASON_MAX} characters`,
    });
  }
  return text;
}

type HoldRow = Prisma.OfferPlatformHoldGetPayload<object>;

export function holdDto(h: HoldRow, currentRevision: number | null) {
  const submitted = h.correctionRevision !== null;
  return {
    id: h.id,
    offer_id: h.vendorOfferId,
    vendor_id: h.vendorId,
    action: h.action,
    reason: h.reason,
    placed_by: h.placedById,
    placed_at: h.placedAt.toISOString(),
    open: h.releasedAt === null,
    correction: submitted
      ? {
          revision: h.correctionRevision,
          note: h.correctionNote,
          submitted_by: h.correctionSubmittedById,
          submitted_at: h.correctionSubmittedAt!.toISOString(),
          // A content edit after submitting makes it stale.
          stale:
            currentRevision !== null &&
            h.correctionRevision !== currentRevision,
        }
      : null,
    last_return: h.correctionReturnedAt
      ? {
          note: h.correctionReturnNote,
          returned_by: h.correctionReturnedById,
          returned_at: h.correctionReturnedAt.toISOString(),
        }
      : null,
    released: h.releasedAt
      ? {
          released_by: h.releasedById,
          released_at: h.releasedAt.toISOString(),
          note: h.releaseNote,
          revision: h.releasedAtRevision,
        }
      : null,
  };
}

/** Owner-facing: what the store needs to know, no admin identities. */
export function ownerHoldDto(h: HoldRow, currentRevision: number) {
  const full = holdDto(h, currentRevision);
  return {
    id: full.id,
    action: full.action,
    reason: full.reason,
    placed_at: full.placed_at,
    current_revision: currentRevision,
    can_submit_correction: h.action === 'REQUEST_CHANGES',
    correction: full.correction
      ? {
          revision: full.correction.revision,
          note: full.correction.note,
          submitted_at: full.correction.submitted_at,
          stale: full.correction.stale,
        }
      : null,
    last_return: full.last_return
      ? {
          note: full.last_return.note,
          returned_at: full.last_return.returned_at,
        }
      : null,
  };
}

@Injectable()
export class OfferModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OfferModerationService.name);
  /** The recovery pass on its own tick (not started under tests; see recoverHeldReservations). */
  private readonly recovery = new PeriodicTask(
    PLATFORM_HOLD_RECOVERY_INTERVAL_MS,
    () => this.recoverHeldReservations().then(() => undefined),
    (err) =>
      this.logger.error('Platform hold recovery tick failed', err as Error),
    'PlatformHoldRecovery',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  onModuleInit() {
    this.recovery.start();
  }

  onModuleDestroy() {
    this.recovery.stop();
  }

  // ------------------------------------------------------------------
  // Admin reads

  async list(params: {
    q?: string;
    hold?: string;
    vendorId?: string;
    status?: string;
    cursor?: string;
    limit?: string;
  }) {
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
    const q = params.q?.trim().slice(0, 80);
    const and: Prisma.VendorOfferWhereInput[] = [];
    if (q) {
      and.push({
        OR: [
          { titleAr: { contains: q, mode: 'insensitive' } },
          { titleEn: { contains: q, mode: 'insensitive' } },
          { vendor: { legalName: { contains: q, mode: 'insensitive' } } },
          { vendor: { displayName: { contains: q, mode: 'insensitive' } } },
          ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q }] : []),
        ],
      });
    }
    const open = { releasedAt: null };
    switch (params.hold) {
      case undefined:
      case '':
      case 'all':
        break;
      case 'held':
        and.push({ platformHolds: { some: open } });
        break;
      case 'none':
        and.push({ platformHolds: { none: open } });
        break;
      case 'HIDE':
      case 'REQUEST_CHANGES':
        and.push({ platformHolds: { some: { ...open, action: params.hold } } });
        break;
      case 'correction_submitted':
        and.push({
          platformHolds: {
            some: { ...open, correctionRevision: { not: null } },
          },
        });
        break;
      default:
        throw new BadRequestException({
          code: 'INVALID_HOLD_FILTER',
          message:
            'hold must be one of all, held, none, HIDE, REQUEST_CHANGES, correction_submitted',
        });
    }
    if (params.vendorId) and.push({ vendorId: params.vendorId });
    if (params.status) {
      if (
        !['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(params.status)
      ) {
        throw new BadRequestException({
          code: 'INVALID_STATUS_FILTER',
          message: 'status must be DRAFT, ACTIVE, INACTIVE or ARCHIVED',
        });
      }
      and.push({ status: params.status as 'ACTIVE' });
    }
    if (params.cursor) {
      const [createdAt, id] = Buffer.from(params.cursor, 'base64url')
        .toString('utf8')
        .split('|');
      const at = new Date(createdAt);
      if (!id || Number.isNaN(at.getTime())) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: 'The cursor is not valid',
        });
      }
      and.push({
        OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }],
      });
    }
    const rows = await this.prisma.vendorOffer.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        status: true,
        contentRevision: true,
        createdAt: true,
        vendor: {
          select: { id: true, legalName: true, displayName: true, slug: true },
        },
        variants: {
          take: 1,
          select: { media: { take: 1, select: { url: true } } },
        },
        platformHolds: { where: open, take: 1 },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((o) => ({
        id: o.id,
        title_ar: o.titleAr,
        title_en: o.titleEn,
        status: o.status,
        store: {
          id: o.vendor.id,
          name: o.vendor.displayName ?? o.vendor.legalName,
          slug: o.vendor.slug,
        },
        image_url: o.variants[0]?.media[0]?.url ?? null,
        created_at: o.createdAt.toISOString(),
        hold: o.platformHolds[0]
          ? holdDto(o.platformHolds[0], o.contentRevision)
          : null,
      })),
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString(
              'base64url',
            )
          : null,
    };
  }

  async detail(offerId: string) {
    const o = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        status: true,
        contentRevision: true,
        createdAt: true,
        firstPublishedAt: true,
        archivedAt: true,
        vendor: {
          select: {
            id: true,
            legalName: true,
            displayName: true,
            slug: true,
            status: true,
            storefrontPublished: true,
          },
        },
        variants: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            sellerSku: true,
            basePrice: true,
            colour: true,
            size: true,
            media: {
              take: 1,
              orderBy: { sortOrder: 'asc' },
              select: { url: true },
            },
          },
        },
        platformHolds: { orderBy: { placedAt: 'desc' } },
      },
    });
    if (!o) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    const open = o.platformHolds.find((h) => h.releasedAt === null) ?? null;
    return {
      id: o.id,
      title_ar: o.titleAr,
      title_en: o.titleEn,
      status: o.status,
      content_revision: o.contentRevision,
      created_at: o.createdAt.toISOString(),
      first_published_at: o.firstPublishedAt?.toISOString() ?? null,
      archived_at: o.archivedAt?.toISOString() ?? null,
      store: {
        id: o.vendor.id,
        name: o.vendor.displayName ?? o.vendor.legalName,
        slug: o.vendor.slug,
        status: o.vendor.status,
        storefront_published: o.vendor.storefrontPublished,
      },
      variants: o.variants.map((v) => ({
        id: v.id,
        sku: v.sellerSku,
        base_price: Number(v.basePrice),
        colour: v.colour,
        size: v.size,
        image_url: v.media[0]?.url ?? null,
      })),
      // Public = the owner published it AND the store is live AND no hold.
      publicly_visible:
        o.status === 'ACTIVE' &&
        o.vendor.status === 'ACTIVE' &&
        o.vendor.storefrontPublished &&
        !open,
      hold: open ? holdDto(open, o.contentRevision) : null,
      history: o.platformHolds
        .filter((h) => h.releasedAt !== null)
        .map((h) => holdDto(h, o.contentRevision)),
    };
  }

  // ------------------------------------------------------------------
  // Admin decisions

  async placeHold(
    adminId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
    offerId: string,
    dto: { action: HoldAction; reason: string },
  ) {
    const reason = cleanText(dto.reason, 'reason', true)!;
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: { id: true, vendorId: true },
    });
    if (!offer) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    let body: {
      hold: ReturnType<typeof holdDto>;
      released_reservations: number;
    };
    try {
      body = await this.prisma.$transaction(async (tx) => {
        // The lock reserve()/confirm() take before reading the offer.
        await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${offer.vendorId} FOR UPDATE`;
        await assertNoPlatformVendorConflict(tx, adminId, offer.vendorId);
        const existing = await tx.offerPlatformHold.findFirst({
          where: { vendorOfferId: offerId, releasedAt: null },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException({
            code: 'OFFER_ALREADY_HELD',
            message: 'This offer already has an open platform hold',
          });
        }
        const current = await tx.vendorOffer.findUniqueOrThrow({
          where: { id: offerId },
          select: { contentRevision: true, status: true },
        });
        const hold = await tx.offerPlatformHold.create({
          data: {
            vendorId: offer.vendorId,
            vendorOfferId: offerId,
            action: dto.action,
            reason,
            placedById: adminId,
          },
        });
        await this.auditLog.record(
          {
            actorId: adminId,
            correlationId,
            action: 'offer.platform_hold_placed',
            entityType: 'VendorOffer',
            entityId: offerId,
            beforeState: { offer_status: current.status, held: false },
            afterState: {
              held: true,
              hold_id: hold.id,
              hold_action: dto.action,
              reason,
              content_revision: current.contentRevision,
            },
          },
          tx,
        );
        const released = await this.releaseReservationsOfOffer(
          tx,
          offerId,
          correlationId,
          true,
        );
        const result = {
          hold: holdDto(hold, current.contentRevision),
          released_reservations: released,
        };
        await this.idempotencyCompletion.complete(
          tx,
          idempotencyClaimId,
          result,
          201,
        );
        return result;
      });
    } catch (err) {
      // The partial unique index: another admin opened one at the same time.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'OFFER_ALREADY_HELD',
          message: 'This offer already has an open platform hold',
        });
      }
      throw err;
    }
    // Reservations that were busy (a confirm or cancel in flight) are
    // released now, each in cancel()'s lock order. Anything still left can
    // no longer be confirmed and is released by recoverHeldReservations()
    // on its next pass (exactly once).
    const late = await this.releaseBusyReservations(offerId, correlationId);
    return {
      ...body,
      released_reservations: body.released_reservations + late,
    };
  }

  async returnCorrection(
    adminId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
    offerId: string,
    dto: { note: string },
  ) {
    const note = cleanText(dto.note, 'note', true)!;
    return this.prisma.$transaction(async (tx) => {
      const { hold, offer } = await this.lockOpenHold(tx, offerId, adminId);
      if (
        hold.action !== 'REQUEST_CHANGES' ||
        hold.correctionRevision === null
      ) {
        throw new ConflictException({
          code: 'NO_CORRECTION_SUBMITTED',
          message: 'There is no submitted correction to return',
        });
      }
      const updated = await tx.offerPlatformHold.update({
        where: { id: hold.id },
        data: {
          correctionRevision: null,
          correctionNote: null,
          correctionSubmittedAt: null,
          correctionSubmittedById: null,
          correctionReturnedAt: new Date(),
          correctionReturnNote: note,
          correctionReturnedById: adminId,
        },
      });
      await this.auditLog.record(
        {
          actorId: adminId,
          correlationId,
          action: 'offer.platform_hold_correction_returned',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { correction_revision: hold.correctionRevision },
          afterState: { hold_id: hold.id, note },
        },
        tx,
      );
      const result = { hold: holdDto(updated, offer.contentRevision) };
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        result,
        201,
      );
      return result;
    });
  }

  /**
   * RESTORE closes the hold - nothing else. `offer_revision` is the content
   * revision the administrator reviewed: if the offer changed since, the
   * restore is refused (re-read and review again). A REQUEST_CHANGES hold
   * is restored only on a submitted, current (not stale) correction.
   */
  async restore(
    adminId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
    offerId: string,
    dto: { note: string; offer_revision: number },
  ) {
    const note = cleanText(dto.note, 'note', true)!;
    return this.prisma.$transaction(async (tx) => {
      const { hold, offer } = await this.lockOpenHold(tx, offerId, adminId);
      if (dto.offer_revision !== offer.contentRevision) {
        throw new ConflictException({
          code: 'OFFER_CHANGED_SINCE_REVIEW',
          message:
            'The offer changed after you reviewed it - reload and review the current version',
          details: [{ current_revision: offer.contentRevision }],
        });
      }
      if (hold.action === 'REQUEST_CHANGES') {
        if (hold.correctionRevision === null) {
          throw new ConflictException({
            code: 'CORRECTION_REQUIRED',
            message: 'The store has not submitted a correction yet',
          });
        }
        if (hold.correctionRevision !== offer.contentRevision) {
          throw new ConflictException({
            code: 'CORRECTION_STALE',
            message:
              'The offer changed after the correction was submitted - the store must submit the current version',
          });
        }
      }
      const updated = await tx.offerPlatformHold.update({
        where: { id: hold.id },
        data: {
          releasedAt: new Date(),
          releasedById: adminId,
          releaseNote: note,
          releasedAtRevision: offer.contentRevision,
        },
      });
      await this.auditLog.record(
        {
          actorId: adminId,
          correlationId,
          action: 'offer.platform_hold_released',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: {
            held: true,
            hold_id: hold.id,
            hold_action: hold.action,
          },
          afterState: {
            held: false,
            note,
            content_revision: offer.contentRevision,
          },
        },
        tx,
      );
      const result = { hold: holdDto(updated, offer.contentRevision) };
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        result,
        201,
      );
      return result;
    });
  }

  // ------------------------------------------------------------------
  // Owner

  async ownerView(vendorId: string, offerId: string) {
    const offer = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, vendorId },
      select: {
        contentRevision: true,
        platformHolds: { where: { releasedAt: null }, take: 1 },
      },
    });
    if (!offer) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    const hold = offer.platformHolds[0];
    return { hold: hold ? ownerHoldDto(hold, offer.contentRevision) : null };
  }

  /**
   * The owner submits ONE exact content revision as the correction - the
   * one they saw (`offer_revision`). A later edit raises the revision and
   * makes the submission visibly stale; it never replaces it silently.
   * Republishing does not lift the hold - only an administrator does.
   */
  async submitCorrection(
    userId: string,
    correlationId: string,
    idempotencyClaimId: string | undefined,
    vendorId: string,
    offerId: string,
    dto: { offer_revision: number; note?: string },
  ) {
    const note = cleanText(dto.note, 'note', false);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM offer_platform_holds
         WHERE "vendorOfferId" = ${offerId} AND "vendorId" = ${vendorId}
           AND "releasedAt" IS NULL
         FOR UPDATE`;
      if (!rows[0]) {
        throw new ConflictException({
          code: 'NO_OPEN_HOLD',
          message: 'This offer has no open platform hold',
        });
      }
      const hold = await tx.offerPlatformHold.findUniqueOrThrow({
        where: { id: rows[0].id },
      });
      if (hold.action !== 'REQUEST_CHANGES') {
        throw new ConflictException({
          code: 'CORRECTION_NOT_REQUESTED',
          message:
            'This hold does not ask for changes - it can only be lifted by the platform',
        });
      }
      const offer = await tx.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { contentRevision: true },
      });
      if (dto.offer_revision !== offer.contentRevision) {
        throw new ConflictException({
          code: 'OFFER_REVISION_CHANGED',
          message:
            'The offer changed since you opened it - reload, check it and submit again',
          details: [{ current_revision: offer.contentRevision }],
        });
      }
      const updated = await tx.offerPlatformHold.update({
        where: { id: hold.id },
        data: {
          correctionRevision: offer.contentRevision,
          correctionNote: note,
          correctionSubmittedAt: new Date(),
          correctionSubmittedById: userId,
        },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer.platform_hold_correction_submitted',
          entityType: 'VendorOffer',
          entityId: offerId,
          afterState: {
            hold_id: hold.id,
            content_revision: offer.contentRevision,
          },
        },
        tx,
      );
      const result = { hold: ownerHoldDto(updated, offer.contentRevision) };
      await this.idempotencyCompletion.complete(
        tx,
        idempotencyClaimId,
        result,
        201,
      );
      return result;
    });
  }

  // ------------------------------------------------------------------
  // Internals

  /** Vendor row, conflict check, then the open hold row - all locked. */
  private async lockOpenHold(
    tx: Prisma.TransactionClient,
    offerId: string,
    adminId: string,
  ) {
    const offer = await tx.vendorOffer.findUnique({
      where: { id: offerId },
      select: { vendorId: true },
    });
    if (!offer) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${offer.vendorId} FOR UPDATE`;
    await assertNoPlatformVendorConflict(tx, adminId, offer.vendorId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM offer_platform_holds
       WHERE "vendorOfferId" = ${offerId} AND "releasedAt" IS NULL
       FOR UPDATE`;
    if (!rows[0]) {
      throw new ConflictException({
        code: 'NO_OPEN_HOLD',
        message: 'This offer has no open platform hold',
      });
    }
    const [hold, current] = await Promise.all([
      tx.offerPlatformHold.findUniqueOrThrow({ where: { id: rows[0].id } }),
      tx.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { contentRevision: true },
      }),
    ]);
    return { hold, offer: current };
  }

  /**
   * Releases every unconfirmed reservation holding a variant of this offer
   * whose row can be locked. `skipLocked` (inside the hold transaction)
   * never waits; afterwards each remaining one is locked normally.
   */
  private async releaseReservationsOfOffer(
    tx: Prisma.TransactionClient,
    offerId: string,
    correlationId: string,
    skipLocked: boolean,
  ): Promise<number> {
    const lockClause = skipLocked
      ? Prisma.sql`FOR UPDATE OF r SKIP LOCKED`
      : Prisma.sql`FOR UPDATE OF r`;
    const reservations = await tx.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM checkout_reservations r
       WHERE EXISTS (
         SELECT 1 FROM checkout_reservation_items i
           JOIN offer_variants v ON v.id = i."offerVariantId"
          WHERE i."reservationId" = r.id AND v."vendorOfferId" = ${offerId})
       ORDER BY r.id
       ${lockClause}`;
    let count = 0;
    for (const { id } of reservations) {
      if (await this.releaseLockedReservation(tx, id, correlationId))
        count += 1;
    }
    return count;
  }

  private async releaseLockedReservation(
    tx: Prisma.TransactionClient,
    reservationId: string,
    correlationId: string,
  ): Promise<boolean> {
    const items = await tx.checkoutReservationItem.findMany({
      where: { reservationId },
      select: {
        id: true,
        vendorId: true,
        branchId: true,
        offerVariantId: true,
        quantity: true,
      },
    });
    const slots = await tx.checkoutReservationSlot.count({
      where: { reservationId },
    });
    const released = await releaseReservationItemHolds(tx, items);
    // Its slots cascade with it (capacity counts live holds only).
    const deleted = await tx.checkoutReservation.deleteMany({
      where: { id: reservationId },
    });
    if (deleted.count === 0) return false;
    await this.auditLog.record(
      {
        actorId: null,
        correlationId,
        action: 'checkout.reservation_released_platform_hold',
        entityType: 'CheckoutReservation',
        entityId: reservationId,
        beforeState: {
          items: released.items,
          units: released.units,
          slots,
        },
      },
      tx,
    );
    return true;
  }

  /** After the hold commits: the reservations that were busy, each in its own transaction. */
  private async releaseBusyReservations(
    offerId: string,
    correlationId: string,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT i."reservationId" AS id
        FROM checkout_reservation_items i
        JOIN offer_variants v ON v.id = i."offerVariantId"
       WHERE v."vendorOfferId" = ${offerId}
       ORDER BY 1`;
    let count = 0;
    for (const { id } of rows) {
      try {
        if (await this.releaseOneIfHeld(id, correlationId)) count += 1;
      } catch (err) {
        this.logger.warn(
          `Platform hold on offer ${offerId}: reservation ${id} not released now (the recovery pass retries it): ${(err as Error).message}`,
        );
      }
    }
    return count;
  }

  /**
   * Recovery: every unconfirmed reservation still holding stock of an
   * offer under an OPEN hold - left behind when the release after a hold
   * failed (crash, lock timeout, lost connection) - is released here, one
   * transaction each. Runs right after every hold and on its own tick, so
   * it never depends on reservation expiry or the expiry sweep's flag.
   *
   * Exactly once: the reservation row is locked first (FOR UPDATE, with
   * a lock timeout - a busy one is simply retried next pass), the hold is
   * re-checked under that lock, and releaseReservationItemHolds only gives
   * back units for item rows this call itself deleted. A reservation that
   * a confirm, a cancel or the expiry sweep removed first is a no-op.
   */
  async recoverHeldReservations(
    limit = PLATFORM_HOLD_RECOVERY_BATCH,
  ): Promise<{ candidates: number; released: number; failed: number }> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT i."reservationId" AS id
        FROM checkout_reservation_items i
        JOIN offer_variants v ON v.id = i."offerVariantId"
        JOIN offer_platform_holds h
          ON h."vendorOfferId" = v."vendorOfferId" AND h."releasedAt" IS NULL
       ORDER BY 1
       LIMIT ${limit}`;
    const result = { candidates: rows.length, released: 0, failed: 0 };
    for (const { id } of rows) {
      try {
        if (await this.releaseOneIfHeld(id, randomUUID())) result.released += 1;
      } catch (err) {
        result.failed += 1;
        if (!isLockTimeout(err)) {
          this.logger.warn(
            `Platform hold recovery: reservation ${id} not released (retried next pass): ${(err as Error).message}`,
          );
        }
      }
    }
    if (result.released > 0 || result.failed > 0) {
      this.logger.log(
        `Platform hold recovery: released ${result.released} of ${result.candidates} reservation(s), ${result.failed} retried later`,
      );
    }
    return result;
  }

  /** One reservation, its own transaction; false if gone or no longer on a held offer. */
  private async releaseOneIfHeld(
    reservationId: string,
    correlationId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL lock_timeout = '${SWEEP_LOCK_TIMEOUT}'`,
      );
      if (!(await lockReservationRowIfExists(tx, reservationId))) return false;
      const held = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one
          FROM checkout_reservation_items i
          JOIN offer_variants v ON v.id = i."offerVariantId"
          JOIN offer_platform_holds h
            ON h."vendorOfferId" = v."vendorOfferId" AND h."releasedAt" IS NULL
         WHERE i."reservationId" = ${reservationId}
         LIMIT 1`;
      if (held.length === 0) return false;
      return this.releaseLockedReservation(tx, reservationId, correlationId);
    });
  }
}
