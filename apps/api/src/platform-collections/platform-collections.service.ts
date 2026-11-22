import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PlatformCollectionStatus,
  Prisma,
  ProductAudience,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

/** PD-5b: at most this many products in one collection (the DB trigger agrees). */
export const MAX_COLLECTION_ITEMS = 24;
/** Serialises collection creation/ordering (the display order). */
const ORDER_LOCK = 'finalpro:platform_collections:order';

type Tx = Prisma.TransactionClient;

interface CollectionInput {
  slug?: string;
  title_ar?: string;
  title_en?: string;
  description_ar?: string | null;
  description_en?: string | null;
  audience?: ProductAudience | null;
  show_on_home?: boolean;
  publish_from?: Date | null;
  publish_until?: Date | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** Why an item would not be shown to shoppers (the admin's view only). */
function itemNote(p: {
  status: string;
  mergedIntoId: string | null;
}): 'MERGED' | 'ARCHIVED' | 'NOT_PUBLISHED' | null {
  if (p.status === 'MERGED') return 'MERGED';
  if (p.status === 'ARCHIVED') return 'ARCHIVED';
  if (p.status !== 'PUBLISHED') return 'NOT_PUBLISHED';
  return null;
}

/**
 * PD-5b.1: platform editorial collections - PLATFORM_ADMIN only (the
 * controller guards it). DRAFT -> PUBLISHED -> ARCHIVED, and reopen takes
 * ARCHIVED -> DRAFT only (taking a PUBLISHED collection off without
 * archiving it would be a separate, explicitly named operation - none
 * exists). A collection that was ever published is archived, never
 * deleted. Every change is audited. Nothing here is read
 * by a public page yet (PD-5b.2).
 */
@Injectable()
export class PlatformCollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private notFound() {
    return new NotFoundException({
      code: 'COLLECTION_NOT_FOUND',
      message: 'Collection not found',
    });
  }

  private dto(c: {
    id: string;
    slug: string;
    titleAr: string;
    titleEn: string;
    descriptionAr: string | null;
    descriptionEn: string | null;
    audience: ProductAudience | null;
    showOnHome: boolean;
    status: PlatformCollectionStatus;
    publishFrom: Date | null;
    publishUntil: Date | null;
    sortOrder: number;
    firstPublishedAt: Date | null;
    publishedAt: Date | null;
    archivedAt: Date | null;
    updatedAt: Date;
  }) {
    const now = new Date();
    return {
      id: c.id,
      slug: c.slug,
      title_ar: c.titleAr,
      title_en: c.titleEn,
      description_ar: c.descriptionAr,
      description_en: c.descriptionEn,
      audience: c.audience,
      show_on_home: c.showOnHome,
      status: c.status,
      publish_from: c.publishFrom?.toISOString() ?? null,
      publish_until: c.publishUntil?.toISOString() ?? null,
      // Live = what PD-5b.2 will show: published and inside the window.
      live:
        c.status === 'PUBLISHED' &&
        (!c.publishFrom || c.publishFrom <= now) &&
        (!c.publishUntil || c.publishUntil > now),
      sort_order: c.sortOrder,
      ever_published: c.firstPublishedAt !== null,
      published_at: c.publishedAt?.toISOString() ?? null,
      archived_at: c.archivedAt?.toISOString() ?? null,
      updated_at: c.updatedAt.toISOString(),
    };
  }

  private assertWindow(from: Date | null, until: Date | null) {
    if (from && until && until <= from) {
      throw new BadRequestException({
        code: 'INVALID_PUBLISH_WINDOW',
        message: 'publish_until must be after publish_from',
      });
    }
  }

  /** Locks the collection row for this transaction (or 404). */
  private async lock(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM platform_collections WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) throw this.notFound();
    return tx.platformCollection.findUniqueOrThrow({ where: { id } });
  }

