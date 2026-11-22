import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { primaryMediaUrl } from '../discovery/comparison.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreCatalogService } from '../taxonomy/store-catalog.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { ownUploadProblem, parseOwnUploadUrl } from '../uploads/uploads.util';
import { storeDepartments } from '../taxonomy/storefront-catalogue';
import {
  BLOCK_VARIANTS,
  CARD_SHAPES,
  CONTENT_ALIGN,
  DISPLAY_STEPS,
  FINE_KEYS,
  PER_VIEW,
  PROMO_DIVIDERS,
  PROMO_LAYOUTS,
  PROMO_SHARES,
  DISPLAY_DEFAULTS,
  DISPLAY_KEYS,
  DISPLAY_VALUES,
  EMPTY_LAYOUT,
  FOCUS_POINTS,
  HOME_LIMITS,
  HOME_STYLES,
  HOME_TEMPLATES,
  type HomeLayout,
  layoutRefs,
  MIN_SHOWN_ITEMS,
  parseLayout,
  storedLayout,
  TEXT_LIMITS,
} from './store-home.layout';
import {
  IMAGE_MAX_GOOD_BYTES,
  IMAGE_SPECS,
  LONG_ON_IMAGE,
  qualityChecks,
} from './store-home.quality';
import { type BlockReview, HomeResolver } from './store-home.resolve';

const PICKER_PAGE_SIZE = 24;
const MAX_SEARCH_LENGTH = 80;

type Tx = Prisma.TransactionClient;

/**
 * «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the owner's home page
 * designer and what shoppers see of it. Behind `store_home_blocks_enabled`:
 * with it off every owner route is a 404 FEATURE_DISABLED and shoppers get
 * no blocks (the store page stays exactly as before).
 *
 * Writes (draft save, publish, discard) are serialised per store by an
 * advisory lock and carry the draft version the screen last saw - a write
 * from a stale screen (another tab, another device) is refused with 409
 * STORE_HOME_VERSION_CONFLICT, never silently overwriting newer work.
 */
