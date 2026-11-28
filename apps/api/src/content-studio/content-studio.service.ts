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
import { MediaUsageState, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PeriodicTask } from '../common/periodic-task.util';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';
import { previewQuery } from '../platform-media/media-storage';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContentDocument,
  ContentProblem,
  libraryAssets,
  mediaPlaces,
  MediaRef,
  parseDocument,
  publicationProblems,
  references,
  RefValue,
} from './content-document';
import {
  CONTENT_PAGES,
  ContentPageKey,
  SECTION_BY_KEY,
  SECTIONS,
} from './content-registry';
import { localWall, resolveLocalSchedule } from './content-schedule.util';

type Tx = Prisma.TransactionClient;
const WORKER_INTERVAL_MS = 30_000;
const usageOwner = (page: ContentPageKey) => `CONTENT_${page}`;

function notFound(): never {
  throw new NotFoundException({
    code: 'CONTENT_NOT_FOUND',
    message: 'Content not found',
  });
}

export function parsePage(raw: string): ContentPageKey {
  const p = String(raw ?? '').toUpperCase();
  if (!(CONTENT_PAGES as readonly string[]).includes(p)) {
    throw new NotFoundException({
      code: 'CONTENT_PAGE_UNKNOWN',
      message: 'Unknown page',
    });
  }
  return p as ContentPageKey;
}

/**
 * VIA phase 6 - Content Studio.
 *
 *  - One ContentPage per page: a working draft (optimistic draftVersion -
 *    a stale save is a 409, never a silent overwrite) and a pointer to its
 *    published, immutable ContentRevision.
 *  - Publish / schedule freeze the draft into a NEW revision after full
 *    validation (required Arabic + English copy, alt text, dependencies);
 *    a schedule targets that revision, so later draft edits never change
 *    it. One PENDING schedule per page (replace / cancel are explicit).
 *  - The worker executes due schedules exactly once (row lock + status,
 *    SKIP LOCKED), after downtime too; a dependency failure marks it
 *    FAILED with the reasons and leaves the live page untouched.
 *  - Every mutation re-syncs MediaUsage (draft, live, scheduled and every
 *    non-archived revision) in the same transaction, so referenced media
 *    stays protected by the Phase 5 rules.
 */
