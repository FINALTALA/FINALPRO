import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

/** PD-5.4: at most this many offers styled with one offer (the DB trigger agrees). */
export const MAX_OFFER_PAIRINGS = 6;

function primaryMedia(media: { url: string; kind: string }[]): string | null {
  return (media.find((m) => m.kind === 'PRIMARY') ?? media[0])?.url ?? null;
}

/**
 * PD-5.4 («نسّقي معه»): a store owner's own pairings of their offers.
 * Same store only (also enforced by the composite FKs), never the offer
 * itself (CHECK), at most 6 (trigger), replaced as one ordered list under
 * the primary offer's row lock, every change audited.
 */
@Injectable()
export class OfferPairingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private notFound() {
    return new NotFoundException({
      code: 'VENDOR_OFFER_NOT_FOUND',
      message: 'Offer not found',
    });
  }

  /** The owner/staff view: each paired offer with its own status. */
  async view(
    vendorId: string,
    offerId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const offer = await db.vendorOffer.findFirst({
      where: { id: offerId, vendorId },
      select: { id: true },
    });
    if (!offer) throw this.notFound();
    const rows = await db.offerPairing.findMany({
      where: { vendorId, offerId },
      orderBy: { sortOrder: 'asc' },
      select: {
        pairedOffer: {
          select: {
            id: true,
            titleAr: true,
            status: true,
            variants: {
              select: { media: { select: { url: true, kind: true } } },
            },
          },
        },
      },
    });
    return {
      offer_id: offerId,
      max: MAX_OFFER_PAIRINGS,
      items: rows.map((r) => ({
        offer_id: r.pairedOffer.id,
        title_ar: r.pairedOffer.titleAr,
        status: r.pairedOffer.status,
        image_url:
          r.pairedOffer.variants
            .map((v) => primaryMedia(v.media))
            .find((u) => u !== null) ?? null,
      })),
    };
  }

  async replace(
    actorId: string,
    correlationId: string | undefined,
    vendorId: string,
    offerId: string,
    pairedOfferIds: string[],
  ) {
    if (pairedOfferIds.includes(offerId)) {
      throw new BadRequestException({
        code: 'OFFER_PAIRING_SELF',
        message: 'An offer cannot be styled with itself',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      // Serialises every pairing change of this offer - and BOLA: the
      // row must be this vendor's.
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM vendor_offers
         WHERE id = ${offerId} AND "vendorId" = ${vendorId}
         FOR UPDATE`;
      if (locked.length === 0) throw this.notFound();
      if (locked[0].status === 'ARCHIVED') {
        throw new ConflictException({
          code: 'OFFER_ARCHIVED',
          message: 'An archived offer cannot be styled',
        });
      }
      const paired = pairedOfferIds.length
        ? await tx.vendorOffer.findMany({
            where: { id: { in: pairedOfferIds }, vendorId },
            select: { id: true, status: true },
          })
        : [];
      // Another store's offer (or none at all) is simply not found here.
      if (paired.length !== pairedOfferIds.length) {
        throw new NotFoundException({
          code: 'PAIRED_OFFER_NOT_FOUND',
          message: 'Every paired offer must be one of this store offers',
        });
      }
      if (paired.some((p) => p.status === 'ARCHIVED')) {
        throw new ConflictException({
          code: 'PAIRED_OFFER_ARCHIVED',
          message: 'An archived offer cannot be paired',
        });
      }

      const before = (
        await tx.offerPairing.findMany({
          where: { vendorId, offerId },
          orderBy: { sortOrder: 'asc' },
          select: { pairedOfferId: true },
        })
      ).map((r) => r.pairedOfferId);
      const after = pairedOfferIds;
      if (before.join() !== after.join()) {
        await tx.offerPairing.deleteMany({ where: { vendorId, offerId } });
        if (after.length) {
          await tx.offerPairing.createMany({
            data: after.map((pairedOfferId, sortOrder) => ({
              vendorId,
              offerId,
              pairedOfferId,
              sortOrder,
            })),
          });
        }
        const added = after.filter((id) => !before.includes(id));
        const removed = before.filter((id) => !after.includes(id));
        const keptAfter = after.filter((id) => before.includes(id));
        const keptBefore = before.filter((id) => after.includes(id));
        const record = (action: string, extra: Record<string, unknown>) =>
          this.audit.record(
            {
              actorId,
              correlationId,
              action,
              entityType: 'VendorOffer',
              entityId: offerId,
              beforeState: { paired_offer_ids: before },
              afterState: { paired_offer_ids: after, ...extra },
            },
            tx,
          );
        if (added.length)
          await record('offer_pairing.created', { added_offer_ids: added });
        if (removed.length)
          await record('offer_pairing.deleted', { removed_offer_ids: removed });
        if (keptAfter.join() !== keptBefore.join())
          await record('offer_pairing.reordered', {});
      }
      return this.view(vendorId, offerId, tx);
    });
  }
}
