import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductAudience,
  SizeGroup,
  SizeGuideKind,
  SizeMeasureBasis,
  SizeMeasureKey,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertPublishable,
  DraftInput,
  fromTenths,
  groupForAudiences,
  guideFitsSize,
  MEASURE_LABEL,
  NormalisedDraft,
  normaliseDraft,
  ONE_SIZE,
  SizeGuideRuleError,
  SizeInfo,
  isSizeGuideCategory,
  measureKeysFor,
  OfferMeasurementsInput,
  offerMeasurementsDraft,
} from './size-guide-rules';

type Db = PrismaService | Prisma.TransactionClient;
const AUDIENCE_ORDER: ProductAudience[] = ['WOMEN', 'MEN', 'KIDS'];

/** A guide that has a PUBLISHED version, with what resolution needs. */
interface PublishedGuide {
  guideId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: SizeGuideKind;
  canonicalProductId: string | null;
  vendorOfferId: string | null;
  versionId: string;
  version: number;
  basis: SizeMeasureBasis;
  publishedAt: Date;
  sizeCodes: Set<string>;
  applicability: {
    categoryCode: string;
    audience: ProductAudience;
    isDefault: boolean;
  }[];
}
interface Catalog {
  standard: PublishedGuide[];
  productByCanonical: Map<string, PublishedGuide>;
  /** Phase A+: an offer's own measurements (kind OFFER), by offer id. */
  offerByOffer: Map<string, PublishedGuide>;
}
interface OfferFacts {
  id: string;
  vendorId: string;
  status: string;
  titleAr: string;
  audiences: ProductAudience[];
  categories: string[];
  canonicalProductId: string | null;
  sizeGuideId: string | null;
  sizes: { code: string; group: SizeGroup }[];
}
export interface ResolvedGuide {
  guide: PublishedGuide;
  /** The offer audiences this guide is shown for ('ALL' for a PRODUCT guide). */
  audiences: ProductAudience[] | 'ALL';
}
export interface Compatibility {
  /** A published guide applies to at least one of the offer's sizes. */
  checked: boolean;
  /** Offer sizes that a guide applies to but does not describe. */
  mismatched: string[];
  /** ONE_SIZE present and exempt (no explicit ONE_SIZE row). */
  oneSizeExempt: boolean;
}

function ruleError(err: unknown): never {
  if (err instanceof SizeGuideRuleError) {
    throw new BadRequestException({
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }
  throw err;
}
function isUniqueViolation(err: unknown, target?: string): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  )
    return false;
  return target ? JSON.stringify(err.meta ?? {}).includes(target) : true;
}
const notFound = () =>
  new NotFoundException({
    code: 'SIZE_GUIDE_NOT_FOUND',
    message: 'Size guide not found',
  });

/**
 * PD-4 (PD-FR-003): size guides. Platform data - PLATFORM_ADMIN writes
 * them (controllers guard that); a store only chooses among applicable
 * published guides or sends a request. Resolution for an offer:
 *   1. its canonical product's PRODUCT guide, if published;
 *   2. else, per offer audience, the STANDARD guide the owner chose (if
 *      still applicable), else the pair's default, else the only one.
 * A guide only "applies" once it has a PUBLISHED version - before that
 * nothing is shown and nothing is enforced.
 */
@Injectable()
export class SizeGuidesService {
  /** Published versions are immutable, so their content can be cached by id. */
  private readonly contentCache = new Map<
    string,
    ReturnType<SizeGuidesService['contentDto']>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ------------------------------------------------------------------
  // Resolution and compatibility (shared by every caller)
  // ------------------------------------------------------------------

  async loadCatalog(db: Db = this.prisma): Promise<Catalog> {
    const versions = await db.sizeGuideVersion.findMany({
      where: { status: 'PUBLISHED' },
      select: {
        id: true,
        version: true,
        basis: true,
        publishedAt: true,
        rows: { select: { sizeCode: true } },
        guide: {
          select: {
            id: true,
            code: true,
            nameAr: true,
            nameEn: true,
            kind: true,
            canonicalProductId: true,
            vendorOfferId: true,
            applicability: {
              select: { categoryCode: true, audience: true, isDefault: true },
            },
          },
        },
      },
    });
    const all: PublishedGuide[] = versions.map((v) => ({
      guideId: v.guide.id,
      code: v.guide.code,
      nameAr: v.guide.nameAr,
      nameEn: v.guide.nameEn,
      kind: v.guide.kind,
      canonicalProductId: v.guide.canonicalProductId,
      vendorOfferId: v.guide.vendorOfferId,
      versionId: v.id,
      version: v.version,
      basis: v.basis,
      publishedAt: v.publishedAt!,
      sizeCodes: new Set(v.rows.map((r) => r.sizeCode)),
      // PD-4 closing round: a link to a category that takes no guide
      // (accessories), e.g. left over from before the check, is ignored.
      applicability: v.guide.applicability.filter((p) =>
        isSizeGuideCategory(p.categoryCode),
      ),
    }));
    return {
      standard: all.filter((g) => g.kind === 'STANDARD'),
      productByCanonical: new Map(
        all
          .filter((g) => g.kind === 'PRODUCT')
          .map((g) => [g.canonicalProductId!, g]),
      ),
      offerByOffer: new Map(
        all.filter((g) => g.kind === 'OFFER').map((g) => [g.vendorOfferId!, g]),
      ),
    };
  }

  async offerFacts(
    offerIds: string[],
    db: Db = this.prisma,
  ): Promise<Map<string, OfferFacts>> {
    if (offerIds.length === 0) return new Map();
    const offers = await db.vendorOffer.findMany({
      where: { id: { in: offerIds } },
      select: {
        id: true,
        vendorId: true,
        status: true,
        titleAr: true,
        canonicalProductId: true,
        sizeGuideId: true,
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
        variants: {
          where: { isCombination: true, sizeCode: { not: null } },
          select: { sizeOption: { select: { code: true, group: true } } },
        },
      },
    });
    return new Map(
      offers.map((o) => {
        const sizes = new Map<string, SizeGroup>();
        for (const v of o.variants)
          if (v.sizeOption) sizes.set(v.sizeOption.code, v.sizeOption.group);
        return [
          o.id,
          {
            id: o.id,
            vendorId: o.vendorId,
            status: o.status,
            titleAr: o.titleAr,
            audiences: AUDIENCE_ORDER.filter((a) =>
              o.audiences.some((x) => x.audience === a),
            ),
            // Only the categories a size guide can describe (no accessories).
            categories: o.categories
              .map((c) => c.categoryCode)
              .filter(isSizeGuideCategory),
            canonicalProductId: o.canonicalProductId,
            sizeGuideId: o.sizeGuideId,
            sizes: [...sizes].map(([code, group]) => ({ code, group })),
          },
        ];
      }),
    );
  }

  /** The STANDARD guides that apply to an offer for one audience. */
  candidates(
    catalog: Catalog,
    facts: OfferFacts,
    audience: ProductAudience,
  ): PublishedGuide[] {
    return catalog.standard.filter((g) =>
      g.applicability.some(
        (p) =>
          p.audience === audience && facts.categories.includes(p.categoryCode),
      ),
    );
  }