@Injectable()
export class StoreHomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly catalog: StoreCatalogService,
    private readonly taxonomy: TaxonomyService,
    private readonly fulfilment: FulfilmentEligibilityService,
    private readonly auditLog: AuditLogService,
  ) {}

  enabled(): Promise<boolean> {
    return this.featureFlags.isEnabled('store_home_blocks_enabled');
  }

  async requireEnabled(): Promise<void> {
    if (!(await this.enabled())) {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'This feature is not currently available',
      });
    }
  }

  /** An image of THIS store's uploads that still exists. */
  private imageUsable(vendorId: string, url: string): boolean {
    const own = parseOwnUploadUrl(url);
    return (
      !!own &&
      own.vendorId === vendorId &&
      ownUploadProblem(url, vendorId) === null
    );
  }

  private async resolver(vendorId: string) {
    const [catalog, sections, taxonomy] = await Promise.all([
      this.catalog.load(vendorId),
      this.prisma.storeSection.findMany({
        where: { vendorId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          nameEn: true,
          coverUrl: true,
          isVisible: true,
        },
      }),
      this.taxonomy.get(),
    ]);
    // the store's fixed chips (its offered departments, in their order)
    const departments = (
      await storeDepartments(this.prisma, vendorId, taxonomy)
    ).map((d) => d.audience as string);
    return {
      resolver: new HomeResolver({
        catalog,
        sections,
        taxonomy,
        departments,
        imageUsable: (url) => this.imageUsable(vendorId, url),
      }),
      sections,
    };
  }

  // ------------------------------------------------------------- shoppers

  /** GET /storefronts/:slug/home - the published blocks as shoppers see them now. */
  async publicHome(slug: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { slug },
      select: { id: true, storefrontPublished: true, status: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    if (!(await this.enabled())) return { enabled: false, blocks: [] };
    const isAvailable =
      vendor.storefrontPublished && vendor.status === 'ACTIVE';
    if (!isAvailable) return { enabled: true, blocks: [] };
    const row = await this.prisma.storeHomeLayout.findUnique({
      where: { vendorId: vendor.id },
      select: { published: true },
    });
    const layout = storedLayout(row?.published ?? EMPTY_LAYOUT);
    if (layout.blocks.length === 0) return { enabled: true, blocks: [] };
    const { resolver } = await this.resolver(vendor.id);
    const { blocks } = resolver.layout(layout);
    if (blocks.length === 0) return { enabled: true, blocks: [] };
    // the page's look travels with its blocks (published together)
    return { enabled: true, blocks, style: layout.style };
  }

  // ---------------------------------------------------------------- owner

  /** The owner's screen: the draft, its live preview, why each block shows or not, and the choices. */
  async ownerView(vendorId: string) {
    const row = await this.prisma.storeHomeLayout.findUnique({
      where: { vendorId },
    });
    return this.view(vendorId, row);
  }

  private async view(
    vendorId: string,
    row: {
      draft: unknown;
      published: unknown;
      draftVersion: number;
      publishedVersion: number | null;
      publishedAt: Date | null;
    } | null,
  ) {
    const draft = storedLayout(row?.draft ?? EMPTY_LAYOUT);
    const published =
      row?.published == null ? null : storedLayout(row.published);
    const [{ resolver, sections }, vendor] = await Promise.all([
      this.resolver(vendorId),
      this.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        select: { slug: true },
      }),
    ]);
    const { blocks, review } = resolver.layout(draft);
    const refs = await this.refsOf(vendorId, draft, resolver, sections);
    const checks = this.checks(vendorId, draft, resolver, review, refs);

    return {
      enabled: true,
      slug: vendor.slug,
      draft,
      draft_version: row?.draftVersion ?? 0,
      published_version: row?.publishedVersion ?? null,
      published_at: row?.publishedAt?.toISOString() ?? null,
      has_published: published !== null && published.blocks.length > 0,
      has_unpublished_changes:
        JSON.stringify(draft) !== JSON.stringify(published ?? EMPTY_LAYOUT),
      preview: { blocks, style: draft.style },
      review,
      // «فحص قبل النشر»: errors stop «نشر», warnings never do
      checks,
      refs,
      options: {
        collections: sections.map((s) => ({
          id: s.id,
          name_ar: s.name,
          name_en: s.nameEn,
          visible: s.isVisible,
          count: resolver.collectionProducts(s.id).length,
        })),
        categories: resolver.categoryOptions(),
        new_count: resolver.autoProducts('new').length,
        sale_count: resolver.autoProducts('sale').length,
        // «بطاقات التصنيفات»: departments with products shoppers can buy now
        audiences: resolver.audienceOptions(),
      },
      limits: HOME_LIMITS,
      text_limits: TEXT_LIMITS,
      min_shown_items: MIN_SHOWN_ITEMS,
      // the block display choices (closed values per type, defaults = the look before they existed)
      display: {
        keys: DISPLAY_KEYS,
        values: DISPLAY_VALUES,
        defaults: DISPLAY_DEFAULTS,
        // P2: the fine sizes each type takes, their step ranges, alignments and counts per view
        fine_keys: FINE_KEYS,
        steps: DISPLAY_STEPS,
        align: CONTENT_ALIGN,
        per_view: PER_VIEW,
      },
      // the page's closed choices: styles, templates, block shapes, image focus
      choices: {
        styles: HOME_STYLES,
        templates: HOME_TEMPLATES,
        variants: BLOCK_VARIANTS,
        focus: FOCUS_POINTS,
        card_shapes: CARD_SHAPES,
        // «لوحة ترويجية»: layouts per tile count, the wide tile's part, dividers
        promo: {
          layouts: PROMO_LAYOUTS,
          shares: PROMO_SHARES,
          dividers: PROMO_DIVIDERS,
        },
        image_specs: IMAGE_SPECS,
        image_max_good_bytes: IMAGE_MAX_GOOD_BYTES,
        long_on_image: LONG_ON_IMAGE,
      },
    };
  }

  private checks(
    vendorId: string,
    layout: HomeLayout,
    resolver: HomeResolver,
    review: Record<string, BlockReview>,
    refs: Awaited<ReturnType<StoreHomeService['refsOf']>>,
  ) {
    return qualityChecks(layout, {
      resolver,
      review,
      offerStatus: (id) => refs.offers[id]?.status,
      collectionStatus: (id) => refs.collections[id]?.status,
      imageUsable: (url) => this.imageUsable(vendorId, url),
    });
  }

  /** What the owner's screen knows of each thing the layout points at. */
  private async refsOf(
    vendorId: string,
    draft: HomeLayout,
    resolver: HomeResolver,
    sections: {
      id: string;
      name: string;
      nameEn: string | null;
      isVisible: boolean;
    }[],
  ) {
    const refs = layoutRefs(draft);

    const offers = refs.offers.size
      ? await this.prisma.vendorOffer.findMany({
          where: { id: { in: [...refs.offers] }, vendorId },
          select: {
            id: true,
            titleAr: true,
            titleEn: true,
            status: true,
            variants: {
              select: { media: { select: { url: true, kind: true } } },
            },
          },
        })
      : [];
    const offerRefs = Object.fromEntries(
      [...refs.offers].map((id) => {
        const o = offers.find((x) => x.id === id);
        if (!o || o.status === 'ARCHIVED') {
          return [
            id,
            o
              ? {
                  title_ar: o.titleAr,
                  title_en: o.titleEn,
                  image_url: null,
                  status: 'missing',
                }
              : {
                  title_ar: null,
                  title_en: null,
                  image_url: null,
                  status: 'missing',
                },
          ];
        }
        const status =
          o.status !== 'ACTIVE'
            ? 'unpublished'
            : resolver.product(id)
              ? 'ok'
              : 'sold_out';
        return [
          id,
          {
            title_ar: o.titleAr,
            title_en: o.titleEn,
            image_url:
              o.variants.map((v) => primaryMediaUrl(v.media)).find((u) => u) ??
              null,
            status,
          },
        ];
      }),
    );
    const collectionRefs = Object.fromEntries(
      [...refs.collections].map((id) => {
        const s = sections.find((x) => x.id === id);
        if (!s)
          return [id, { name_ar: null, name_en: null, status: 'missing' }];
        const status = !s.isVisible
          ? 'hidden'
          : resolver.collectionProducts(id).length > 0
            ? 'ok'
            : 'empty';
        return [id, { name_ar: s.name, name_en: s.nameEn, status }];
      }),
    );
    const categoryRefs = Object.fromEntries(
      [...refs.categories].map((key) => {
        const [audience, category] = key.split('/');
        return [
          key,
          {
            ...resolver.categoryNames(audience, category),
            status:
              resolver.categoryProducts(audience, category).length > 0
                ? 'ok'
                : 'empty',
          },
        ];
      }),
    );
    const imageRefs = Object.fromEntries(
      [...refs.images].map((url) => [
        url,
        this.imageUsable(vendorId, url) ? 'ok' : 'missing',
      ]),
    );

    return {
      offers: offerRefs,
      collections: collectionRefs,
      categories: categoryRefs,
      images: imageRefs,
    };
  }

  private async lock(tx: Tx, vendorId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:store_home:' || ${vendorId}))`;
    return tx.storeHomeLayout.findUnique({ where: { vendorId } });
  }

  private checkVersion(current: number, sent: number) {
    if (current !== sent) {
      throw new ConflictException({
        code: 'STORE_HOME_VERSION_CONFLICT',
        message:
          'The home page was changed elsewhere (another tab or device) - reload it before saving',
        details: [{ current_version: current }],
      });
    }
  }

  /**
   * A NEW reference (one the stored draft/published did not already have)
   * must be this store's own: its uploads, its products (not archived), its
   * collections. A reference that was valid when added and is gone since is
   * kept (the screen warns about it; shoppers never see it) - so deleting a
   * product or a collection never blocks the owner's autosave.
   */
  private async checkReferences(
    tx: Tx,
    vendorId: string,
    layout: HomeLayout,
    known: HomeLayout[],
  ) {
    const refs = layoutRefs(layout);
    const before = known.map(layoutRefs);
    const isNew = (kind: 'offers' | 'collections' | 'images', v: string) =>
      !before.some((r) => r[kind].has(v));

    for (const url of refs.images) {
      if (!isNew('images', url)) continue;
      const problem = parseOwnUploadUrl(url)
        ? ownUploadProblem(url, vendorId)
        : 'Images must be uploaded by this store';
      if (problem) {
        throw new BadRequestException({
          code: 'UPLOAD_NOT_USABLE',
          message: problem,
          details: [{ url }],
        });
      }
    }
    const offers = [...refs.offers].filter((id) => isNew('offers', id));
    if (offers.length) {
      const found = await tx.vendorOffer.count({
        where: { id: { in: offers }, vendorId, status: { not: 'ARCHIVED' } },
      });
      if (found !== offers.length) {
        throw new NotFoundException({
          code: 'STORE_HOME_REFERENCE_NOT_FOUND',
          message: "A chosen product is not one of this store's products",
        });
      }
    }
    const collections = [...refs.collections].filter((id) =>
      isNew('collections', id),
    );
    if (collections.length) {
      const found = await tx.storeSection.count({
        where: { id: { in: collections }, vendorId },
      });
      if (found !== collections.length) {
        throw new NotFoundException({
          code: 'STORE_HOME_REFERENCE_NOT_FOUND',
          message: "A chosen collection is not one of this store's collections",
        });
      }
    }
    // categories: always one of the fixed taxonomy's, in its department
    const t = await this.taxonomy.get();
    for (const key of refs.categories) {
      const [audience, category] = key.split('/');
      if (!t.categoryAudiences.get(category)?.has(audience as never)) {
        throw new BadRequestException({
          code: 'STORE_HOME_INVALID',
          message: `${key}: not a category of this department`,
          details: [{ field: 'category', problem: key }],
        });
      }
    }
  }

  async saveDraft(vendorId: string, version: number, raw: unknown) {
    const layout = parseLayout(raw);
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, vendorId);
      this.checkVersion(current?.draftVersion ?? 0, version);
      await this.checkReferences(
        tx,
        vendorId,
        layout,
        current
          ? [
              storedLayout(current.draft),
              ...(current.published == null
                ? []
                : [storedLayout(current.published)]),
            ]
          : [],
      );
      const draft = layout as unknown as Prisma.InputJsonValue;
      return tx.storeHomeLayout.upsert({
        where: { vendorId },
        create: { vendorId, draft, draftVersion: 1 },
        update: { draft, draftVersion: version + 1 },
      });
    });
    return this.view(vendorId, row);
  }

  async publish(
    vendorId: string,
    version: number,
    actor: { userId: string; correlationId: string },
  ) {
    // what shoppers can see now (read before the lock - the check is advisory about stock)
    const { resolver, sections } = await this.resolver(vendorId);
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, vendorId);
      this.checkVersion(current?.draftVersion ?? 0, version);
      if (!current) {
        throw new BadRequestException({
          code: 'STORE_HOME_NOTHING_TO_PUBLISH',
          message: 'There is no home page draft to publish',
        });
      }
      const draft = storedLayout(current.draft);
      // «فحص قبل النشر»: only errors (unfinished or gone) stop the publish
      const { review } = resolver.layout(draft);
      const refs = await this.refsOf(vendorId, draft, resolver, sections);
      const { errors } = this.checks(vendorId, draft, resolver, review, refs);
      if (errors.length > 0) {
        throw new BadRequestException({
          code: 'STORE_HOME_NOT_READY',
          message: 'The home page has problems to fix before it is published',
          details: errors,
        });
      }
      const updated = await tx.storeHomeLayout.update({
        where: { vendorId },
        data: {
          published: draft as unknown as Prisma.InputJsonValue,
          publishedVersion: current.draftVersion,
          publishedAt: new Date(),
        },
      });
      await this.auditLog.record(
        {
          actorId: actor.userId,
          correlationId: actor.correlationId,
          action: 'store_home.published',
          entityType: 'Vendor',
          entityId: vendorId,
          beforeState: {
            published_version: current.publishedVersion,
            blocks: storedLayout(current.published ?? EMPTY_LAYOUT).blocks
              .length,
          },
          afterState: {
            published_version: updated.publishedVersion,
            blocks: draft.blocks.length,
            types: draft.blocks.map((b) => b.type),
            style: draft.style,
            template: draft.template,
          },
        },
        tx,
      );
      return updated;
    });
    return this.view(vendorId, row);
  }

  /** «تجاهل التغييرات»: the draft goes back to what shoppers see (empty when nothing was published). */
  async discard(
    vendorId: string,
    version: number,
    actor: { userId: string; correlationId: string },
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, vendorId);
      this.checkVersion(current?.draftVersion ?? 0, version);
      if (!current) return null;
      const back = storedLayout(current.published ?? EMPTY_LAYOUT);
      const updated = await tx.storeHomeLayout.update({
        where: { vendorId },
        data: {
          draft: back as unknown as Prisma.InputJsonValue,
          draftVersion: current.draftVersion + 1,
        },
      });
      await this.auditLog.record(
        {
          actorId: actor.userId,
          correlationId: actor.correlationId,
          action: 'store_home.draft_discarded',
          entityType: 'Vendor',
          entityId: vendorId,
          beforeState: { draft_version: current.draftVersion },
          afterState: {
            draft_version: updated.draftVersion,
            blocks: back.blocks.length,
          },
        },
        tx,
      );
      return updated;
    });
    return this.view(vendorId, row);
  }

  /**
   * «اختيار المنتجات»: this store's products (not archived), newest first,
   * by name - each saying whether shoppers can see it now.
   */
  async products(
    vendorId: string,
    q: string | undefined,
    pageRaw: string | undefined,
  ) {
    const search = (q ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
    const page = Math.max(
      1,
      Math.min(10_000, Number.parseInt(pageRaw ?? '1', 10) || 1),
    );
    const where: Prisma.VendorOfferWhereInput = {
      vendorId,
      status: { not: 'ARCHIVED' },
      ...(search
        ? {
            OR: [
              { titleAr: { contains: search, mode: 'insensitive' } },
              { titleEn: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, offers] = await Promise.all([
      this.prisma.vendorOffer.count({ where }),
      this.prisma.vendorOffer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PICKER_PAGE_SIZE,
        take: PICKER_PAGE_SIZE,
        select: {
          id: true,
          titleAr: true,
          titleEn: true,
          status: true,
          variants: {
            select: { id: true, media: { select: { url: true, kind: true } } },
          },
        },
      }),
    ]);
    const availability = await this.fulfilment.availableByVariant(
      offers.flatMap((o) => o.variants.map((v) => ({ id: v.id, vendorId }))),
    );
    return {
      total,
      page,
      page_size: PICKER_PAGE_SIZE,
      items: offers.map((o) => {
        const stock = o.variants.reduce(
          (n, v) => n + (availability.get(v.id)?.total ?? 0),
          0,
        );
        return {
          id: o.id,
          title_ar: o.titleAr,
          title_en: o.titleEn,
          image_url:
            o.variants.map((v) => primaryMediaUrl(v.media)).find((u) => u) ??
            null,
          status:
            o.status !== 'ACTIVE'
              ? 'unpublished'
              : stock > 0
                ? 'ok'
                : 'sold_out',
        };
      }),
    };
  }
}
