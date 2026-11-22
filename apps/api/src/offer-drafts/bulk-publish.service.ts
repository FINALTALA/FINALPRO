import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PeriodicTask } from '../common/periodic-task.util';
import { OfferPublishService } from '../offers/offer-publish.service';
import { PrismaService } from '../prisma/prisma.service';
import { draftDisplayTitle, type DraftPayload } from './draft-payload';
import { NEW_DRAFT_TITLE, OfferDraftsService } from './offer-drafts.service';

export const MAX_BULK_PUBLISH = 100;
const RESUME_INTERVAL_MS = 30_000;

type Problem = { code: string; step?: number };
/** A PUBLISHED item recorded after an interruption (its product was published by this run). */
const RECOVERED = 'RECOVERED_AFTER_INTERRUPTION';

const titleOf = (payload: unknown) =>
  draftDisplayTitle((payload ?? {}) as DraftPayload) ?? NEW_DRAFT_TITLE;

/**
 * Bulk publishing (2026-11-18): drafts the owner chose - an import's batch
 * - are published together, on the server.
 *  - preflight: read-only, the publish gate itself (publishProblems) for
 *    each one: ready, or why not;
 *  - start: only what the owner confirmed (each with the revision she saw)
 *    becomes a run; ONE running run per store (the database refuses a
 *    second - another tab);
 *  - the run publishes the drafts one by one with the wizard's own
 *    publish() - each product whole (created AND activated) or not at
 *    all, never a half product, never a product left unpublished outside
 *    the publishing rules. A draft changed since the preflight, closed, or
 *    no longer passing the gate is not published, with the reason. It
 *    carries on if the window is closed, and after a restart (resumed);
 *  - followers get ONE summary notification for the run, not one per
 *    product. Retrying = a new run over what was not published.
 */