  resolve(catalog: Catalog, facts: OfferFacts): ResolvedGuide[] {
    // No guide at all - not even the product's own - for an offer with no
    // sizes or none of whose categories takes a guide (accessories).
    if (!this.guideEligible(facts)) return [];
    if (facts.canonicalProductId) {
      const product = catalog.productByCanonical.get(facts.canonicalProductId);
      if (product) return [{ guide: product, audiences: 'ALL' }];
    }
    // Phase A+: the product's own measurements, entered by its store.
    const own = catalog.offerByOffer.get(facts.id);
    if (own) return [{ guide: own, audiences: 'ALL' }];
    const byGuide = new Map<string, ResolvedGuide>();
    for (const audience of facts.audiences) {
      const options = this.candidates(catalog, facts, audience);
      const chosen =
        options.find((g) => g.guideId === facts.sizeGuideId) ??
        options.find((g) =>
          g.applicability.some(
            (p) =>
              p.isDefault &&
              p.audience === audience &&
              facts.categories.includes(p.categoryCode),
          ),
        ) ??
        (options.length === 1 ? options[0] : undefined);
      if (!chosen) continue;
      const existing = byGuide.get(chosen.guideId);
      if (existing && existing.audiences !== 'ALL')
        existing.audiences.push(audience);
      else
        byGuide.set(chosen.guideId, { guide: chosen, audiences: [audience] });
    }
    return [...byGuide.values()];
  }

  /** The offer has sizes and a category a size guide can describe. */
  guideEligible(facts: OfferFacts): boolean {
    return facts.sizes.length > 0 && facts.categories.length > 0;
  }

  /**
   * What the customer is shown: only guides that describe at least one of
   * the offer's own sizes (a guide with none of them would be no help).
   */
  visible(resolved: ResolvedGuide[], facts: OfferFacts): ResolvedGuide[] {
    return resolved.filter((r) =>
      facts.sizes.some(
        (s) =>
          guideFitsSize(r.audiences, s.group) && r.guide.sizeCodes.has(s.code),
      ),
    );
  }

  /**
   * Decision 4/5: a size is checked only when a published guide applies
   * to its group (kids age sizes -> a KIDS guide; adult sizes -> a
   * WOMEN/MEN guide; a PRODUCT guide covers all). ONE_SIZE is exempt
   * unless such a guide has an explicit ONE_SIZE row.
   */
  compatibility(resolved: ResolvedGuide[], facts: OfferFacts): Compatibility {
    const mismatched: string[] = [];
    let checked = false;
    let oneSizeExempt = false;
    for (const s of facts.sizes) {
      const fitting = resolved.filter((r) =>
        guideFitsSize(r.audiences, s.group),
      );
      if (fitting.length === 0) continue;
      checked = true;
      if (fitting.some((r) => r.guide.sizeCodes.has(s.code))) continue;
      if (s.code === ONE_SIZE) {
        oneSizeExempt = true;
        continue;
      }
      mismatched.push(s.code);
    }
    return { checked, mismatched, oneSizeExempt };
  }

  /** The version describing a size of this offer (checkout snapshot). */
  versionForSize(
    resolved: ResolvedGuide[],
    size: { code: string; group: SizeGroup } | null,
  ): string | null {
    if (!size) return null;
    const fitting = resolved.filter((r) =>
      guideFitsSize(r.audiences, size.group),
    );
    return (
      (fitting.find((r) => r.guide.sizeCodes.has(size.code)) ?? fitting[0])
        ?.guide.versionId ?? null
    );
  }

  /** PD-4 decision 6: per order line, the guide version in force when bought. */
  async versionSnapshots(
    tx: Prisma.TransactionClient,
    offerVariantIds: string[],
  ): Promise<Map<string, string | null>> {
    const variants = await tx.offerVariant.findMany({
      where: { id: { in: [...new Set(offerVariantIds)] } },
      select: {
        id: true,
        vendorOfferId: true,
        sizeOption: { select: { code: true, group: true } },
      },
    });
    const catalog = await this.loadCatalog(tx);
    const facts = await this.offerFacts(
      [...new Set(variants.map((v) => v.vendorOfferId))],
      tx,
    );
    return new Map(
      variants.map((v) => {
        const f = facts.get(v.vendorOfferId);
        return [
          v.id,
          f
            ? this.versionForSize(this.resolve(catalog, f), v.sizeOption)
            : null,
        ];
      }),
    );
  }

  /**
   * The offers' compatibility, for the publish gate and reports. Phase A+:
   * an offer whose own measurements resolve is never held back by them -
   * the table is optional, and a size it does not list simply has no row.
   */
  async compatibilityForOffer(
    offerId: string,
    db: Db = this.prisma,
  ): Promise<Compatibility & { resolved: ResolvedGuide[] }> {
    const facts = (await this.offerFacts([offerId], db)).get(offerId);
    if (!facts)
      return {
        checked: false,
        mismatched: [],
        oneSizeExempt: false,
        resolved: [],
      };
    const resolved = this.resolve(await this.loadCatalog(db), facts);
    if (resolved.some((r) => r.guide.kind === 'OFFER'))
      return { checked: true, mismatched: [], oneSizeExempt: false, resolved };
    return { ...this.compatibility(resolved, facts), resolved };
  }

  /**
   * Phase A+: the category guide's verdict on a product that does not exist
   * yet (a wizard draft) - the same resolution and compatibility as for an
   * offer, from the draft's audience, category and sizes. Read-only.
   */
  async compatibilityForDraft(
    draft: {
      vendorId: string;
      titleAr: string;
      audience: ProductAudience | null;
      category: string | null;
      sizes: string[];
    },
    db: Db = this.prisma,
  ): Promise<Compatibility> {
    const sizeMap = await this.sizeMap(db);
    const facts: OfferFacts = {
      id: '',
      vendorId: draft.vendorId,
      status: 'DRAFT',
      titleAr: draft.titleAr,
      audiences: draft.audience ? [draft.audience] : [],
      categories:
        draft.category && isSizeGuideCategory(draft.category)
          ? [draft.category]
          : [],
      canonicalProductId: null,
      sizeGuideId: null,
      sizes: draft.sizes
        .filter((c) => sizeMap.has(c))
        .map((code) => ({ code, group: sizeMap.get(code)!.group })),
    };
    return this.compatibility(
      this.resolve(await this.loadCatalog(db), facts),
      facts,
    );
  }

  // ------------------------------------------------------------------
  // Content (public read model)
  // ------------------------------------------------------------------