@Injectable()
export class ContentStudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContentStudioService.name);
  private readonly worker = new PeriodicTask(
    WORKER_INTERVAL_MS,
    () => this.runDueSchedules().then(() => undefined),
    (err) => this.logger.error('Content schedule worker failed', err as Error),
    'ContentScheduleWorker',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  onModuleInit() {
    this.worker.start();
  }
  onModuleDestroy() {
    this.worker.stop();
  }

  // ------------------------------------------------------------------
  // Locking, usage sync, audit

  private async lock(tx: Tx, page: ContentPageKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:content_page:' || ${page}))`;
    return tx.contentPage.findUnique({ where: { key: page } });
  }

  private checkVersion(current: number, sent: unknown) {
    if (typeof sent !== 'number' || current !== sent) {
      throw new ConflictException({
        code: 'CONTENT_VERSION_CONFLICT',
        message:
          'This page was changed by another administrator (or another tab) - reload it before saving',
        details: [{ current_version: current }],
      });
    }
  }

  private audit(
    tx: Tx,
    actorId: string | null,
    action: string,
    page: ContentPageKey,
    after?: Record<string, unknown>,
    correlationId?: string,
  ) {
    return this.auditLog.record(
      {
        actorId,
        correlationId: correlationId ?? randomUUID(),
        action,
        entityType: 'ContentPage',
        entityId: page,
        ...(after ? { afterState: after as Prisma.InputJsonValue } : {}),
      },
      tx,
    );
  }

  /** MediaUsage = exactly what the page references now (draft, live, scheduled, revisions). */
  private async syncUsages(tx: Tx, page: ContentPageKey) {
    const p = await tx.contentPage.findUnique({ where: { key: page } });
    if (!p) return;
    const pending = await tx.contentSchedule.findFirst({
      where: { pageKey: page, status: 'PENDING' },
    });
    const revisions = await tx.contentRevision.findMany({
      where: { pageKey: page, archivedAt: null },
    });
    const rows: {
      assetId: string;
      revisionId: string;
      state: MediaUsageState;
      label: string;
    }[] = [];
    const add = (
      doc: unknown,
      revisionId: string,
      state: MediaUsageState,
      label: string,
    ) => {
      for (const id of libraryAssets(doc as ContentDocument))
        rows.push({ assetId: id, revisionId, state, label });
    };
    add(p.draft, '', 'DRAFT', 'draft');
    for (const r of revisions) {
      const state: MediaUsageState =
        r.id === p.publishedRevisionId
          ? 'PUBLISHED'
          : r.id === pending?.revisionId
            ? 'SCHEDULED'
            : 'REVISION';
      add(r.document, r.id, state, `revision ${r.number}`);
    }
    await tx.mediaUsage.deleteMany({
      where: { ownerType: usageOwner(page), ownerId: page },
    });
    if (rows.length) {
      await tx.mediaUsage.createMany({
        data: rows.map((r) => ({
          ...r,
          ownerType: usageOwner(page),
          ownerId: page,
        })),
        skipDuplicates: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Dependencies (media and references) - before publication

  private async dependencyProblems(
    tx: Tx | PrismaService,
    doc: ContentDocument,
  ): Promise<ContentProblem[]> {
    const problems: ContentProblem[] = [];
    const enabled = new Set(
      doc.sections.filter((s) => s.enabled).map((s) => s.id),
    );
    const ids = [...libraryAssets(doc)];
    const assets = new Map(
      (
        await tx.mediaAsset.findMany({
          where: { id: { in: ids } },
          select: { id: true, kind: true, status: true, validationState: true },
        })
      ).map((a) => [a.id, a]),
    );
    for (const m of mediaPlaces(doc)) {
      if (!enabled.has(m.section.id) || m.media.source !== 'library') continue;
      const def = SECTION_BY_KEY.get(m.section.key)!;
      const fdef = (m.itemId ? def.items!.fields : def.fields).find(
        (f) => f.name === m.field,
      )!;
      const a = assets.get(m.media.assetId);
      const at = {
        section_id: m.section.id,
        section_key: m.section.key,
        item_id: m.itemId,
        field: m.field,
      };
      if (!a || a.validationState !== 'VALID' || a.status !== 'ACTIVE') {
        problems.push({
          ...at,
          code: 'MEDIA_UNAVAILABLE',
          message: 'The selected media file is missing or archived',
        });
      } else if (fdef.media && !fdef.media.includes(a.kind)) {
        problems.push({
          ...at,
          code: 'MEDIA_WRONG_KIND',
          message: `This field takes ${fdef.media.join(' or ').toLowerCase()}`,
        });
      }
    }
    const refs = references(doc).filter((r) => enabled.has(r.section.id));
    const unavailable = await this.unavailableRefs(
      tx,
      refs.map((r) => r.ref),
    );
    for (const r of refs) {
      if (unavailable.has(`${r.ref.refType}:${r.ref.refId}`)) {
        problems.push({
          section_id: r.section.id,
          section_key: r.section.key,
          item_id: r.itemId,
          field: r.field,
          code: 'REFERENCE_UNAVAILABLE',
          message: `The ${r.ref.refType} is not available to the public`,
        });
      }
    }
    return problems;
  }

  /** Public eligibility of each reference: live store, live collection, existing category, public offer. */
  private async unavailableRefs(
    tx: Tx | PrismaService,
    refs: RefValue[],
  ): Promise<Set<string>> {
    const of = (t: string) => [
      ...new Set(refs.filter((r) => r.refType === t).map((r) => r.refId)),
    ];
    const out = new Set<string>();
    const now = new Date();
    const stores = of('store');
    if (stores.length) {
      const ok = new Set(
        (
          await tx.vendor.findMany({
            where: {
              OR: [{ id: { in: stores } }, { slug: { in: stores } }],
              status: 'ACTIVE',
              storefrontPublished: true,
            },
            select: { id: true, slug: true },
          })
        ).flatMap((v) => [v.id, v.slug]),
      );
      stores.filter((s) => !ok.has(s)).forEach((s) => out.add(`store:${s}`));
    }
    const cols = of('collection');
    if (cols.length) {
      const ok = new Set(
        (
          await tx.platformCollection.findMany({
            where: {
              OR: [{ id: { in: cols } }, { slug: { in: cols } }],
              status: 'PUBLISHED',
              AND: [
                { OR: [{ publishFrom: null }, { publishFrom: { lte: now } }] },
                { OR: [{ publishUntil: null }, { publishUntil: { gt: now } }] },
              ],
            },
            select: { id: true, slug: true },
          })
        ).flatMap((c) => [c.id, c.slug]),
      );
      cols.filter((c) => !ok.has(c)).forEach((c) => out.add(`collection:${c}`));
    }
    const cats = of('category');
    if (cats.length) {
      const ok = new Set(
        (
          await tx.category.findMany({
            where: { id: { in: cats } },
            select: { id: true },
          })
        ).map((c) => c.id),
      );
      cats.filter((c) => !ok.has(c)).forEach((c) => out.add(`category:${c}`));
    }
    const products = of('product');
    if (products.length) {
      const ok = new Set(
        (
          await tx.vendorOffer.findMany({
            where: {
              id: { in: products },
              ...PUBLIC_OFFER,
              vendor: { status: 'ACTIVE', storefrontPublished: true },
            },
            select: { id: true },
          })
        ).map((o) => o.id),
      );
      products
        .filter((p) => !ok.has(p))
        .forEach((p) => out.add(`product:${p}`));
    }
    return out;
  }

  private async assertPublishable(tx: Tx, doc: ContentDocument) {
    const problems = [
      ...publicationProblems(doc),
      ...(await this.dependencyProblems(tx, doc)),
    ];
    if (problems.length) {
      throw new BadRequestException({
        code: 'CONTENT_NOT_PUBLISHABLE',
        message:
          'The content is not ready to publish - complete the missing items',
        details: problems,
      });
    }
  }

  private async nextRevision(
    tx: Tx,
    page: ContentPageKey,
    doc: ContentDocument,
    source: 'IMPORT' | 'PUBLISH' | 'SCHEDULE' | 'RESTORE',
    actorId: string | null,
    restoredFromId?: string,
  ) {
    const last = await tx.contentRevision.findFirst({
      where: { pageKey: page },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    return tx.contentRevision.create({
      data: {
        pageKey: page,
        number: (last?.number ?? 0) + 1,
        document: doc as unknown as Prisma.InputJsonValue,
        schemaVersion: doc.schemaVersion,
        source,
        createdById: actorId,
        restoredFromId: restoredFromId ?? null,
      },
    });
  }

  /** Library assets used by a draft must exist (an archived one is allowed in a draft - publication refuses it). */
  private async assertAssetsExist(tx: Tx, doc: ContentDocument) {
    const ids = [...libraryAssets(doc)];
    if (!ids.length) return;
    const found = await tx.mediaAsset.count({
      where: {
        id: { in: ids },
        validationState: 'VALID',
        status: { not: 'PURGING' },
      },
    });
    if (found !== ids.length) {
      throw new BadRequestException({
        code: 'CONTENT_MEDIA_UNKNOWN',
        message: 'A selected media file does not exist',
      });
    }
  }

  // ------------------------------------------------------------------
  // Admin reads

  registry() {
    return { schema_version: 1, pages: CONTENT_PAGES, sections: SECTIONS };
  }

  async overview() {
    const pages = await this.prisma.contentPage.findMany({
      include: {
        publishedRevision: { select: { number: true } },
        schedules: {
          where: { status: { in: ['PENDING', 'FAILED'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    const issues = await this.prisma.contentIssue.groupBy({
      by: ['pageKey'],
      where: { resolvedAt: null },
      _count: { _all: true },
    });
    return CONTENT_PAGES.map((key) => {
      const p = pages.find((x) => x.key === key);
      return {
        page: key,
        exists: !!p,
        published: !!p?.publishedRevisionId,
        published_revision: p?.publishedRevision?.number ?? null,
        published_at: p?.publishedAt?.toISOString() ?? null,
        draft_version: p?.draftVersion ?? null,
        draft_updated_at: p?.draftUpdatedAt.toISOString() ?? null,
        schedule: p?.schedules[0]
          ? {
              status: p.schedules[0].status,
              run_at: p.schedules[0].runAt.toISOString(),
              local_time: p.schedules[0].localTime,
            }
          : null,
        open_issues: issues.find((i) => i.pageKey === key)?._count._all ?? 0,
      };
    });
  }

  async detail(page: ContentPageKey) {
    const p = await this.prisma.contentPage.findUnique({
      where: { key: page },
    });
    if (!p) return { page, exists: false };
    const [revisions, schedules, issues] = await Promise.all([
      this.prisma.contentRevision.findMany({
        where: { pageKey: page },
        orderBy: { number: 'desc' },
        select: {
          id: true,
          number: true,
          source: true,
          createdAt: true,
          createdById: true,
          archivedAt: true,
          restoredFromId: true,
        },
      }),
      this.prisma.contentSchedule.findMany({
        where: { pageKey: page },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.contentIssue.findMany({
        where: { pageKey: page, resolvedAt: null },
        orderBy: { detectedAt: 'desc' },
      }),
    ]);
    const draft = p.draft as unknown as ContentDocument;
    const pending = schedules.find((s) => s.status === 'PENDING');
    const problems = [
      ...publicationProblems(draft),
      ...(await this.dependencyProblems(this.prisma, draft)),
    ];
    return {
      page,
      exists: true,
      draft,
      draft_version: p.draftVersion,
      draft_updated_at: p.draftUpdatedAt.toISOString(),
      draft_problems: problems,
      published_revision_id: p.publishedRevisionId,
      published_at: p.publishedAt?.toISOString() ?? null,
      unpublished_at: p.unpublishedAt?.toISOString() ?? null,
      revisions: revisions.map((r) => ({
        id: r.id,
        number: r.number,
        source: r.source,
        created_at: r.createdAt.toISOString(),
        archived_at: r.archivedAt?.toISOString() ?? null,
        restored_from_id: r.restoredFromId,
        live: r.id === p.publishedRevisionId,
        scheduled: r.id === pending?.revisionId,
        can_restore: !r.archivedAt && r.id !== p.publishedRevisionId,
        can_archive:
          !r.archivedAt &&
          r.id !== p.publishedRevisionId &&
          r.id !== pending?.revisionId,
      })),
      schedules: schedules.map((s) => ({
        id: s.id,
        revision_id: s.revisionId,
        status: s.status,
        run_at: s.runAt.toISOString(),
        local_time: s.localTime,
        attempts: s.attempts,
        last_error: s.lastError,
        failure_details: s.failureDetails,
        executed_at: s.executedAt?.toISOString() ?? null,
      })),
      issues: issues.map((i) => ({
        id: i.id,
        section_id: i.sectionId,
        item_id: i.itemId || null,
        field: i.field,
        kind: i.kind,
        detail: i.detail,
        detected_at: i.detectedAt.toISOString(),
        last_seen_at: i.lastSeenAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------
  // Mutations

  /** The site's current editorial content becomes revision 1, published as it is (no re-upload: bundled media). */
  async importCurrent(
    page: ContentPageKey,
    raw: unknown,
    actorId: string,
    correlationId?: string,
  ) {
    const doc = parseDocument(page, raw);
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.lock(tx, page);
      if (existing)
        throw new ConflictException({
          code: 'CONTENT_ALREADY_IMPORTED',
          message: 'This page already has managed content',
        });
      await this.assertAssetsExist(tx, doc);
      await tx.contentPage.create({
        data: {
          key: page,
          draft: doc as unknown as Prisma.InputJsonValue,
          draftUpdatedById: actorId,
        },
      });
      const rev = await this.nextRevision(tx, page, doc, 'IMPORT', actorId);
      await tx.contentPage.update({
        where: { key: page },
        data: {
          publishedRevisionId: rev.id,
          publishedAt: new Date(),
          publishedById: actorId,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.imported',
        page,
        { revision_id: rev.id, number: rev.number },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async saveDraft(
    page: ContentPageKey,
    version: unknown,
    raw: unknown,
    actorId: string,
    correlationId?: string,
  ) {
    const doc = parseDocument(page, raw);
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      this.checkVersion(p.draftVersion, version);
      await this.assertAssetsExist(tx, doc);
      await tx.contentPage.update({
        where: { key: page },
        data: {
          draft: doc as unknown as Prisma.InputJsonValue,
          draftVersion: p.draftVersion + 1,
          draftUpdatedAt: new Date(),
          draftUpdatedById: actorId,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.draft_saved',
        page,
        { draft_version: p.draftVersion + 1 },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async publish(
    page: ContentPageKey,
    version: unknown,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      this.checkVersion(p.draftVersion, version);
      const doc = parseDocument(page, p.draft);
      await this.assertPublishable(tx, doc);
      const rev = await this.nextRevision(tx, page, doc, 'PUBLISH', actorId);
      await tx.contentPage.update({
        where: { key: page },
        data: {
          publishedRevisionId: rev.id,
          publishedAt: new Date(),
          publishedById: actorId,
          unpublishedAt: null,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.published',
        page,
        { revision_id: rev.id, number: rev.number },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async unpublish(
    page: ContentPageKey,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      if (!p.publishedRevisionId)
        throw new ConflictException({
          code: 'CONTENT_NOT_PUBLISHED',
          message: 'This page is not published',
        });
      await tx.contentPage.update({
        where: { key: page },
        data: { publishedRevisionId: null, unpublishedAt: new Date() },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.unpublished',
        page,
        { revision_id: p.publishedRevisionId },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async schedule(
    page: ContentPageKey,
    body: {
      version?: unknown;
      local_date?: unknown;
      local_time?: unknown;
      occurrence?: unknown;
      replace?: unknown;
    },
    actorId: string,
    correlationId?: string,
  ) {
    const when = resolveLocalSchedule(
      body.local_date,
      body.local_time,
      body.occurrence,
    );
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      this.checkVersion(p.draftVersion, body.version);
      const doc = parseDocument(page, p.draft);
      await this.assertPublishable(tx, doc);
      const pending = await tx.contentSchedule.findFirst({
        where: { pageKey: page, status: 'PENDING' },
      });
      if (pending && body.replace !== true) {
        throw new ConflictException({
          code: 'CONTENT_SCHEDULE_EXISTS',
          message:
            'A publication is already scheduled for this page - replace or cancel it',
          details: [
            {
              schedule_id: pending.id,
              run_at: pending.runAt.toISOString(),
              local_time: pending.localTime,
            },
          ],
        });
      }
      if (pending)
        await tx.contentSchedule.update({
          where: { id: pending.id },
          data: { status: 'REPLACED', cancelledAt: new Date() },
        });
      const rev = await this.nextRevision(tx, page, doc, 'SCHEDULE', actorId);
      const s = await tx.contentSchedule.create({
        data: {
          pageKey: page,
          revisionId: rev.id,
          runAt: when.runAt,
          localTime: when.local,
          createdById: actorId,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        pending ? 'content.schedule_replaced' : 'content.scheduled',
        page,
        {
          schedule_id: s.id,
          revision_id: rev.id,
          run_at: when.runAt.toISOString(),
          local_time: when.local,
          replaced_id: pending?.id ?? null,
        },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async cancelSchedule(
    page: ContentPageKey,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, page);
      const pending = await tx.contentSchedule.findFirst({
        where: { pageKey: page, status: 'PENDING' },
      });
      if (!pending)
        throw new ConflictException({
          code: 'CONTENT_NO_SCHEDULE',
          message: 'Nothing is scheduled for this page',
        });
      await tx.contentSchedule.update({
        where: { id: pending.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.schedule_cancelled',
        page,
        { schedule_id: pending.id },
        correlationId,
      );
    });
    return this.detail(page);
  }

  /**
   * Executes one schedule. Exactly once: the row is locked (SKIP LOCKED for
   * the worker) and must still be in the expected status. A dependency
   * failure records FAILED with the reasons; the live page is unchanged.
   */
  private async execute(
    scheduleId: string,
    from: 'PENDING' | 'FAILED',
    actorId: string | null,
    skipLocked: boolean,
  ): Promise<'PUBLISHED' | 'FAILED' | 'SKIPPED'> {
    return this.prisma.$transaction(async (tx) => {
      const lock = skipLocked
        ? Prisma.sql`FOR UPDATE SKIP LOCKED`
        : Prisma.sql`FOR UPDATE`;
      const rows = await tx.$queryRaw<
        { id: string; pageKey: ContentPageKey }[]
      >`
        SELECT id, "pageKey" FROM content_schedules WHERE id = ${scheduleId} AND status = ${from}::"ContentScheduleStatus" ${lock}`;
      if (!rows.length) return 'SKIPPED';
      const page = rows[0].pageKey;
      await this.lock(tx, page);
      const s = await tx.contentSchedule.findUniqueOrThrow({
        where: { id: scheduleId },
        include: { revision: true },
      });
      if (s.status !== from) return 'SKIPPED';
      const doc = parseDocument(page, s.revision.document);
      const problems = s.revision.archivedAt
        ? [
            {
              code: 'REVISION_ARCHIVED',
              message: 'The scheduled revision was archived',
            } as unknown as ContentProblem,
          ]
        : [
            ...publicationProblems(doc),
            ...(await this.dependencyProblems(tx, doc)),
          ];
      if (problems.length) {
        await tx.contentSchedule.update({
          where: { id: s.id },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            lastError: problems
              .map((x) => x.message)
              .slice(0, 5)
              .join('; ')
              .slice(0, 1000),
            failureDetails: problems as unknown as Prisma.InputJsonValue,
          },
        });
        await this.syncUsages(tx, page);
        await this.audit(tx, actorId, 'content.schedule_failed', page, {
          schedule_id: s.id,
          problems: problems.length,
        });
        return 'FAILED';
      }
      await tx.contentPage.update({
        where: { key: page },
        data: {
          publishedRevisionId: s.revisionId,
          publishedAt: new Date(),
          publishedById: actorId,
          unpublishedAt: null,
        },
      });
      await tx.contentSchedule.update({
        where: { id: s.id },
        data: {
          status: 'PUBLISHED',
          attempts: { increment: 1 },
          executedAt: new Date(),
          lastError: null,
          failureDetails: Prisma.DbNull,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(tx, actorId, 'content.schedule_published', page, {
        schedule_id: s.id,
        revision_id: s.revisionId,
      });
      return 'PUBLISHED';
    });
  }

  /** The worker tick (also after downtime: every due PENDING schedule, however late). */
  async runDueSchedules(now = new Date()) {
    const due = await this.prisma.contentSchedule.findMany({
      where: { status: 'PENDING', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      take: 20,
      select: { id: true },
    });
    const result = { published: 0, failed: 0, skipped: 0 };
    for (const d of due) {
      try {
        const r = await this.execute(d.id, 'PENDING', null, true);
        if (r === 'PUBLISHED') result.published++;
        else if (r === 'FAILED') result.failed++;
        else result.skipped++;
      } catch (err) {
        this.logger.warn(
          `Content schedule ${d.id} not executed now (retried next tick): ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  async retrySchedule(
    page: ContentPageKey,
    scheduleId: string,
    actorId: string,
  ) {
    const s = await this.prisma.contentSchedule.findFirst({
      where: { id: scheduleId, pageKey: page },
    });
    if (!s) notFound();
    if (s.status !== 'FAILED')
      throw new ConflictException({
        code: 'CONTENT_SCHEDULE_NOT_FAILED',
        message: 'Only a failed publication can be retried',
      });
    const pendingOther = await this.prisma.contentSchedule.findFirst({
      where: { pageKey: page, status: 'PENDING' },
    });
    if (pendingOther)
      throw new ConflictException({
        code: 'CONTENT_SCHEDULE_EXISTS',
        message: 'Another publication is scheduled - cancel it first',
      });
    const r = await this.execute(scheduleId, 'FAILED', actorId, false);
    return { result: r, ...(await this.detail(page)) };
  }

  async restore(
    page: ContentPageKey,
    revisionId: string,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      const r = await tx.contentRevision.findFirst({
        where: { id: revisionId, pageKey: page },
      });
      if (!r) notFound();
      if (r.archivedAt)
        throw new ConflictException({
          code: 'CONTENT_REVISION_ARCHIVED',
          message: 'An archived revision cannot be restored',
        });
      if (r.id === p.publishedRevisionId)
        throw new ConflictException({
          code: 'CONTENT_REVISION_LIVE',
          message: 'This revision is already live',
        });
      const doc = parseDocument(page, r.document);
      await this.assertPublishable(tx, doc); // dependencies re-validated now
      const rev = await this.nextRevision(
        tx,
        page,
        doc,
        'RESTORE',
        actorId,
        r.id,
      );
      await tx.contentPage.update({
        where: { key: page },
        data: {
          publishedRevisionId: rev.id,
          publishedAt: new Date(),
          publishedById: actorId,
          unpublishedAt: null,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.restored',
        page,
        { restored_from: r.id, number: r.number, revision_id: rev.id },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async loadIntoDraft(
    page: ContentPageKey,
    revisionId: string,
    version: unknown,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      this.checkVersion(p.draftVersion, version);
      const r = await tx.contentRevision.findFirst({
        where: { id: revisionId, pageKey: page },
      });
      if (!r) notFound();
      await tx.contentPage.update({
        where: { key: page },
        data: {
          draft: r.document as Prisma.InputJsonValue,
          draftVersion: p.draftVersion + 1,
          draftUpdatedAt: new Date(),
          draftUpdatedById: actorId,
        },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.revision_loaded_into_draft',
        page,
        { revision_id: r.id },
        correlationId,
      );
    });
    return this.detail(page);
  }

  async archiveRevision(
    page: ContentPageKey,
    revisionId: string,
    actorId: string,
    correlationId?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lock(tx, page);
      if (!p) notFound();
      const r = await tx.contentRevision.findFirst({
        where: { id: revisionId, pageKey: page },
      });
      if (!r) notFound();
      if (r.archivedAt)
        throw new ConflictException({
          code: 'CONTENT_REVISION_ARCHIVED',
          message: 'Already archived',
        });
      const scheduled = await tx.contentSchedule.count({
        where: { revisionId, status: 'PENDING' },
      });
      if (r.id === p.publishedRevisionId || scheduled > 0) {
        throw new ConflictException({
          code: 'CONTENT_REVISION_IN_USE',
          message: 'A live or scheduled revision cannot be archived',
        });
      }
      await tx.contentRevision.update({
        where: { id: revisionId },
        data: { archivedAt: new Date(), archivedById: actorId },
      });
      await this.syncUsages(tx, page);
      await this.audit(
        tx,
        actorId,
        'content.revision_archived',
        page,
        { revision_id: r.id, number: r.number },
        correlationId,
      );
    });
    return this.detail(page);
  }

  // ------------------------------------------------------------------
  // Rendering: resolve media and references for the public page / previews

  private async resolve(
    page: ContentPageKey,
    doc: ContentDocument,
    mode: 'public' | 'preview',
    revisionId: string | null,
  ) {
    const ids = [...libraryAssets(doc)];
    const assets = new Map(
      (
        await this.prisma.mediaAsset.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            kind: true,
            status: true,
            validationState: true,
            sha256: true,
            storageKey: true,
            width: true,
            height: true,
          },
        })
      ).map((a) => [a.id, a]),
    );
    const refs = references(doc).map((r) => r.ref);
    const unavailable = await this.unavailableRefs(this.prisma, refs);
    const refData = await this.refDetails(
      refs.filter((r) => !unavailable.has(`${r.refType}:${r.refId}`)),
    );
    const issues: {
      sectionId: string;
      itemId: string;
      field: string;
      kind: string;
      detail: string;
    }[] = [];

    const media = (
      v: MediaRef,
      sectionId: string,
      itemId: string,
      field: string,
    ) => {
      if (v.source === 'bundled')
        return {
          kind: /\.(mp4|webm)$/i.test(v.path) ? 'VIDEO' : 'IMAGE',
          url: v.path,
          alt: v.alt ?? { ar: '', en: '' },
          width: null,
          height: null,
        };
      const a = assets.get(v.assetId);
      const live =
        a &&
        a.validationState === 'VALID' &&
        a.status !== 'PURGING' &&
        (mode === 'preview' || a.status === 'ACTIVE');
      if (!a || !live) {
        issues.push({
          sectionId,
          itemId,
          field,
          kind: 'MEDIA_UNAVAILABLE',
          detail: v.assetId,
        });
        return null;
      }
      const ext = a.storageKey!.split('.').pop();
      const url =
        mode === 'preview'
          ? `/media/preview/${a.id}?${previewQuery(a.id)}`
          : `/media/p/${a.id}/${a.sha256!.slice(0, 16)}.${ext}`;
      return {
        kind: a.kind,
        url,
        api_relative: true,
        alt: v.alt ?? { ar: '', en: '' },
        width: a.width,
        height: a.height,
      };
    };

    const sections = doc.sections
      .filter((s) => s.enabled)
      .map((s) => {
        const def = SECTION_BY_KEY.get(s.key)!;
        const fields = (
          values: Record<string, unknown>,
          itemId: string,
          defs = def.fields,
        ) => {
          const out: Record<string, unknown> = {};
          let broken = false;
          for (const d of defs) {
            const v = values[d.name];
            if (!v) {
              out[d.name] = null;
              continue;
            }
            if (d.type === 'media') {
              const m = media(v as MediaRef, s.id, itemId, d.name);
              out[d.name] = m;
              if (!m && d.required && !d.structural) broken = true;
            } else if (d.type === 'ref') {
              const r = v as RefValue;
              const k = `${r.refType}:${r.refId}`;
              if (unavailable.has(k)) {
                issues.push({
                  sectionId: s.id,
                  itemId,
                  field: d.name,
                  kind: 'REFERENCE_UNAVAILABLE',
                  detail: k,
                });
                out[d.name] = null;
                if (d.required) broken = true;
              } else out[d.name] = { ...r, ...(refData.get(k) ?? {}) };
            } else out[d.name] = v;
          }
          return { out, broken };
        };
        const top = fields(s.fields, '');
        // Optional content that cannot render safely is omitted; a broken
        // item is dropped; the section collapses when nothing is left.
        const items = s.items
          .map((it) => ({
            id: it.id,
            ...fields(it.fields, it.id, def.items?.fields ?? []),
          }))
          .filter((x) => !x.broken)
          .map((x) => ({ id: x.id, fields: x.out }));
        return {
          id: s.id,
          key: s.key,
          fields: top.out,
          items,
          collapsed: !!def.items && def.items.min > 0 && items.length === 0,
        };
      })
      .filter((s) => !s.collapsed);

    if (mode === 'public' && revisionId)
      await this.recordIssues(page, revisionId, issues);
    return { sections, issues };
  }

  private async refDetails(refs: RefValue[]) {
    const out = new Map<string, Record<string, unknown>>();
    const of = (t: string) => [
      ...new Set(refs.filter((r) => r.refType === t).map((r) => r.refId)),
    ];
    const stores = of('store');
    if (stores.length) {
      for (const v of await this.prisma.vendor.findMany({
        where: { OR: [{ id: { in: stores } }, { slug: { in: stores } }] },
        select: { id: true, slug: true, displayName: true, logoUrl: true },
      })) {
        const d = {
          slug: v.slug,
          name: v.displayName,
          logo_url: v.logoUrl,
          href: `/store/${v.slug}`,
        };
        out.set(`store:${v.id}`, d);
        out.set(`store:${v.slug}`, d);
      }
    }
    const cols = of('collection');
    if (cols.length) {
      for (const c of await this.prisma.platformCollection.findMany({
        where: { OR: [{ id: { in: cols } }, { slug: { in: cols } }] },
        select: { id: true, slug: true, titleAr: true, titleEn: true },
      })) {
        const d = {
          slug: c.slug,
          title: { ar: c.titleAr, en: c.titleEn },
          href: `/collections/${c.slug}`,
        };
        out.set(`collection:${c.id}`, d);
        out.set(`collection:${c.slug}`, d);
      }
    }
    const cats = of('category');
    if (cats.length) {
      for (const c of await this.prisma.category.findMany({
        where: { id: { in: cats } },
        select: { id: true, nameAr: true, nameEn: true },
      })) {
        out.set(`category:${c.id}`, { name: { ar: c.nameAr, en: c.nameEn } });
      }
    }
    const products = of('product');
    if (products.length) {
      for (const o of await this.prisma.vendorOffer.findMany({
        where: { id: { in: products } },
        select: {
          id: true,
          titleAr: true,
          titleEn: true,
          vendor: { select: { slug: true, displayName: true } },
          sharedMedia: {
            orderBy: { sortOrder: 'asc' },
            take: 1,
            select: { url: true },
          },
        },
      })) {
        out.set(`product:${o.id}`, {
          title: { ar: o.titleAr, en: o.titleEn ?? o.titleAr },
          store_name: o.vendor.displayName,
          image_url: o.sharedMedia[0]?.url ?? null,
          href: `/store/${o.vendor.slug}/products/${o.id}`,
        });
      }
    }
    return out;
  }

  private async recordIssues(
    page: ContentPageKey,
    revisionId: string,
    issues: {
      sectionId: string;
      itemId: string;
      field: string;
      kind: string;
      detail: string;
    }[],
  ) {
    try {
      const now = new Date();
      for (const i of issues) {
        await this.prisma.contentIssue.upsert({
          where: {
            revisionId_sectionId_itemId_field: {
              revisionId,
              sectionId: i.sectionId,
              itemId: i.itemId,
              field: i.field,
            },
          },
          create: {
            pageKey: page,
            revisionId,
            sectionId: i.sectionId,
            itemId: i.itemId,
            field: i.field,
            kind: i.kind,
            detail: i.detail,
          },
          update: {
            lastSeenAt: now,
            resolvedAt: null,
            kind: i.kind,
            detail: i.detail,
          },
        });
      }
      const seen = new Set(
        issues.map((i) => `${i.sectionId}|${i.itemId}|${i.field}`),
      );
      const open = await this.prisma.contentIssue.findMany({
        where: { pageKey: page, resolvedAt: null },
      });
      const fixed = open.filter(
        (o) =>
          o.revisionId !== revisionId ||
          !seen.has(`${o.sectionId}|${o.itemId}|${o.field}`),
      );
      if (fixed.length)
        await this.prisma.contentIssue.updateMany({
          where: { id: { in: fixed.map((f) => f.id) } },
          data: { resolvedAt: now },
        });
    } catch (err) {
      this.logger.warn(
        `Content issues not recorded: ${(err as Error).message}`,
      );
    }
  }

  /** GET /content/:page - the live content, or { published: false } (the page shell stays). */
  async publicView(page: ContentPageKey) {
    const p = await this.prisma.contentPage.findUnique({
      where: { key: page },
      include: { publishedRevision: true },
    });
    if (!p) return { page, managed: false, published: false };
    if (!p.publishedRevision) return { page, managed: true, published: false };
    const doc = parseDocument(page, p.publishedRevision.document);
    const r = await this.resolve(page, doc, 'public', p.publishedRevision.id);
    return {
      page,
      managed: true,
      published: true,
      revision: p.publishedRevision.number,
      published_at: p.publishedAt?.toISOString() ?? null,
      sections: r.sections,
    };
  }

  /** Admin preview of the draft (default) or a revision, rendered the same way, with what is missing. */
  async preview(page: ContentPageKey, revisionId?: string) {
    const p = await this.prisma.contentPage.findUnique({
      where: { key: page },
    });
    if (!p) notFound();
    let doc: ContentDocument;
    if (revisionId) {
      const r = await this.prisma.contentRevision.findFirst({
        where: { id: revisionId, pageKey: page },
      });
      if (!r) notFound();
      doc = parseDocument(page, r.document);
    } else doc = parseDocument(page, p.draft);
    const r = await this.resolve(page, doc, 'preview', null);
    const problems = [
      ...publicationProblems(doc),
      ...(await this.dependencyProblems(this.prisma, doc)),
    ];
    return {
      page,
      managed: true,
      published: true,
      preview: revisionId ? 'revision' : 'draft',
      sections: r.sections,
      problems,
    };
  }

  /** For the schedule UI: what a local time would be. */
  localNow() {
    return { time_zone: 'Asia/Hebron', now_local: localWall(new Date()) };
  }
}