@Injectable()
export class BulkPublishService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkPublishService.name);
  private readonly active = new Set<string>();
  private readonly task = new PeriodicTask(
    RESUME_INTERVAL_MS,
    () => this.resumeAll(),
    (err) => this.logger.error('Bulk publish resume failed', err as Error),
    BulkPublishService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: OfferDraftsService,
    private readonly offerPublish: OfferPublishService,
    private readonly auditLog: AuditLogService,
  ) {}

  onModuleInit() {
    // runs left RUNNING by a restart carry on (every 30 s, and soon after start)
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  async resumeAll() {
    const runs = await this.prisma.bulkPublishRun.findMany({
      where: { status: 'RUNNING' },
      select: { id: true },
      take: 20,
    });
    for (const r of runs) await this.process(r.id);
  }

  /** Read-only: the publish gate for each chosen draft. */
  async preflight(vendorId: string, draftIds: string[]) {
    const ids = [...new Set(draftIds)];
    const rows = await this.prisma.offerDraft.findMany({
      where: { id: { in: ids }, vendorId },
    });
    const items: {
      draft_id: string;
      title: string;
      revision: number | null;
      ready: boolean;
      state: 'OPEN' | 'PUBLISHED' | 'CLOSED' | 'NOT_FOUND';
      offer_id: string | null;
      problems: Problem[];
    }[] = [];
    for (const id of ids) {
      const d = rows.find((x) => x.id === id);
      if (!d) {
        items.push({
          draft_id: id,
          title: '',
          revision: null,
          ready: false,
          state: 'NOT_FOUND',
          offer_id: null,
          problems: [{ code: 'DRAFT_NOT_FOUND' }],
        });
        continue;
      }
      const base = {
        draft_id: d.id,
        title: titleOf(d.payload),
        revision: d.revision,
        offer_id: d.offerId,
      };
      if (d.status !== 'OPEN') {
        items.push({
          ...base,
          ready: false,
          state: d.status === 'SUBMITTED' && d.offerId ? 'PUBLISHED' : 'CLOSED',
          problems: [
            {
              code:
                d.status === 'SUBMITTED' ? 'ALREADY_PUBLISHED' : 'DRAFT_CLOSED',
            },
          ],
        });
        continue;
      }
      if (d.editOfOfferId) {
        items.push({
          ...base,
          ready: false,
          state: 'OPEN',
          problems: [{ code: 'EDIT_DRAFT' }],
        });
        continue;
      }
      const { problems } = await this.drafts.publishProblems(
        this.prisma,
        vendorId,
        d,
      );
      items.push({
        ...base,
        ready: problems.length === 0,
        state: 'OPEN',
        problems,
      });
    }
    return {
      items,
      ready: items.filter((i) => i.ready).length,
      not_ready: items.filter((i) => !i.ready).length,
    };
  }

  /** Starts a run over the drafts the owner confirmed (each with the revision she saw). */
  async start(
    vendorId: string,
    userId: string,
    correlationId: string,
    input: {
      items: { draft_id: string; expected_revision: number }[];
      import_batch_id?: string;
    },
  ) {
    const items = input.items.filter(
      (x, i, all) => all.findIndex((y) => y.draft_id === x.draft_id) === i,
    );
    if (items.length === 0 || items.length > MAX_BULK_PUBLISH)
      throw new BadRequestException({
        code: 'BULK_PUBLISH_SIZE',
        message: `Choose 1 to ${MAX_BULK_PUBLISH} drafts`,
      });
    const owned = await this.prisma.offerDraft.count({
      where: { id: { in: items.map((x) => x.draft_id) }, vendorId },
    });
    if (owned !== items.length)
      throw new NotFoundException({
        code: 'DRAFT_NOT_FOUND',
        message: 'A chosen draft does not belong to this store',
      });
    if (input.import_batch_id) {
      const b = await this.prisma.importBatch.count({
        where: { id: input.import_batch_id, vendorId },
      });
      if (b !== 1)
        throw new NotFoundException({
          code: 'IMPORT_NOT_FOUND',
          message: 'Import not found',
        });
    }
    let runId: string;
    try {
      runId = await this.prisma.$transaction(async (tx) => {
        const run = await tx.bulkPublishRun.create({
          data: {
            vendorId,
            actorId: userId,
            importBatchId: input.import_batch_id ?? null,
            correlationId,
            total: items.length,
            items: {
              create: items.map((x, i) => ({
                draftId: x.draft_id,
                position: i,
                expectedRevision: x.expected_revision,
              })),
            },
          },
        });
        await this.auditLog.record(
          {
            actorId: userId,
            correlationId,
            action: 'bulk_publish.started',
            entityType: 'BulkPublishRun',
            entityId: run.id,
            afterState: {
              vendor_id: vendorId,
              import_batch_id: input.import_batch_id ?? null,
              drafts: items.map((x) => x.draft_id),
            },
          },
          tx,
        );
        return run.id;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const running = await this.prisma.bulkPublishRun.findFirst({
          where: { vendorId, status: 'RUNNING' },
          select: { id: true, importBatchId: true },
        });
        throw new ConflictException({
          code: 'BULK_PUBLISH_RUNNING',
          message: 'A bulk publish is already running for this store',
          details: [
            {
              run_id: running?.id ?? null,
              import_batch_id: running?.importBatchId ?? null,
            },
          ],
        });
      }
      throw err;
    }
    // carries on in the background (and after a restart, via resumeAll)
    void this.process(runId).catch((err) =>
      this.logger.error(`Bulk publish ${runId} failed`, err as Error),
    );
    return this.get(vendorId, runId);
  }

  /** Publishes the run's waiting drafts one by one, then closes it (once). */
  async process(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    try {
      const run = await this.prisma.bulkPublishRun.findUnique({
        where: { id: runId },
      });
      if (!run || run.status !== 'RUNNING') return;
      const pending = await this.prisma.bulkPublishItem.findMany({
        where: { runId, state: 'PENDING' },
        orderBy: { position: 'asc' },
      });
      for (const item of pending) {
        let state: 'PUBLISHED' | 'REFUSED' | 'ALREADY' = 'REFUSED';
        let offerId: string | null = null;
        let problems: Problem[] | null = null;
        // a draft already published (this run before an interruption, or
        // elsewhere): settled without publishing anything again
        const settled = await this.settledByDraft(run, item.draftId);
        if (settled) {
          await this.record(item.id, settled);
          continue;
        }
        try {
          const r = await this.drafts.publish(
            run.vendorId,
            item.draftId,
            item.expectedRevision,
            run.actorId,
            run.correlationId,
            { notifyFollowers: false },
          );
          state = 'PUBLISHED';
          offerId = r.offer_id;
        } catch (err) {
          const body =
            err instanceof HttpException
              ? (err.getResponse() as {
                  code?: string;
                  details?: unknown;
                })
              : null;
          const code = body?.code ?? 'ERROR';
          if (code === 'DRAFT_CLOSED') {
            const d = (
              body?.details as { status?: string; offer_id?: string }[]
            )?.[0];
            if (d?.status === 'SUBMITTED' && d.offer_id) {
              const s = await this.settledByOffer(run, d.offer_id);
              state = s.state;
              offerId = s.offerId;
              problems = s.problems;
            } else problems = [{ code: 'DRAFT_CLOSED' }];
          } else if (code === 'DRAFT_NOT_PUBLISHABLE')
            problems = Array.isArray(body?.details)
              ? (body.details as Problem[])
              : [{ code }];
          else if (code === 'DRAFT_REVISION_CONFLICT')
            problems = [{ code: 'CHANGED' }];
          else {
            problems = [{ code }];
            if (!body)
              this.logger.error(
                `Bulk publish ${runId}: draft ${item.draftId} failed`,
                err as Error,
              );
          }
        }
        await this.record(item.id, { state, offerId, problems });
      }
      await this.finish(runId);
    } finally {
      this.active.delete(runId);
    }
  }

  private async record(
    itemId: string,
    r: {
      state: 'PUBLISHED' | 'REFUSED' | 'ALREADY';
      offerId: string | null;
      problems: Problem[] | null;
    },
  ) {
    await this.prisma.bulkPublishItem.updateMany({
      where: { id: itemId, state: 'PENDING' },
      data: {
        state: r.state,
        offerId: r.offerId,
        problems: r.problems ?? Prisma.DbNull,
        finishedAt: new Date(),
      },
    });
  }

  /** A waiting item whose draft is already published: how it was published (null = not yet). */
  private async settledByDraft(
    run: { correlationId: string; vendorId: string },
    draftId: string,
  ) {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId: run.vendorId },
      select: { status: true, offerId: true },
    });
    if (d?.status !== 'SUBMITTED' || !d.offerId) return null;
    return this.settledByOffer(run, d.offerId);
  }

  /**
   * A draft found already published. If THIS run published it - its product
   * exists, was really published (firstPublishedAt) and the activation was
   * audited under this run's correlation id - the server stopped between
   * publishing and recording: it is this run's PUBLISHED (recovered; counted
   * in the result and in the followers' summary). Otherwise it was
   * published elsewhere: ALREADY. Never published a second time.
   */
  private async settledByOffer(
    run: { correlationId: string; vendorId: string },
    offerId: string,
  ): Promise<{
    state: 'PUBLISHED' | 'ALREADY';
    offerId: string;
    problems: Problem[] | null;
  }> {
    const [offer, byThisRun] = await Promise.all([
      this.prisma.vendorOffer.findFirst({
        where: { id: offerId, vendorId: run.vendorId },
        select: { firstPublishedAt: true },
      }),
      this.prisma.auditLog.count({
        where: {
          action: 'vendor_offer.status_updated',
          entityId: offerId,
          correlationId: run.correlationId,
        },
      }),
    ]);
    return offer?.firstPublishedAt && byThisRun > 0
      ? { state: 'PUBLISHED', offerId, problems: [{ code: RECOVERED }] }
      : { state: 'ALREADY', offerId, problems: null };
  }

  /** Closes the run once: the followers' ONE summary, the audit. */
  private async finish(runId: string) {
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.bulkPublishRun.findUniqueOrThrow({
        where: { id: runId },
        include: { items: true },
      });
      const closed = await tx.bulkPublishRun.updateMany({
        where: { id: runId, status: 'RUNNING' },
        data: { status: 'DONE', finishedAt: new Date() },
      });
      if (closed.count !== 1) return;
      const published = run.items.filter((i) => i.state === 'PUBLISHED');
      if (published.length > 0)
        await this.offerPublish.enqueueFollowerNotification(
          tx,
          'offer.bulk_published_for_followers',
          run.vendorId,
          {
            count: published.length,
            offer_ids: published.map((i) => i.offerId),
            run_id: run.id,
          },
        );
      await this.auditLog.record(
        {
          actorId: run.actorId,
          correlationId: run.correlationId,
          action: 'bulk_publish.finished',
          entityType: 'BulkPublishRun',
          entityId: run.id,
          afterState: {
            published: published.map((i) => ({
              draft_id: i.draftId,
              offer_id: i.offerId,
            })),
            refused: run.items
              .filter((i) => i.state === 'REFUSED')
              .map((i) => i.draftId),
            already: run.items
              .filter((i) => i.state === 'ALREADY')
              .map((i) => i.draftId),
          },
        },
        tx,
      );
    });
  }

  async get(vendorId: string, runId: string) {
    const run = await this.prisma.bulkPublishRun.findFirst({
      where: { id: runId, vendorId },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { draft: { select: { payload: true } } },
        },
      },
    });
    if (!run)
      throw new NotFoundException({
        code: 'BULK_PUBLISH_NOT_FOUND',
        message: 'Bulk publish not found',
      });
    const count = (s: string) => run.items.filter((i) => i.state === s).length;
    return {
      id: run.id,
      status: run.status,
      import_batch_id: run.importBatchId,
      total: run.total,
      created_at: run.createdAt.toISOString(),
      finished_at: run.finishedAt?.toISOString() ?? null,
      counts: {
        pending: count('PENDING'),
        published: count('PUBLISHED'),
        refused: count('REFUSED'),
        already: count('ALREADY'),
      },
      items: run.items.map((i) => {
        const problems = (i.problems as Problem[] | null) ?? [];
        const recovered = problems.some((p) => p.code === RECOVERED);
        return {
          draft_id: i.draftId,
          title: titleOf(i.draft.payload),
          state: i.state,
          offer_id: i.offerId,
          recovered,
          problems: recovered ? [] : problems,
        };
      }),
    };
  }

  /**
   * The store's running run, if any (another tab, a closed window) - with
   * an import batch, only a run started from THAT batch (another batch's
   * run is never shown as this one's).
   */
  async current(vendorId: string, importBatchId?: string) {
    const run = await this.prisma.bulkPublishRun.findFirst({
      where: {
        vendorId,
        status: 'RUNNING',
        ...(importBatchId ? { importBatchId } : {}),
      },
      select: { id: true },
    });
    return { run: run ? await this.get(vendorId, run.id) : null };
  }
}