  async list() {
    const rows = await this.prisma.platformCollection.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { items: true } } },
    });
    return rows.map((c) => ({ ...this.dto(c), item_count: c._count.items }));
  }

  async detail(id: string, db: Tx | PrismaService = this.prisma) {
    const c = await db.platformCollection.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            canonicalProduct: {
              select: {
                id: true,
                canonicalNameAr: true,
                modelName: true,
                status: true,
                mergedIntoId: true,
              },
            },
          },
        },
      },
    });
    if (!c) throw this.notFound();
    return {
      ...this.dto(c),
      items: c.items.map((i) => ({
        canonical_product_id: i.canonicalProductId,
        name:
          i.canonicalProduct.canonicalNameAr ?? i.canonicalProduct.modelName,
        product_status: i.canonicalProduct.status,
        // Shown to the admin: why this item won't appear (merged items
        // are read through their survivor in PD-5b.2).
        note: itemNote(i.canonicalProduct),
        merged_into_id: i.canonicalProduct.mergedIntoId,
        sort_order: i.sortOrder,
      })),
    };
  }

  async create(
    actorId: string,
    correlationId: string | undefined,
    input: CollectionInput,
  ) {
    this.assertWindow(input.publish_from ?? null, input.publish_until ?? null);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ORDER_LOCK}))`;
        const last = await tx.platformCollection.aggregate({
          _max: { sortOrder: true },
        });
        const c = await tx.platformCollection.create({
          data: {
            slug: input.slug!,
            titleAr: input.title_ar!.trim(),
            titleEn: input.title_en!.trim(),
            descriptionAr: input.description_ar?.trim() || null,
            descriptionEn: input.description_en?.trim() || null,
            audience: input.audience ?? null,
            showOnHome: input.show_on_home ?? false,
            publishFrom: input.publish_from ?? null,
            publishUntil: input.publish_until ?? null,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
            createdById: actorId,
          },
        });
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'platform_collection.created',
            entityType: 'PlatformCollection',
            entityId: c.id,
            afterState: this.dto(c),
          },
          tx,
        );
        return c.id;
      });
      return this.detail(id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'COLLECTION_SLUG_TAKEN',
          message: 'Another collection already uses this slug',
        });
      }
      throw err;
    }
  }

  async update(
    actorId: string,
    correlationId: string | undefined,
    id: string,
    input: CollectionInput,
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const c = await this.lock(tx, id);
        if (c.status === 'ARCHIVED') {
          throw new ConflictException({
            code: 'COLLECTION_ARCHIVED',
            message: 'Reopen the collection before editing it',
          });
        }
        if (
          input.slug !== undefined &&
          input.slug !== c.slug &&
          c.firstPublishedAt
        ) {
          throw new ConflictException({
            code: 'COLLECTION_SLUG_LOCKED',
            message:
              'The slug of a collection that was published cannot change',
          });
        }
        const next = {
          slug: input.slug ?? c.slug,
          titleAr: input.title_ar?.trim() ?? c.titleAr,
          titleEn: input.title_en?.trim() ?? c.titleEn,
          descriptionAr:
            input.description_ar === undefined
              ? c.descriptionAr
              : input.description_ar?.trim() || null,
          descriptionEn:
            input.description_en === undefined
              ? c.descriptionEn
              : input.description_en?.trim() || null,
          audience: input.audience === undefined ? c.audience : input.audience,
          showOnHome: input.show_on_home ?? c.showOnHome,
          publishFrom:
            input.publish_from === undefined
              ? c.publishFrom
              : input.publish_from,
          publishUntil:
            input.publish_until === undefined
              ? c.publishUntil
              : input.publish_until,
        };
        this.assertWindow(next.publishFrom, next.publishUntil);
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
          (k) => {
            const a = next[k];
            const b = c[k];
            return a instanceof Date || b instanceof Date
              ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime()
              : a !== b;
          },
        );
        if (changed.length === 0) return;
        const updated = await tx.platformCollection.update({
          where: { id },
          data: next,
        });
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'platform_collection.updated',
            entityType: 'PlatformCollection',
            entityId: id,
            beforeState: this.dto(c),
            afterState: { ...this.dto(updated), changed },
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'COLLECTION_SLUG_TAKEN',
          message: 'Another collection already uses this slug',
        });
      }
      throw err;
    }
    return this.detail(id);
  }

  /** Replaces the whole ordered item list (≤24, no duplicates). */
  async setItems(
    actorId: string,
    correlationId: string | undefined,
    id: string,
    productIds: string[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status === 'ARCHIVED') {
        throw new ConflictException({
          code: 'COLLECTION_ARCHIVED',
          message: 'Reopen the collection before editing it',
        });
      }
      const before = (
        await tx.platformCollectionItem.findMany({
          where: { collectionId: id },
          orderBy: { sortOrder: 'asc' },
          select: { canonicalProductId: true },
        })
      ).map((i) => i.canonicalProductId);
      const products = productIds.length
        ? await tx.canonicalProduct.findMany({
            where: { id: { in: productIds } },
            select: { id: true, status: true, mergedIntoId: true },
          })
        : [];
      if (products.length !== productIds.length) {
        throw new NotFoundException({
          code: 'CANONICAL_PRODUCT_NOT_FOUND',
          message: 'One of the products does not exist',
        });
      }
      // A product already in the collection may stay (it is shown to the
      // admin with its reason); a NEW one must not be archived or merged.
      const added = productIds.filter((p) => !before.includes(p));
      const addedRows = products.filter((p) => added.includes(p.id));
      const merged = addedRows.find((p) => p.status === 'MERGED');
      if (merged) {
        throw new ConflictException({
          code: 'CANONICAL_PRODUCT_MERGED',
          message:
            'This product was merged into another one - add that one instead',
          details: [
            {
              canonical_product_id: merged.id,
              merged_into_id: merged.mergedIntoId,
            },
          ],
        });
      }
      if (addedRows.some((p) => p.status === 'ARCHIVED')) {
        throw new ConflictException({
          code: 'CANONICAL_PRODUCT_ARCHIVED',
          message: 'An archived product cannot be added',
        });
      }
      if (before.join() === productIds.join()) return this.detail(id, tx);

      await tx.platformCollectionItem.deleteMany({
        where: { collectionId: id },
      });
      if (productIds.length) {
        await tx.platformCollectionItem.createMany({
          data: productIds.map((canonicalProductId, sortOrder) => ({
            collectionId: id,
            canonicalProductId,
            sortOrder,
            addedById: actorId,
          })),
        });
      }
      const removed = before.filter((p) => !productIds.includes(p));
      const keptAfter = productIds.filter((p) => before.includes(p));
      const keptBefore = before.filter((p) => productIds.includes(p));
      const record = (action: string, extra: Record<string, unknown>) =>
        this.audit.record(
          {
            actorId,
            correlationId,
            action,
            entityType: 'PlatformCollection',
            entityId: id,
            beforeState: { canonical_product_ids: before },
            afterState: { canonical_product_ids: productIds, ...extra },
          },
          tx,
        );
      if (added.length)
        await record('platform_collection_item.added', { added });
      if (removed.length)
        await record('platform_collection_item.removed', { removed });
      if (keptAfter.join() !== keptBefore.join())
        await record('platform_collection_item.reordered', {});
      return this.detail(id, tx);
    });
  }

  private async transition(
    actorId: string,
    correlationId: string | undefined,
    id: string,
    action: 'publish' | 'archive' | 'reopen',
  ) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      const now = new Date();
      let data: Prisma.PlatformCollectionUpdateInput;
      if (action === 'publish') {
        if (c.status !== 'DRAFT')
          throw this.badTransition(c.status, 'PUBLISHED');
        this.assertWindow(c.publishFrom, c.publishUntil);
        data = {
          status: 'PUBLISHED',
          publishedAt: now,
          firstPublishedAt: c.firstPublishedAt ?? now,
          archivedAt: null,
        };
      } else if (action === 'archive') {
        if (c.status === 'ARCHIVED')
          throw this.badTransition(c.status, 'ARCHIVED');
        if (!c.firstPublishedAt) {
          throw new ConflictException({
            code: 'COLLECTION_NEVER_PUBLISHED',
            message:
              'A draft that was never published is deleted, not archived',
          });
        }
        data = { status: 'ARCHIVED', archivedAt: now };
      } else {
        // Only an archived collection is reopened (PUBLISHED -> DRAFT is not a reopen).
        if (c.status !== 'ARCHIVED')
          throw this.badTransition(c.status, 'DRAFT');
        data = { status: 'DRAFT', archivedAt: null };
      }
      const updated = await tx.platformCollection.update({
        where: { id },
        data,
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: `platform_collection.${action === 'publish' ? 'published' : action === 'archive' ? 'archived' : 'reopened'}`,
          entityType: 'PlatformCollection',
          entityId: id,
          beforeState: { status: c.status },
          afterState: { status: updated.status },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  private badTransition(from: string, to: string) {
    return new ConflictException({
      code: 'INVALID_COLLECTION_TRANSITION',
      message: `A ${from} collection cannot become ${to}`,
    });
  }

  publish(actorId: string, correlationId: string | undefined, id: string) {
    return this.transition(actorId, correlationId, id, 'publish');
  }

  archive(actorId: string, correlationId: string | undefined, id: string) {
    return this.transition(actorId, correlationId, id, 'archive');
  }

  reopen(actorId: string, correlationId: string | undefined, id: string) {
    return this.transition(actorId, correlationId, id, 'reopen');
  }

  /** Only a draft that was never published may be deleted. */
  async remove(actorId: string, correlationId: string | undefined, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status !== 'DRAFT' || c.firstPublishedAt) {
        throw new ConflictException({
          code: 'COLLECTION_NOT_DELETABLE',
          message:
            'A collection that was ever published is archived, not deleted',
        });
      }
      const items = await tx.platformCollectionItem.count({
        where: { collectionId: id },
      });
      await tx.platformCollection.delete({ where: { id } });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'platform_collection.deleted',
          entityType: 'PlatformCollection',
          entityId: id,
          beforeState: { ...this.dto(c), item_count: items },
        },
        tx,
      );
    });
  }

  /** The display order of every collection (the full list, exactly). */
  async order(
    actorId: string,
    correlationId: string | undefined,
    ids: string[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ORDER_LOCK}))`;
      const all = await tx.platformCollection.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      const current = all.map((c) => c.id);
      if (
        current.length !== ids.length ||
        current.some((c) => !ids.includes(c))
      ) {
        throw new BadRequestException({
          code: 'COLLECTION_ORDER_MISMATCH',
          message: 'Send every collection exactly once',
        });
      }
      if (current.join() === ids.join()) return;
      for (const [sortOrder, id] of ids.entries()) {
        await tx.platformCollection.update({
          where: { id },
          data: { sortOrder },
        });
      }
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'platform_collection.reordered',
          entityType: 'PlatformCollection',
          entityId: ids[0],
          beforeState: { collection_ids: current },
          afterState: { collection_ids: ids },
        },
        tx,
      );
    });
    return this.list();
  }
}
