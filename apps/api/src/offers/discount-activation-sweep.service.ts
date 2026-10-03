import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 200;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Sprint 19 (review-round finding, FR-FAV-005 E.0): a scheduled
 * discount (OfferVariant.discountPercent/discountStartAt/discountEndAt,
 * FR-PRICE-009 E.0) is never "activated" by any write - its effective
 * price is purely a function of now() (effective-price.util.ts) - so
 * nothing in the normal request path ever observes, let alone
 * notifies, the exact moment it actually starts. This sweep is that
 * moment: it finds every variant whose discount window has just become
 * active and, EXACTLY ONCE per (variant, discountStartAt) instance
 * no matter how many sweep ticks pass afterward, creates the
 * follower-facing OutboxEvent + its OutboxDeliveryTarget snapshot.
 *
 * The DiscountActivationNotice unique constraint IS the lock: this
 * sweep does not take any row lock of its own to decide "have I
 * already handled this one" - it just attempts the INSERT and lets
 * Postgres answer. See DiscountActivationNotice's own schema.prisma
 * comment.
 */
@Injectable()
export class DiscountActivationSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DiscountActivationSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) =>
      this.logger.error(
        'DiscountActivationSweepService tick failed',
        err as Error,
      ),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEventService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  /** Returns how many NEW discount activations were notified this
   * tick (0 on a tick where every currently-active discount was
   * already notified by an earlier tick - the common case). */
  async sweepOnce(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<
      {
        id: string;
        vendorId: string;
        vendorOfferId: string;
        discountStartAt: Date;
      }[]
    >`
      SELECT id, "vendorId", "vendorOfferId", "discountStartAt"
      FROM offer_variants
      WHERE "discountPercent" IS NOT NULL
        AND "discountStartAt" <= now()
        AND "discountEndAt" > now()
      ORDER BY "discountStartAt" ASC, id ASC
      LIMIT ${BATCH_LIMIT}
    `;

    let notified = 0;
    for (const candidate of candidates) {
      const didNotify = await this.tryNotifyOnce(candidate);
      if (didNotify) notified += 1;
    }
    return notified;
  }

  private async tryNotifyOnce(candidate: {
    id: string;
    vendorId: string;
    vendorOfferId: string;
    discountStartAt: Date;
  }): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // The claim-and-create-everything-atomically step the review
        // round required: OutboxEvent is created first (cheap,
        // conflict-free), THEN the DiscountActivationNotice INSERT -
        // if THAT hits the unique constraint, the whole transaction
        // (including the OutboxEvent just created) rolls back as one
        // unit, leaving no orphaned event and no orphaned notice.
        const outboxEvent = await this.outbox.enqueue(
          {
            eventType: 'offer.discount_activated_for_followers',
            payload: {
              vendor_id: candidate.vendorId,
              offer_variant_id: candidate.id,
            },
          },
          tx,
        );
        await tx.discountActivationNotice.create({
          data: {
            offerVariantId: candidate.id,
            discountStartAt: candidate.discountStartAt,
            outboxEventId: outboxEvent.id,
          },
        });
        await tx.$executeRaw`
          INSERT INTO outbox_delivery_targets (id, "outboxEventId", "recipientUserId")
          SELECT gen_random_uuid()::text, ${outboxEvent.id}, "userId"
          FROM store_follows WHERE "vendorId" = ${candidate.vendorId}
        `;
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Another tick (or an earlier pass of this same tick, if this
        // ever runs with overlap) already claimed this exact discount
        // instance - already handled, nothing left to do.
        return false;
      }
      throw err;
    }
  }
}