  private contentDto(
    v: {
      id: string;
      version: number;
      status: string;
      basis: SizeMeasureBasis;
      notesAr: string | null;
      notesEn: string | null;
      publishedAt: Date | null;
      measurements: {
        key: SizeMeasureKey;
        isRange: boolean;
        sortOrder: number;
        id: string;
      }[];
      rows: {
        sizeCode: string;
        sortOrder: number;
        size: { label: string; group: SizeGroup };
        cells: {
          measurementId: string;
          minTenths: number;
          maxTenths: number | null;
        }[];
      }[];
    },
    guide: {
      id: string;
      code: string;
      nameAr: string;
      nameEn: string;
      kind: SizeGuideKind;
    },
  ) {
    const measurements = [...v.measurements].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const keyById = new Map(measurements.map((m) => [m.id, m.key]));
    return {
      id: guide.id,
      code: guide.code,
      name_ar: guide.nameAr,
      name_en: guide.nameEn,
      kind: guide.kind,
      version_id: v.id,
      version: v.version,
      status: v.status,
      basis: v.basis,
      notes_ar: v.notesAr,
      notes_en: v.notesEn,
      published_at: v.publishedAt,
      unit: 'cm' as const,
      measurements: measurements.map((m) => ({
        key: m.key,
        label_ar: MEASURE_LABEL[m.key].ar,
        label_en: MEASURE_LABEL[m.key].en,
        is_range: m.isRange,
      })),
      rows: [...v.rows]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => ({
          size_code: r.sizeCode,
          size_label: r.size.label,
          size_group: r.size.group,
          values: Object.fromEntries(
            r.cells.map((c) => [
              keyById.get(c.measurementId)!,
              {
                min: fromTenths(c.minTenths),
                max: c.maxTenths === null ? null : fromTenths(c.maxTenths),
              },
            ]),
          ) as Partial<
            Record<SizeMeasureKey, { min: number; max: number | null }>
          >,
        })),
    };
  }

  private readonly versionSelect = {
    id: true,
    version: true,
    status: true,
    basis: true,
    notesAr: true,
    notesEn: true,
    publishedAt: true,
    measurements: {
      select: { id: true, key: true, isRange: true, sortOrder: true },
    },
    rows: {
      select: {
        sizeCode: true,
        sortOrder: true,
        size: { select: { label: true, group: true } },
        cells: {
          select: { measurementId: true, minTenths: true, maxTenths: true },
        },
      },
    },
    guide: {
      select: { id: true, code: true, nameAr: true, nameEn: true, kind: true },
    },
  } satisfies Prisma.SizeGuideVersionSelect;

  async publishedContent(versionId: string) {
    const cached = this.contentCache.get(versionId);
    if (cached) return cached;
    const v = await this.prisma.sizeGuideVersion.findUnique({
      where: { id: versionId },
      select: this.versionSelect,
    });
    if (!v || v.status === 'DRAFT') throw notFound();
    const dto = this.contentDto(v, v.guide);
    this.contentCache.set(versionId, dto);
    return dto;
  }

  private async versionContent(versionId: string, db: Db = this.prisma) {
    const v = await db.sizeGuideVersion.findUnique({
      where: { id: versionId },
      select: this.versionSelect,
    });
    return v ? this.contentDto(v, v.guide) : null;
  }

  // ------------------------------------------------------------------
  // Public reads
  // ------------------------------------------------------------------

  /** Whether the product page shows the size-guide link at all. */
  async availableForOffer(offerId: string): Promise<boolean> {
    const facts = (await this.offerFacts([offerId])).get(offerId);
    if (!facts || !this.guideEligible(facts)) return false;
    return (
      this.visible(this.resolve(await this.loadCatalog(), facts), facts)
        .length > 0
    );
  }

  /**
   * Phase A+: which kind of guide the product page shows (OFFER = the
   * product's own measurements table, «جدول المقاسات (سم)»), or null.
   */
  async visibleKindForOffer(offerId: string): Promise<SizeGuideKind | null> {
    const facts = (await this.offerFacts([offerId])).get(offerId);
    if (!facts || !this.guideEligible(facts)) return null;
    const shown = this.visible(
      this.resolve(await this.loadCatalog(), facts),
      facts,
    );
    return shown[0]?.guide.kind ?? null;
  }

  async publicForOffer(slug: string, offerId: string) {
    const offer = await this.prisma.vendorOffer.findFirst({
      where: {
        id: offerId,
        status: 'ACTIVE',
        vendor: { slug, storefrontPublished: true, status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!offer)
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    const facts = (await this.offerFacts([offerId])).get(offerId)!;
    const resolved = this.guideEligible(facts)
      ? this.resolve(await this.loadCatalog(), facts)
      : [];
    const compat = this.compatibility(resolved, facts);
    return {
      guides: await Promise.all(
        this.visible(resolved, facts).map(async (r) => ({
          audiences: r.audiences === 'ALL' ? facts.audiences : r.audiences,
          ...(await this.publishedContent(r.guide.versionId)),
        })),
      ),
      offer_sizes: facts.sizes.map((s) => s.code),
      sizes_not_in_guide: compat.mismatched,
    };
  }

  /**
   * Phase A++ (item 3): what GET .../size-guide WILL answer once this draft
   * is published - the same resolution (resolve / visible / compatibility)
   * and the same content mapper (contentDto). The draft's own measurements
   * stand in for the OFFER guide its publishing would create (checked by
   * the same offerMeasurementsDraft rule; a table that would be refused is
   * simply not shown). Reads only; nothing is written.
   */
  async previewForDraft(draft: {
    vendorId: string;
    titleAr: string;
    audience: ProductAudience | null;
    category: string | null;
    sizes: string[];
    measurements: OfferMeasurementsInput | null;
  }) {
    const PREVIEW = 'preview';
    const [sizeMap, labels, catalog] = await Promise.all([
      this.sizeMap(),
      this.prisma.taxonomySize.findMany({
        select: { code: true, label: true, group: true },
      }),
      this.loadCatalog(),
    ]);
    const facts: OfferFacts = {
      id: PREVIEW,
      vendorId: draft.vendorId,
      status: 'DRAFT',
      titleAr: draft.titleAr,
      audiences: draft.audience ? [draft.audience] : [],
      categories:
        draft.category && isSizeGuideCategory(draft.category)
          ? [draft.category]
          : [],
      canonicalProductId: null,
      sizeGuideId: null,
      sizes: draft.sizes
        .filter((c) => sizeMap.has(c))
        .sort((a, b) => sizeMap.get(a)!.sortOrder - sizeMap.get(b)!.sortOrder)
        .map((code) => ({ code, group: sizeMap.get(code)!.group })),
    };
    let own: NormalisedDraft | null = null;
    if (draft.measurements) {
      try {
        own = offerMeasurementsDraft(
          draft.measurements,
          facts.sizes.map((s) => s.code),
          measureKeysFor(draft.category, draft.audience),
          sizeMap,
        );
      } catch {
        own = null;
      }
    }
    const name = draft.titleAr.trim().slice(0, 120);
    const ownGuide: PublishedGuide | null = own
      ? {
          guideId: PREVIEW,
          code: `offer-${PREVIEW}`,
          nameAr: name,
          nameEn: name,
          kind: 'OFFER' as SizeGuideKind,
          canonicalProductId: null,
          vendorOfferId: null,
          versionId: PREVIEW,
          version: 0,
          basis: own.basis,
          publishedAt: new Date(),
          sizeCodes: new Set(own.rows.map((r) => r.sizeCode)),
          applicability: [],
        }
      : null;
    const view: Catalog = ownGuide
      ? { ...catalog, offerByOffer: new Map([[PREVIEW, ownGuide]]) }
      : { ...catalog, offerByOffer: new Map() };
    const resolved = this.guideEligible(facts) ? this.resolve(view, facts) : [];
    const compat = this.compatibility(resolved, facts);
    const labelOf = new Map(labels.map((l) => [l.code, l]));
    const ownContent = (o: NormalisedDraft) =>
      this.contentDto(
        {
          id: PREVIEW,
          version: 0,
          status: 'PREVIEW',
          basis: o.basis,
          notesAr: o.notesAr,
          notesEn: o.notesEn,
          publishedAt: null,
          measurements: o.measurements.map((m) => ({ ...m, id: m.key })),
          rows: o.rows.map((r) => ({
            sizeCode: r.sizeCode,
            sortOrder: r.sortOrder,
            size: {
              label: labelOf.get(r.sizeCode)?.label ?? r.sizeCode,
              group: labelOf.get(r.sizeCode)!.group,
            },
            cells: r.cells.map((c) => ({
              measurementId: c.key,
              minTenths: c.minTenths,
              maxTenths: c.maxTenths,
            })),
          })),
        },
        {
          id: PREVIEW,
          code: ownGuide!.code,
          nameAr: name,
          nameEn: name,
          kind: 'OFFER',
        },
      );
    return {
      guides: await Promise.all(
        this.visible(resolved, facts).map(async (r) => ({
          audiences: r.audiences === 'ALL' ? facts.audiences : r.audiences,
          ...(r.guide.versionId === PREVIEW
            ? ownContent(own!)
            : await this.publishedContent(r.guide.versionId)),
        })),
      ),
      offer_sizes: facts.sizes.map((s) => s.code),
      sizes_not_in_guide: compat.mismatched,
    };
  }

  async publicById(guideId: string) {
    const v = await this.prisma.sizeGuideVersion.findFirst({
      where: {
        guideId,
        status: 'PUBLISHED',
        guide: { kind: { not: 'OFFER' } },
      },
      select: { id: true },
    });
    if (!v) throw notFound();
    return this.publishedContent(v.id);
  }

  // ------------------------------------------------------------------
  // PLATFORM_ADMIN
  // ------------------------------------------------------------------

  async sizeMap(db: Db = this.prisma): Promise<Map<string, SizeInfo>> {
    const sizes = await db.taxonomySize.findMany({
      select: { code: true, group: true, sortOrder: true },
    });
    return new Map(
      sizes.map((s) => [s.code, { group: s.group, sortOrder: s.sortOrder }]),
    );
  }

  /** Platform guides only: an offer's own table (kind OFFER) is never edited here. */
  private async lockGuide(tx: Prisma.TransactionClient, guideId: string) {
    await tx.$queryRaw`SELECT id FROM size_guides WHERE id = ${guideId} FOR UPDATE`;
    const guide = await tx.sizeGuide.findUnique({
      where: { id: guideId },
      include: { applicability: true },
    });
    if (!guide || guide.kind === 'OFFER') throw notFound();
    return guide;
  }

  async list() {
    const guides = await this.prisma.sizeGuide.findMany({
      where: { kind: { not: 'OFFER' } },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      include: {
        applicability: true,
        canonicalProduct: {
          select: { id: true, canonicalNameAr: true, modelName: true },
        },
        versions: {
          select: { id: true, version: true, status: true, publishedAt: true },
          orderBy: { version: 'desc' },
        },
      },
    });
    return guides.map((g) => this.summary(g));
  }

  private summary(g: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    kind: SizeGuideKind;
    canonicalProduct?: {
      id: string;
      canonicalNameAr: string | null;
      modelName: string;
    } | null;
    applicability: {
      categoryCode: string;
      audience: ProductAudience;
      isDefault: boolean;
    }[];
    versions: {
      id: string;
      version: number;
      status: string;
      publishedAt: Date | null;
    }[];
  }) {
    const published = g.versions.find((v) => v.status === 'PUBLISHED') ?? null;
    const draft = g.versions.find((v) => v.status === 'DRAFT') ?? null;
    return {
      id: g.id,
      code: g.code,
      name_ar: g.nameAr,
      name_en: g.nameEn,
      kind: g.kind,
      canonical_product: g.canonicalProduct
        ? {
            id: g.canonicalProduct.id,
            name:
              g.canonicalProduct.canonicalNameAr ??
              g.canonicalProduct.modelName,
          }
        : null,
      applicability: g.applicability.map((p) => ({
        category_code: p.categoryCode,
        audience: p.audience,
        is_default: p.isDefault,
      })),
      published_version: published
        ? {
            id: published.id,
            version: published.version,
            published_at: published.publishedAt,
          }
        : null,
      draft_version: draft ? { id: draft.id, version: draft.version } : null,
      versions: g.versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        published_at: v.publishedAt,
      })),
    };
  }

  async detail(guideId: string) {
    const g = await this.prisma.sizeGuide.findUnique({
      where: { id: guideId, kind: { not: 'OFFER' } },
      include: {
        applicability: true,
        canonicalProduct: {
          select: { id: true, canonicalNameAr: true, modelName: true },
        },
        versions: {
          select: { id: true, version: true, status: true, publishedAt: true },
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!g) throw notFound();
    const s = this.summary(g);
    return {
      ...s,
      draft: s.draft_version
        ? await this.versionContent(s.draft_version.id)
        : null,
      published: s.published_version
        ? await this.publishedContent(s.published_version.id)
        : null,
    };
  }

  async create(
    actorId: string,
    correlationId: string,
    input: {
      code: string;
      name_ar: string;
      name_en: string;
      kind: SizeGuideKind;
      canonical_product_id?: string | null;
      basis?: SizeMeasureBasis;
    },
  ) {
    const basis = input.kind === 'STANDARD' ? 'BODY' : (input.basis ?? 'BODY');
    if (input.kind === 'OFFER') {
      throw new BadRequestException({
        code: 'OFFER_GUIDE_NOT_ALLOWED',
        message: "A product's own measurements are entered by its store",
      });
    }
    if (input.kind === 'PRODUCT') {
      if (!input.canonical_product_id) {
        throw new BadRequestException({
          code: 'CANONICAL_PRODUCT_REQUIRED',
          message: 'A product guide belongs to one canonical product',
        });
      }
      const product = await this.prisma.canonicalProduct.findUnique({
        where: { id: input.canonical_product_id },
        select: { id: true },
      });
      if (!product)
        throw new NotFoundException({
          code: 'CANONICAL_PRODUCT_NOT_FOUND',
          message: 'Product not found',
        });
    } else if (input.canonical_product_id) {
      throw new BadRequestException({
        code: 'CANONICAL_PRODUCT_NOT_ALLOWED',
        message: 'A standard guide is not tied to one product',
      });
    }
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const guide = await tx.sizeGuide.create({
          data: {
            code: input.code,
            nameAr: input.name_ar.trim(),
            nameEn: input.name_en.trim(),
            kind: input.kind,
            canonicalProductId:
              input.kind === 'PRODUCT' ? input.canonical_product_id! : null,
            createdById: actorId,
          },
        });
        await tx.sizeGuideVersion.create({
          data: { guideId: guide.id, version: 1, basis },
        });
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'size_guide.created',
            entityType: 'SizeGuide',
            entityId: guide.id,
            afterState: {
              code: guide.code,
              kind: guide.kind,
              canonical_product_id: guide.canonicalProductId,
            },
          },
          tx,
        );
        return guide.id;
      });
      return this.detail(id);
    } catch (err) {
      if (isUniqueViolation(err, 'code')) {
        throw new ConflictException({
          code: 'SIZE_GUIDE_CODE_TAKEN',
          message: 'Another guide already uses this code',
        });
      }
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'PRODUCT_GUIDE_EXISTS',
          message: 'This product already has a product guide',
        });
      }
      throw err;
    }
  }

  async rename(
    actorId: string,
    correlationId: string,
    guideId: string,
    input: { name_ar: string; name_en: string },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const g = await this.lockGuide(tx, guideId);
      await tx.sizeGuide.update({
        where: { id: guideId },
        data: { nameAr: input.name_ar.trim(), nameEn: input.name_en.trim() },
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide.renamed',
          entityType: 'SizeGuide',
          entityId: guideId,
          beforeState: { name_ar: g.nameAr, name_en: g.nameEn },
          afterState: {
            name_ar: input.name_ar.trim(),
            name_en: input.name_en.trim(),
          },
        },
        tx,
      );
    });
    this.contentCache.clear();
    return this.detail(guideId);
  }

  /** The audiences whose size group a guide's rows must fit. */
  private guideAudiences(g: {
    kind: SizeGuideKind;
    applicability: { audience: ProductAudience }[];
  }): ProductAudience[] {
    return g.kind === 'STANDARD'
      ? [...new Set(g.applicability.map((p) => p.audience))]
      : [];
  }

  async saveDraft(
    actorId: string,
    correlationId: string,
    guideId: string,
    versionId: string,
    input: DraftInput,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const guide = await this.lockGuide(tx, guideId);
      const version = await tx.sizeGuideVersion.findFirst({
        where: { id: versionId, guideId },
      });
      if (!version) throw notFound();
      if (version.status !== 'DRAFT') {
        throw new ConflictException({
          code: 'SIZE_GUIDE_VERSION_IMMUTABLE',
          message: 'A published version cannot be edited - create a new draft',
        });
      }
      let draft: NormalisedDraft;
      try {
        draft = normaliseDraft(
          input,
          guide.kind,
          await this.sizeMap(tx),
          this.guideAudiences(guide),
        );
      } catch (err) {
        ruleError(err);
      }
      await this.writeDraft(tx, versionId, draft);
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide.draft_saved',
          entityType: 'SizeGuide',
          entityId: guideId,
          afterState: {
            version: version.version,
            sizes: draft.rows.map((r) => r.sizeCode),
            measurements: draft.measurements.map((m) => m.key),
          },
        },
        tx,
      );
    });
    return this.detail(guideId);
  }

  private async writeDraft(
    tx: Prisma.TransactionClient,
    versionId: string,
    draft: NormalisedDraft,
  ) {
    await tx.sizeGuideRow.deleteMany({ where: { versionId } });
    await tx.sizeGuideMeasurement.deleteMany({ where: { versionId } });
    await tx.sizeGuideVersion.update({
      where: { id: versionId },
      data: {
        basis: draft.basis,
        notesAr: draft.notesAr,
        notesEn: draft.notesEn,
      },
    });
    const ids = new Map<SizeMeasureKey, string>();
    for (const m of draft.measurements) {
      const created = await tx.sizeGuideMeasurement.create({
        data: {
          versionId,
          key: m.key,
          isRange: m.isRange,
          sortOrder: m.sortOrder,
        },
      });
      ids.set(m.key, created.id);
    }
    for (const r of draft.rows) {
      const row = await tx.sizeGuideRow.create({
        data: { versionId, sizeCode: r.sizeCode, sortOrder: r.sortOrder },
      });
      if (r.cells.length) {
        await tx.sizeGuideCell.createMany({
          data: r.cells.map((c) => ({
            rowId: row.id,
            measurementId: ids.get(c.key)!,
            minTenths: c.minTenths,
            maxTenths: c.maxTenths,
          })),
        });
      }
    }
  }

  /** The stored draft back in the rules' input shape. */
  private async storedDraft(tx: Db, versionId: string): Promise<DraftInput> {
    const v = await tx.sizeGuideVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: {
        basis: true,
        notesAr: true,
        notesEn: true,
        measurements: {
          select: { id: true, key: true, isRange: true, sortOrder: true },
        },
        rows: {
          select: {
            sizeCode: true,
            cells: {
              select: { measurementId: true, minTenths: true, maxTenths: true },
            },
          },
        },
      },
    });
    const measurements = [...v.measurements].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const keyById = new Map(measurements.map((m) => [m.id, m.key]));
    return {
      basis: v.basis,
      notes_ar: v.notesAr,
      notes_en: v.notesEn,
      measurements: measurements.map((m) => ({
        key: m.key,
        is_range: m.isRange,
      })),
      rows: v.rows.map((r) => ({
        size_code: r.sizeCode,
        values: Object.fromEntries(
          r.cells.map((c) => [
            keyById.get(c.measurementId)!,
            {
              min: fromTenths(c.minTenths),
              max: c.maxTenths === null ? null : fromTenths(c.maxTenths),
            },
          ]),
        ),
      })),
    };
  }

  async newDraft(actorId: string, correlationId: string, guideId: string) {
    await this.prisma.$transaction(async (tx) => {
      const guide = await this.lockGuide(tx, guideId);
      const versions = await tx.sizeGuideVersion.findMany({
        where: { guideId },
        orderBy: { version: 'desc' },
      });
      if (versions.some((v) => v.status === 'DRAFT')) {
        throw new ConflictException({
          code: 'SIZE_GUIDE_DRAFT_EXISTS',
          message: 'This guide already has a draft',
        });
      }
      const source =
        versions.find((v) => v.status === 'PUBLISHED') ?? versions[0];
      const created = await tx.sizeGuideVersion.create({
        data: {
          guideId,
          version: (versions[0]?.version ?? 0) + 1,
          basis: source?.basis ?? 'BODY',
        },
      });
      // Start from the last content (published, else latest) - an empty
      // source simply gives an empty draft.
      const stored = source ? await this.storedDraft(tx, source.id) : null;
      if (stored && stored.rows.length && stored.measurements.length) {
        await this.writeDraft(
          tx,
          created.id,
          normaliseDraft(stored, guide.kind, await this.sizeMap(tx), []),
        );
      }
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide.version_created',
          entityType: 'SizeGuide',
          entityId: guideId,
          afterState: {
            version: created.version,
            copied_from: source?.version ?? null,
          },
        },
        tx,
      );
    });
    return this.detail(guideId);
  }

  async publish(
    actorId: string,
    correlationId: string,
    guideId: string,
    versionId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const guide = await this.lockGuide(tx, guideId);
      const version = await tx.sizeGuideVersion.findFirst({
        where: { id: versionId, guideId },
      });
      if (!version) throw notFound();
      if (version.status !== 'DRAFT') {
        throw new ConflictException({
          code: 'SIZE_GUIDE_VERSION_IMMUTABLE',
          message: 'Only a draft can be published',
        });
      }
      try {
        const draft = normaliseDraft(
          await this.storedDraft(tx, versionId),
          guide.kind,
          await this.sizeMap(tx),
          this.guideAudiences(guide),
        );
        assertPublishable(draft);
      } catch (err) {
        ruleError(err);
      }
      const now = new Date();
      const previous = await tx.sizeGuideVersion.findFirst({
        where: { guideId, status: 'PUBLISHED' },
      });
      if (previous) {
        await tx.sizeGuideVersion.update({
          where: { id: previous.id },
          data: { status: 'RETIRED', retiredAt: now },
        });
      }
      await tx.sizeGuideVersion.update({
        where: { id: versionId },
        data: { status: 'PUBLISHED', publishedAt: now, publishedById: actorId },
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide.published',
          entityType: 'SizeGuide',
          entityId: guideId,
          beforeState: previous
            ? { published_version: previous.version }
            : undefined,
          afterState: { published_version: version.version },
        },
        tx,
      );
    });
    return this.detail(guideId);
  }

  /** Withdraws the published version: the guide stops applying anywhere. */
  async retire(actorId: string, correlationId: string, guideId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockGuide(tx, guideId);
      const current = await tx.sizeGuideVersion.findFirst({
        where: { guideId, status: 'PUBLISHED' },
      });
      if (!current) {
        throw new ConflictException({
          code: 'NOTHING_PUBLISHED',
          message: 'This guide has no published version',
        });
      }
      await tx.sizeGuideVersion.update({
        where: { id: current.id },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide.retired',
          entityType: 'SizeGuide',
          entityId: guideId,
          afterState: { retired_version: current.version },
        },
        tx,
      );
    });
    return this.detail(guideId);
  }

  async setApplicability(
    actorId: string,
    correlationId: string,
    guideId: string,
    pairs: {
      category_code: string;
      audience: ProductAudience;
      is_default: boolean;
    }[],
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const guide = await this.lockGuide(tx, guideId);
        if (guide.kind !== 'STANDARD') {
          throw new ConflictException({
            code: 'NOT_A_STANDARD_GUIDE',
            message: 'Only a standard guide applies to categories',
          });
        }
        const keys = pairs.map((p) => `${p.category_code}|${p.audience}`);
        if (new Set(keys).size !== keys.length) {
          throw new BadRequestException({
            code: 'DUPLICATE_PAIR',
            message: 'Each category/audience pair may appear once',
          });
        }
        const known = await tx.taxonomyCategoryAudience.findMany({
          where: {
            OR: pairs.map((p) => ({
              categoryCode: p.category_code,
              audience: p.audience,
            })),
          },
          select: { categoryCode: true, audience: true },
        });
        const unknown = keys.filter(
          (k) => !known.some((x) => `${x.categoryCode}|${x.audience}` === k),
        );
        if (pairs.length && unknown.length) {
          throw new BadRequestException({
            code: 'UNKNOWN_CATEGORY_AUDIENCE',
            message: `Not a category/audience pair: ${unknown.join(', ')}`,
            details: unknown,
          });
        }
        const notSized = [
          ...new Set(
            pairs
              .map((p) => p.category_code)
              .filter((c) => !isSizeGuideCategory(c)),
          ),
        ];
        if (notSized.length) {
          throw new BadRequestException({
            code: 'CATEGORY_NOT_SIZED',
            message: `These categories take no size guide: ${notSized.join(', ')}`,
            details: notSized,
          });
        }
        const group = groupForAudiences([
          ...new Set(pairs.map((p) => p.audience)),
        ]);
        if (group === 'MIXED') {
          throw new BadRequestException({
            code: 'SIZE_GROUP_NOT_ALLOWED',
            message: 'A guide applies either to kids or to adults, not both',
          });
        }
        // The guide's existing rows must still fit the new audiences.
        const latest = await tx.sizeGuideVersion.findFirst({
          where: { guideId, status: { in: ['DRAFT', 'PUBLISHED'] } },
          orderBy: { version: 'desc' },
          select: {
            rows: {
              select: { sizeCode: true, size: { select: { group: true } } },
            },
          },
        });
        const rowGroups = new Set(
          (latest?.rows ?? [])
            .filter((r) => r.sizeCode !== ONE_SIZE)
            .map((r) => r.size.group),
        );
        if (group && rowGroups.size && !rowGroups.has(group)) {
          throw new BadRequestException({
            code: 'SIZE_GROUP_NOT_ALLOWED',
            message: "These audiences don't match the guide's sizes",
          });
        }
        const before = guide.applicability.map(
          (p) => `${p.categoryCode}|${p.audience}${p.isDefault ? '*' : ''}`,
        );
        await tx.sizeGuideApplicability.deleteMany({ where: { guideId } });
        if (pairs.length) {
          await tx.sizeGuideApplicability.createMany({
            data: pairs.map((p) => ({
              guideId,
              categoryCode: p.category_code,
              audience: p.audience,
              isDefault: p.is_default,
            })),
          });
        }
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'size_guide.applicability_set',
            entityType: 'SizeGuide',
            entityId: guideId,
            beforeState: { pairs: before },
            afterState: {
              pairs: pairs.map(
                (p) =>
                  `${p.category_code}|${p.audience}${p.is_default ? '*' : ''}`,
              ),
            },
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'DEFAULT_GUIDE_EXISTS',
          message:
            'Another guide is already the default for one of these pairs',
        });
      }
      throw err;
    }
    return this.detail(guideId);
  }

  /** Category/audience pairs in use by published, sized offers, and where offers break their guide. */
  async coverage() {
    const offers = await this.prisma.vendorOffer.findMany({
      where: {
        status: 'ACTIVE',
        requiresTaxonomy: true,
        variants: { some: { isCombination: true, sizeCode: { not: null } } },
      },
      select: {
        id: true,
        vendor: { select: { slug: true, displayName: true, legalName: true } },
      },
    });
    const catalog = await this.loadCatalog();
    const facts = await this.offerFacts(offers.map((o) => o.id));
    const pairs = new Map<
      string,
      {
        category_code: string;
        audience: ProductAudience;
        offers: number;
        default_guide: { id: string; code: string; name_ar: string } | null;
      }
    >();
    const mismatches: {
      offer_id: string;
      title: string;
      store: string;
      store_slug: string;
      sizes: string[];
    }[] = [];
    for (const o of offers) {
      const f = facts.get(o.id)!;
      for (const audience of f.audiences) {
        for (const categoryCode of f.categories) {
          const key = `${categoryCode}|${audience}`;
          const entry = pairs.get(key) ?? {
            category_code: categoryCode,
            audience,
            offers: 0,
            default_guide: (() => {
              const g = catalog.standard.find((x) =>
                x.applicability.some(
                  (p) =>
                    p.isDefault &&
                    p.audience === audience &&
                    p.categoryCode === categoryCode,
                ),
              );
              return g
                ? { id: g.guideId, code: g.code, name_ar: g.nameAr }
                : null;
            })(),
          };
          entry.offers += 1;
          pairs.set(key, entry);
        }
      }
      const compat = this.compatibility(this.resolve(catalog, f), f);
      if (compat.mismatched.length) {
        mismatches.push({
          offer_id: o.id,
          title: f.titleAr,
          store: o.vendor.displayName ?? o.vendor.legalName,
          store_slug: o.vendor.slug,
          sizes: compat.mismatched,
        });
      }
    }
    return {
      pairs: [...pairs.values()].sort((a, b) => b.offers - a.offers),
      mismatched_offers: mismatches,
    };
  }

  async listRequests(status?: 'PENDING' | 'RESOLVED' | 'REJECTED') {
    const rows = await this.prisma.sizeGuideRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      include: {
        vendorOffer: {
          select: {
            id: true,
            titleAr: true,
            canonicalProductId: true,
            vendor: {
              select: { slug: true, displayName: true, legalName: true },
            },
            audiences: { select: { audience: true } },
            categories: { select: { categoryCode: true } },
          },
        },
        resolvedGuide: { select: { id: true, code: true, nameAr: true } },
      },
    });
    return rows.map((r) => this.requestDto(r));
  }

  private requestDto(r: {
    id: string;
    message: string;
    status: string;
    decisionNote: string | null;
    decidedAt: Date | null;
    createdAt: Date;
    vendorOffer?: {
      id: string;
      titleAr: string;
      canonicalProductId: string | null;
      vendor: { slug: string; displayName: string | null; legalName: string };
      audiences: { audience: ProductAudience }[];
      categories: { categoryCode: string }[];
    };
    resolvedGuide?: { id: string; code: string; nameAr: string } | null;
  }) {
    return {
      id: r.id,
      message: r.message,
      status: r.status,
      decision_note: r.decisionNote,
      decided_at: r.decidedAt,
      created_at: r.createdAt,
      ...(r.vendorOffer
        ? {
            offer: {
              id: r.vendorOffer.id,
              title: r.vendorOffer.titleAr,
              canonical_product_id: r.vendorOffer.canonicalProductId,
              store:
                r.vendorOffer.vendor.displayName ??
                r.vendorOffer.vendor.legalName,
              store_slug: r.vendorOffer.vendor.slug,
              audiences: r.vendorOffer.audiences.map((a) => a.audience),
              categories: r.vendorOffer.categories.map((c) => c.categoryCode),
            },
          }
        : {}),
      resolved_guide: r.resolvedGuide
        ? {
            id: r.resolvedGuide.id,
            code: r.resolvedGuide.code,
            name_ar: r.resolvedGuide.nameAr,
          }
        : null,
    };
  }

  /**
   * Decision 2: the administrator decides a request. RESOLVED links a
   * real published guide that applies to the offer: a PRODUCT guide of
   * its canonical product (applies by itself), or an applicable STANDARD
   * guide (becomes the offer's chosen guide). REJECTED needs a note.
   */
  async decideRequest(
    actorId: string,
    correlationId: string,
    requestId: string,
    input: {
      decision: 'RESOLVED' | 'REJECTED';
      note?: string | null;
      guide_id?: string | null;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM size_guide_requests WHERE id = ${requestId} FOR UPDATE`;
      const req = await tx.sizeGuideRequest.findUnique({
        where: { id: requestId },
      });
      if (!req)
        throw new NotFoundException({
          code: 'SIZE_GUIDE_REQUEST_NOT_FOUND',
          message: 'Request not found',
        });
      if (req.status !== 'PENDING') {
        throw new ConflictException({
          code: 'SIZE_GUIDE_REQUEST_DECIDED',
          message: 'This request has already been decided',
        });
      }
      const note = input.note?.trim() || null;
      if (input.decision === 'REJECTED' && !note) {
        throw new BadRequestException({
          code: 'DECISION_NOTE_REQUIRED',
          message: 'Say why the request is rejected',
        });
      }
      let guideId: string | null = null;
      if (input.decision === 'RESOLVED') {
        if (!input.guide_id) {
          throw new BadRequestException({
            code: 'GUIDE_REQUIRED',
            message: 'Resolving links a published guide',
          });
        }
        const facts = (await this.offerFacts([req.vendorOfferId], tx)).get(
          req.vendorOfferId,
        )!;
        const catalog = await this.loadCatalog(tx);
        const product = facts.canonicalProductId
          ? catalog.productByCanonical.get(facts.canonicalProductId)
          : undefined;
        const standard = facts.audiences.flatMap((a) =>
          this.candidates(catalog, facts, a),
        );
        if (product?.guideId === input.guide_id) {
          guideId = product.guideId;
        } else if (standard.some((g) => g.guideId === input.guide_id)) {
          guideId = input.guide_id;
          await tx.vendorOffer.update({
            where: { id: req.vendorOfferId },
            data: { sizeGuideId: guideId },
          });
        } else {
          throw new ConflictException({
            code: 'SIZE_GUIDE_NOT_APPLICABLE',
            message:
              "That guide isn't published or doesn't apply to this offer",
          });
        }
      }
      const updated = await tx.sizeGuideRequest.update({
        where: { id: requestId },
        data: {
          status: input.decision,
          decisionNote: note,
          decidedById: actorId,
          decidedAt: new Date(),
          resolvedGuideId: guideId,
        },
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'size_guide_request.decided',
          entityType: 'SizeGuideRequest',
          entityId: requestId,
          afterState: { decision: input.decision, guide_id: guideId, note },
        },
        tx,
      );
      return this.requestDto(updated);
    });
  }

  // ------------------------------------------------------------------
  // OWNER
  // ------------------------------------------------------------------

  private async ownOffer(
    db: Db,
    vendorId: string,
    offerId: string,
  ): Promise<OfferFacts> {
    const facts = (await this.offerFacts([offerId], db)).get(offerId);
    if (!facts || facts.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    return facts;
  }

  async ownerView(vendorId: string, offerId: string) {
    const facts = await this.ownOffer(this.prisma, vendorId, offerId);
    const catalog = await this.loadCatalog();
    const resolved = this.resolve(catalog, facts);
    const product = facts.canonicalProductId
      ? catalog.productByCanonical.get(facts.canonicalProductId)
      : undefined;
    const requests = await this.prisma.sizeGuideRequest.findMany({
      where: { vendorOfferId: offerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        resolvedGuide: { select: { id: true, code: true, nameAr: true } },
      },
    });
    return {
      offer_id: offerId,
      classified: facts.categories.length > 0,
      size_guide_eligible: this.guideEligible(facts),
      offer_sizes: facts.sizes.map((s) => s.code),
      product_guide_applies: Boolean(product),
      own_measurements_apply: !product && catalog.offerByOffer.has(offerId),
      chosen_guide_id: facts.sizeGuideId,
      options: product
        ? []
        : facts.audiences.map((audience) => ({
            audience,
            guides: this.candidates(catalog, facts, audience).map((g) => ({
              id: g.guideId,
              code: g.code,
              name_ar: g.nameAr,
              name_en: g.nameEn,
              is_default: g.applicability.some(
                (p) =>
                  p.isDefault &&
                  p.audience === audience &&
                  facts.categories.includes(p.categoryCode),
              ),
            })),
          })),
      guides: await Promise.all(
        resolved.map(async (r) => ({
          audiences: r.audiences === 'ALL' ? facts.audiences : r.audiences,
          ...(await this.publishedContent(r.guide.versionId)),
        })),
      ),
      compatibility: (() => {
        const c = this.compatibility(resolved, facts);
        return {
          checked: c.checked,
          mismatched_sizes: c.mismatched,
          one_size_exempt: c.oneSizeExempt,
        };
      })(),
      requests: requests.map((r) => this.requestDto(r)),
    };
  }

  /** Decision 11: only an applicable, published STANDARD guide (or null = default). */
  async choose(
    actorId: string,
    correlationId: string,
    vendorId: string,
    offerId: string,
    guideId: string | null,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
      const facts = await this.ownOffer(tx, vendorId, offerId);
      if (guideId !== null) {
        const catalog = await this.loadCatalog(tx);
        if (
          facts.canonicalProductId &&
          catalog.productByCanonical.has(facts.canonicalProductId)
        ) {
          throw new ConflictException({
            code: 'PRODUCT_GUIDE_APPLIES',
            message:
              "This product has its own guide, shared by every store - it can't be replaced",
          });
        }
        const applicable = facts.audiences.some((a) =>
          this.candidates(catalog, facts, a).some((g) => g.guideId === guideId),
        );
        if (!applicable) {
          throw new ConflictException({
            code: 'SIZE_GUIDE_NOT_APPLICABLE',
            message:
              "That guide isn't published or doesn't apply to this offer's category/audience",
          });
        }
      }
      await tx.vendorOffer.update({
        where: { id: offerId },
        data: { sizeGuideId: guideId },
      });
      await this.audit.record(
        {
          actorId,
          correlationId,
          action: 'offer.size_guide_chosen',
          entityType: 'VendorOffer',
          entityId: offerId,
          beforeState: { size_guide_id: facts.sizeGuideId },
          afterState: { size_guide_id: guideId },
        },
        tx,
      );
    });
    return this.ownerView(vendorId, offerId);
  }

  async request(
    actorId: string,
    correlationId: string,
    vendorId: string,
    offerId: string,
    message: string,
  ) {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const facts = await this.ownOffer(tx, vendorId, offerId);
        if (!this.guideEligible(facts)) {
          throw new ConflictException({
            code: 'OFFER_NOT_SIZED',
            message:
              "This offer has no sizes a size guide could describe (or it's an accessory)",
          });
        }
        const r = await tx.sizeGuideRequest.create({
          data: {
            vendorId,
            vendorOfferId: offerId,
            requestedById: actorId,
            message: message.trim(),
          },
        });
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'size_guide_request.created',
            entityType: 'SizeGuideRequest',
            entityId: r.id,
            afterState: { offer_id: offerId },
          },
          tx,
        );
        return r;
      });
      return this.requestDto(created);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'SIZE_GUIDE_REQUEST_PENDING',
          message: 'A request for this offer is already waiting for review',
        });
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Phase A+: an offer's own measurements (kind OFFER)
  // ------------------------------------------------------------------

  /** The offer's own table in the seller's shape, with what it may contain. */
  async offerMeasurements(vendorId: string, offerId: string) {
    const facts = await this.ownOffer(this.prisma, vendorId, offerId);
    const offer = await this.prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: {
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
        ownSizeGuide: {
          select: {
            id: true,
            versions: {
              where: { status: 'PUBLISHED' },
              select: { id: true, version: true, publishedAt: true },
            },
          },
        },
      },
    });
    const category = offer.categories[0]?.categoryCode ?? null;
    const audience = offer.audiences[0]?.audience ?? null;
    const published = offer.ownSizeGuide?.versions[0] ?? null;
    const content = published
      ? await this.publishedContent(published.id)
      : null;
    const catalog = await this.loadCatalog();
    const product = facts.canonicalProductId
      ? catalog.productByCanonical.get(facts.canonicalProductId)
      : undefined;
    return {
      offer_id: offerId,
      allowed_keys: measureKeysFor(category, audience),
      sizes: facts.sizes.map((s) => s.code),
      product_guide_applies: Boolean(product),
      version: published?.version ?? null,
      published_at: published?.publishedAt ?? null,
      measurements: content
        ? {
            keys: content.measurements.map((m) => m.key),
            values: Object.fromEntries(
              content.rows.map((r) => [
                r.size_code,
                Object.fromEntries(
                  Object.entries(r.values).map(([k, v]) => [k, v!.min]),
                ),
              ]),
            ),
          }
        : null,
    };
  }

  /**
   * Saves the offer's own table: a NEW published version every time (the
   * previous one RETIRED and kept), so an order keeps the version it was
   * bought under. Nothing entered: the table is withdrawn (the category's
   * guide applies again). Runs inside the caller's transaction when given.
   */
  async writeOfferMeasurements(
    tx: Prisma.TransactionClient,
    actorId: string,
    correlationId: string,
    vendorId: string,
    offerId: string,
    input: OfferMeasurementsInput | null,
  ): Promise<{ version: number | null }> {
    await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
    const facts = await this.ownOffer(tx, vendorId, offerId);
    const offer = await tx.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: {
        titleAr: true,
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
      },
    });
    let draft: NormalisedDraft | null;
    try {
      draft = offerMeasurementsDraft(
        input,
        facts.sizes.map((s) => s.code),
        measureKeysFor(
          offer.categories[0]?.categoryCode,
          offer.audiences[0]?.audience,
        ),
        await this.sizeMap(tx),
      );
    } catch (err) {
      ruleError(err);
    }
    let guide = await tx.sizeGuide.findUnique({
      where: { vendorOfferId: offerId },
    });
    if (guide)
      await tx.$queryRaw`SELECT id FROM size_guides WHERE id = ${guide.id} FOR UPDATE`;
    const now = new Date();
    const previous = guide
      ? await tx.sizeGuideVersion.findFirst({
          where: { guideId: guide.id, status: 'PUBLISHED' },
        })
      : null;
    if (!draft) {
      if (previous) {
        await tx.sizeGuideVersion.update({
          where: { id: previous.id },
          data: { status: 'RETIRED', retiredAt: now },
        });
        await this.audit.record(
          {
            actorId,
            correlationId,
            action: 'offer.measurements_removed',
            entityType: 'VendorOffer',
            entityId: offerId,
            beforeState: { version: previous.version },
          },
          tx,
        );
      }
      return { version: null };
    }
    if (!guide) {
      const name = offer.titleAr.trim().slice(0, 120);
      guide = await tx.sizeGuide.create({
        data: {
          code: `offer-${offerId}`,
          nameAr: name,
          // The guide's own name, never shown: the Arabic title when the
          // product has no English one.
          nameEn: name,
          kind: 'OFFER',
          vendorOfferId: offerId,
          createdById: actorId,
        },
      });
    }
    const last = await tx.sizeGuideVersion.findFirst({
      where: { guideId: guide.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    if (previous) {
      await tx.sizeGuideVersion.update({
        where: { id: previous.id },
        data: { status: 'RETIRED', retiredAt: now },
      });
    }
    const version = await tx.sizeGuideVersion.create({
      data: {
        guideId: guide.id,
        version: (last?.version ?? 0) + 1,
        basis: 'GARMENT',
      },
    });
    await this.writeDraft(tx, version.id, draft);
    await tx.sizeGuideVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: now, publishedById: actorId },
    });
    await this.audit.record(
      {
        actorId,
        correlationId,
        action: 'offer.measurements_saved',
        entityType: 'VendorOffer',
        entityId: offerId,
        beforeState: previous ? { version: previous.version } : undefined,
        afterState: {
          version: version.version,
          sizes: draft.rows.map((r) => r.sizeCode),
          measurements: draft.measurements.map((m) => m.key),
        },
      },
      tx,
    );
    return { version: version.version };
  }

  async saveOfferMeasurements(
    actorId: string,
    correlationId: string,
    vendorId: string,
    offerId: string,
    input: OfferMeasurementsInput | null,
  ) {
    await this.prisma.$transaction((tx) =>
      this.writeOfferMeasurements(
        tx,
        actorId,
        correlationId,
        vendorId,
        offerId,
        input,
      ),
    );
    return this.offerMeasurements(vendorId, offerId);
  }

  async ownerRequests(vendorId: string) {
    const rows = await this.prisma.sizeGuideRequest.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      include: {
        vendorOffer: {
          select: {
            id: true,
            titleAr: true,
            canonicalProductId: true,
            vendor: {
              select: { slug: true, displayName: true, legalName: true },
            },
            audiences: { select: { audience: true } },
            categories: { select: { categoryCode: true } },
          },
        },
        resolvedGuide: { select: { id: true, code: true, nameAr: true } },
      },
    });
    return rows.map((r) => this.requestDto(r));
  }
}
