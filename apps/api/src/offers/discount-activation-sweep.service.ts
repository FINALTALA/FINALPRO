import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import {
  logSweepTick,
  runSweepStep,
  SweepBackoff,
  sweepTransaction,
  type SweepStepResult,
} from '../common/sweep-runner.util';
import { enqueueFavoriteNotification } from '../favorites/favorite-alerts.util';
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
 *
 * TB-11: the candidate query used to return every active discount, the
 * oldest 200 first, already-notified ones included - so with 200 or more
 * active discounts a newly started one was never reached (and each tick
 * opened 200 transactions only to be refused by that constraint). It now
 * leaves out every (variant, discountStartAt) that already has its
 * notice; the constraint stays the guarantee when two instances race.
 * Each item runs through the shared sweep runner (own transaction with
 * lock_timeout, own try/catch, deferral of a failing variant).
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
    DiscountActivationSweepService.name,
  );
  private readonly backoff = new SweepBackoff();
  /** TB-11: the last tick's per-step results (tests read it). */
  lastTick: SweepStepResult[] = [];

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
    const startedAt = Date.now();
    const candidates = new Map<
      string,
      {
        id: string;
        vendorId: string;
        vendorOfferId: string;
        discountStartAt: Date;
      }
    >();
    const step = await runSweepStep({
      step: 'discountActivations',
      logger: this.logger,
      backoff: this.backoff,
      findCandidates: async (excluded) => {
        const rows = await this.prisma.$queryRaw<
          {
            id: string;
            vendorId: string;
            vendorOfferId: string;
            discountStartAt: Date;
          }[]
        >`
          SELECT ov.id, ov."vendorId", ov."vendorOfferId", ov."discountStartAt"
          FROM offer_variants ov
          WHERE ov."discountPercent" IS NOT NULL
            AND ov."discountStartAt" <= now()
            AND ov."discountEndAt" > now()
            AND NOT EXISTS (
              SELECT 1 FROM discount_activation_notices n
              WHERE n."offerVariantId" = ov.id
                AND n."discountStartAt" = ov."discountStartAt"
            )
            AND ov.id <> ALL(${excluded}::text[])
          ORDER BY ov."discountStartAt" ASC, ov.id ASC
          LIMIT ${BATCH_LIMIT}
        `;
        for (const r of rows) candidates.set(r.id, r);
        return rows.map((r) => r.id);
      },
      processItem: (id) => this.tryNotifyOnce(candidates.get(id)!),
    });
    this.lastTick = [step];
    logSweepTick(this.logger, this.lastTick, startedAt);
    return step.done;
  }

  private async tryNotifyOnce(candidate: {
    id: string;
    vendorId: string;
    vendorOfferId: string;
    discountStartAt: Date;
  }): Promise<boolean> {
    try {
      await sweepTransaction(this.prisma, async (tx) => {
        // The claim-and-create-everything-atomically step the review
        // round required: OutboxEvent is created first (cheap,
        // conflict-free), THEN the DiscountActivationNotice INSERT -
        // if THAT hits the unique constraint, the whole transaction
        // (including the OutboxEvent just created) rolls back as one
        // unit, leaving no orphaned event and no orphaned notice.
        const outboxEvent = await this.outbox.enqueue(
          {
            eventType: 'offer.discount_activated_for_followers',
            audience: 'CUSTOMER',
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

        // Sprint 24 (FR-FAV-003): a scheduled discount activating is a
        // genuine real price drop - the favorite-alert fan-out must not
        // be limited to the manual-PATCH choke point alone. Resolves
        // the variant's matched canonical product (if any) so PRODUCT
        // favorites are covered too, not just OFFER favorites of this
        // exact listing.
        const variant = await tx.offerVariant.findUnique({
          where: { id: candidate.id },
          select: { canonicalVariantId: true },
        });
        let canonicalProductId: string | undefined;
        if (variant?.canonicalVariantId) {
          const canonicalVariant = await tx.canonicalProductVariant.findUnique({
            where: { id: variant.canonicalVariantId },
            select: { canonicalProductId: true },
          });
          canonicalProductId = canonicalVariant?.canonicalProductId;
        }
        await enqueueFavoriteNotification(tx, this.outbox, {
          eventType: 'favorite.price_dropped',
          alertType: 'PRICE_DROP',
          canonicalProductId,
          offerVariantId: candidate.id,
          payload: {
            vendor_id: candidate.vendorId,
            offer_variant_id: candidate.id,
          },
        });
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
