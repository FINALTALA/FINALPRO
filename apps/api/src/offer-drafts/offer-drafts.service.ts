import { compositionForOffer, compositionView } from '../offers/composition';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { appendToCollection } from '../vendors/store-collections.util';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import * as path from 'path';
import { OfferDraft, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { lockOffersWideForRestock } from '../checkout/stock-lock.util';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { computeEffectivePrice } from '../offers/pricing/effective-price.util';
import {
  resolveUnifiedPrice,
  UnifiedPrice,
} from '../offers/pricing/unified-price.util';
import { bucketForStock } from '../common/availability.util';
import { modelProblem } from '../offers/offer-presentation';
import {
  mediaView,
  modelView,
  productColorView,
  productOptionChoices,
  sizeLabel,
  variantPriceView,
} from '../offers/public-offer-view';
import { OfferPublishService } from '../offers/offer-publish.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  measureKeysFor,
  measurementsEmpty,
  offerMeasurementsDraft,
  SizeGuideRuleError,
} from '../size-guides/size-guide-rules';
import { SizeGuidesService } from '../size-guides/size-guides.service';
import {
  TAXONOMY_VERSION,
  TaxonomyService,
} from '../taxonomy/taxonomy.service';
import {
  ownUploadProblem,
  parseOwnUploadUrl,
  uploadsDir,
} from '../uploads/uploads.util';
import {
  DraftPayload,
  discountFields,
  draftDisplayTitle,
  draftProblems,
  draftSizes,
  draftStep,
  draftVersions,
  MAX_TITLE,
  normaliseDraftPayload,
  sizeSystemOf,
  openingStock,
  payloadImageUrls,
  readDraftPayload,
  specsForCategory,
  versionKey,
} from './draft-payload';
import { assertEditAllowed, EditSnapshot } from './edit-rules';
import { EDIT_PRESENCE_MS } from './edit-presence';
import { normalizeBarcode, printableBarcode } from '../common/barcode.util';
import { OfferBarcodesService } from '../store-pos/offer-barcodes.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

export const NEW_DRAFT_TITLE = 'مسودة جديدة';
/** An OPEN draft untouched this long is closed (ABANDONED) by the clean-up sweep. */
export const DRAFT_ABANDON_AFTER_DAYS = 90;

function notFound(): NotFoundException {
  return new NotFoundException({
    code: 'DRAFT_NOT_FOUND',
    message: 'Draft not found',
  });
}

/** The whole creation rolled back; say which uniqueness was hit. */
function uniqueConflict(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  ) {
    const meta = JSON.stringify(err.meta ?? {});
    // the wizard's store barcode, taken by another product a moment ago
    if (meta.includes('offer_barcodes') || /"code"/.test(meta)) {
      throw new ConflictException({
        code: 'DRAFT_NOT_PUBLISHABLE',
        message: 'The product barcode cannot be used',
        details: [{ code: 'STORE_BARCODE:BARCODE_ALREADY_USED:', step: 5 }],
      });
    }
    throw new ConflictException({
      code: meta.includes('sellerSku')
        ? 'SELLER_SKU_ALREADY_EXISTS'
        : 'VERSION_ALREADY_EXISTS',
      message: meta.includes('sellerSku')
        ? 'One of these SKUs is already used by another product of this store'
        : 'This product version already exists',
    });
  }
  throw err;
}

export type DraftProblem = { code: string; step: number };

export function normaliseBrandName(name: string): string {
  // Same rule as BrandsController's normalize(), plus collapsing spaces.
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Product-entry wizard: server-side drafts of NEW products.
 *
 * - A draft is created only when the seller presses «منتج جديد» and is
 *   saved on the server after every change (`save`), never only in the
 *   browser.
 * - Every save names the revision it was based on; a save based on an
 *   older revision is refused with 409 DRAFT_REVISION_CONFLICT (and the
 *   current revision), so a second tab can never overwrite the first one
 *   silently.
 * - `submit` turns the draft into a real product in ONE transaction:
 *   offer + classification + price + every colour x size + opening stock
 *   + every colour's images copied to each of that colour's sizes. Either
 *   all of it exists afterwards or none of it.
 * - Uploads: the draft keeps a ledger of every image it ever held; when it
 *   is discarded, created or abandoned, the images nothing else uses are
 *   deleted (`cleanUploads`) - never one used by a product, a storefront,
 *   a branch or another open draft.
 */
@Injectable()
export class OfferDraftsService {
  private readonly logger = new Logger(OfferDraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly auditLog: AuditLogService,
    private readonly sizeGuides: SizeGuidesService,
    private readonly offerPublish: OfferPublishService,
    private readonly barcodes: OfferBarcodesService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  /**
   * The brand request behind a draft's typed brand (its latest one for
   * that name), so the page can say whether it is under review, approved
   * or rejected (with the reason). Null when the draft did not ask for one.
   */
  /** A family code's names (name the colours of a draft saved before product colours). */
  async familyNames(): Promise<
    (code: string) => { ar: string; en: string } | null
  > {
    const t = await this.taxonomy.get();
    return (code) => {
      const f = t.colors.find((c) => c.code === code);
      return f ? { ar: f.nameAr, en: f.nameEn } : null;
    };
  }

  async brandRequestOf(
    db: Prisma.TransactionClient | PrismaService,
    d: OfferDraft,
  ) {
    const brand = (d.payload as DraftPayload).brand;
    if (!brand || brand.mode !== 'request' || !brand.name.trim()) return null;
    const r = await db.brandRequest.findFirst({
      where: { draftId: d.id, normalizedName: normaliseBrandName(brand.name) },
      orderBy: { createdAt: 'desc' },
    });
    return r
      ? {
          id: r.id,
          name: r.name,
          status: r.status,
          brand_id: r.brandId,
          rejection_reason: r.rejectionReason,
        }
      : null;
  }

  async draftDto(
    d: OfferDraft,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    /** who is looking - for «تُعدَّل حالياً من عضو في فريق المتجر» (never a name) */
    viewerId?: string,
  ) {
    const payload = readDraftPayload(d.payload, await this.familyNames());
    const edit = d.editOfOfferId
      ? {
          offer_id: d.editOfOfferId,
          base_revision: d.baseRevision,
          title_ar:
            (d.baseSnapshot as { payload?: DraftPayload } | null)?.payload
              ?.title_ar ?? null,
          edited_by_other_recently:
            !!viewerId &&
            !!d.lastEditedByUserId &&
            d.lastEditedByUserId !== viewerId &&
            !!d.lastEditedAt &&
            Date.now() - d.lastEditedAt.getTime() < EDIT_PRESENCE_MS,
          // existing colours / versions: locked in the wizard (no removal, no stock)
          existing_colors: Object.keys(
            (d.baseSnapshot as { colorIds?: Record<string, string> } | null)
              ?.colorIds ?? {},
          ),
          existing_versions: draftVersions(
            (d.baseSnapshot as { payload?: DraftPayload } | null)?.payload ??
              {},
          ).map((v) => versionKey(v.color, v.size)),
        }
      : null;
    return {
      id: d.id,
      status: d.status,
      edit,
      revision: d.revision,
      title: draftDisplayTitle(payload) ?? NEW_DRAFT_TITLE,
      payload,
      offer_id: d.offerId,
      brand_request: await this.brandRequestOf(db, d),
      created_at: d.createdAt.toISOString(),
      updated_at: d.updatedAt.toISOString(),
    };
  }

  /**
   * Keeps the draft's brand request in step with what the seller chose:
   * «طلب علامة جديدة» opens a PENDING request for this draft (renaming it
   * while still pending); choosing anything else withdraws a pending one.
   * A REJECTED or APPROVED request for the same name is never reopened by
   * itself - the seller re-chooses.
   */
  private async syncBrandRequest(
    tx: Prisma.TransactionClient,
    d: OfferDraft,
    payload: DraftPayload,
    userId: string,
  ) {
    const pending = await tx.brandRequest.findFirst({
      where: { draftId: d.id, status: 'PENDING' },
    });
    const brand = payload.brand;
    if (!brand || brand.mode !== 'request' || !brand.name.trim()) {
      if (pending) {
        await tx.brandRequest.update({
          where: { id: pending.id },
          data: { status: 'WITHDRAWN' },
        });
      }
      return;
    }
    const name = brand.name.trim().replace(/\s+/g, ' ');
    const normalizedName = normaliseBrandName(name);
    if (pending) {
      if (pending.normalizedName !== normalizedName) {
        await tx.brandRequest.update({
          where: { id: pending.id },
          data: { name, normalizedName },
        });
      }
      return;
    }
    const decided = await tx.brandRequest.findFirst({
      where: {
        draftId: d.id,
        normalizedName,
        status: { in: ['APPROVED', 'REJECTED'] },
      },
    });
    if (decided) return;
    await tx.brandRequest.create({
      data: {
        vendorId: d.vendorId,
        requestedByUserId: userId,
        draftId: d.id,
        name,
        normalizedName,
      },
    });
  }

  /**
   * Wizard phase A: the page creates a draft only with the seller's FIRST
   * real piece of information (a name, an image, a colour...), sent here as
   * `rawPayload` - never an empty draft for a panel opened and closed.
   * Without it (older pages) the draft starts empty, as before.
   */
  async create(
    vendorId: string,
    userId: string,
    correlationId: string,
    rawPayload?: unknown,
  ) {
    const payload: DraftPayload =
      rawPayload === undefined
        ? { step: 1 }
        : normaliseDraftPayload(
            rawPayload,
            (url) =>
              parseOwnUploadUrl(url)
                ? ownUploadProblem(url, vendorId)
                : 'Only images uploaded to this store can be used',
            await this.familyNames(),
          );
    const draft = await this.prisma.$transaction(async (tx) => {
      const created = await tx.offerDraft.create({
        data: {
          vendorId,
          createdByUserId: userId,
          payload: payload as Prisma.InputJsonValue,
          uploads: payloadImageUrls(payload),
        },
      });
      // A brand typed in that first piece of information is requested at once.
      await this.syncBrandRequest(tx, created, payload, userId);
      const d = created;
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer_draft.created',
          entityType: 'OfferDraft',
          entityId: d.id,
        },
        tx,
      );
      return d;
    });
    return await this.draftDto(draft);
  }

  /**
   * Phase A++ (item 1): «نسخ كمنتج جديد» - a NEW draft built by the server
   * from one of this store's products or drafts, then checked like any
   * draft (normaliseDraftPayload) and created the same way.
   *  - copied: audience and category, specifications, brand (an existing
   *    one or «بدون علامة»), colours, size system and sizes, the product's
   *    own measurements (as the draft's table - a new OFFER guide is made
   *    when the copy is published, never shared), the price, descriptions;
   *    the name with «(نسخة)» (and «(copy)») to be changed;
   *  - never: quantities, SKUs, publish status, a brand request, discount;
   *  - images only when asked (with_images): the same files are reused, each
   *    product / draft keeps its own link to them (removing one from the copy
   *    never touches the original; the clean-up deletes a file only when
   *    nothing - product, store, branch or open draft - uses it any more).
   * The copy is always a draft and passes the same publish check.
   */
  async createCopy(
    vendorId: string,
    userId: string,
    correlationId: string,
    from: { offer_id?: string; draft_id?: string },
    withImages: boolean,
  ) {
    if (!from.offer_id === !from.draft_id) {
      throw new BadRequestException({
        code: 'COPY_SOURCE_REQUIRED',
        message: 'Copy from exactly one product (offer_id) or draft (draft_id)',
      });
    }
    const raw = from.offer_id
      ? await this.payloadFromOffer(vendorId, from.offer_id, withImages)
      : await this.payloadFromDraft(vendorId, from.draft_id!, withImages);
    const created = await this.create(vendorId, userId, correlationId, raw);
    await this.auditLog.record({
      actorId: userId,
      correlationId,
      action: 'offer_draft.copied',
      entityType: 'OfferDraft',
      entityId: created.id,
      afterState: { copied_from: from, with_images: withImages },
    });
    return created;
  }

  private copyTitle(ar: string, en: string | null | undefined) {
    const cut = (s: string) => s.slice(0, MAX_TITLE);
    const english = (en ?? '').trim();
    return {
      title_ar: cut(`${ar.trim()} (نسخة)`),
      ...(english ? { title_en: cut(`${english} (copy)`) } : {}),
    };
  }

  private async payloadFromDraft(
    vendorId: string,
    draftId: string,
    withImages: boolean,
  ): Promise<Record<string, unknown>> {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFound();
    const p = readDraftPayload(d.payload, await this.familyNames());
    return {
      layout: 5,
      step: 1,
      audience: p.audience ?? null,
      category: p.category ?? null,
      ...this.copyTitle(p.title_ar ?? '', p.title_en),
      // A requested brand is not requested again: the seller chooses.
      ...(p.brand && p.brand.mode !== 'request' ? { brand: p.brand } : {}),
      specs: p.specs ?? {},
      // Colours with their names, families, order and HEX; the images and
      // the fabric swatch (files) only when the images are copied.
      colors: (p.colors ?? []).map((c) => ({
        key: c.key,
        family: c.family,
        name_ar: c.name_ar,
        ...(c.name_en ? { name_en: c.name_en } : {}),
        ...(c.hex ? { hex: c.hex } : {}),
        ...(withImages && c.swatch ? { swatch: c.swatch } : {}),
        images: withImages ? c.images : [],
      })),
      size_system: p.size_system ?? null,
      sizes: p.sizes ?? {},
      price: p.price ?? null,
      measurements: p.measurements ?? null,
      ...(p.model ? { model: p.model } : {}),
      shared_images: withImages ? (p.shared_images ?? []) : [],
      description_ar: p.description_ar ?? '',
      description_en: p.description_en ?? '',
    };
  }

  private async payloadFromOffer(
    vendorId: string,
    offerId: string,
    withImages: boolean,
  ): Promise<Record<string, unknown>> {
    const o = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, vendorId },
      include: {
        brand: { select: { id: true, isNoBrandSentinel: true } },
        sharedMedia: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
        colors: { orderBy: { sortOrder: 'asc' } },
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
        variants: {
          where: { isCombination: true },
          orderBy: { createdAt: 'asc' },
          select: {
            offerColorId: true,
            sizeCode: true,
            basePrice: true,
            specsTextAr: true,
            specsTextEn: true,
            media: {
              where: { mediaType: 'IMAGE' },
              orderBy: { sortOrder: 'asc' },
              select: { url: true, kind: true },
            },
          },
        },
      },
    });
    if (!o)
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    // Product colours, in the seller's order; each colour's images are its
    // first version's (they are copied to every size of a colour).
    const colors: Record<string, unknown>[] = [];
    const sizes: Record<string, string[]> = {};
    // Keys as the wizard makes them: the family code, then -2, -3... for
    // further shades of the same family.
    const shades = new Map<string, number>();
    for (const c of o.colors) {
      const own = o.variants.filter(
        (v) => v.offerColorId === c.id && v.sizeCode,
      );
      if (own.length === 0) continue;
      const media = own[0].media;
      const images = [
        ...media.filter((m) => m.kind === 'PRIMARY'),
        ...media.filter((m) => m.kind !== 'PRIMARY'),
      ].map((m) => m.url);
      const shade = (shades.get(c.familyCode) ?? 0) + 1;
      shades.set(c.familyCode, shade);
      const key = shade === 1 ? c.familyCode : `${c.familyCode}-${shade}`;
      colors.push({
        key,
        family: c.familyCode,
        name_ar: c.nameAr,
        ...(c.nameEn ? { name_en: c.nameEn } : {}),
        ...(c.hex ? { hex: c.hex } : {}),
        ...(withImages && c.swatchUrl ? { swatch: c.swatchUrl } : {}),
        images: withImages ? images : [],
      });
      sizes[key] = [...new Set(own.map((v) => v.sizeCode!))];
    }
    const allSizes = Object.values(sizes).flat();
    const systems = new Set(allSizes.map(sizeSystemOf));
    const first = o.variants[0];
    const own = (await this.sizeGuides.offerMeasurements(vendorId, offerId))
      .measurements;
    return {
      layout: 5,
      step: 1,
      audience: o.audiences[0]?.audience ?? null,
      category: o.categories[0]?.categoryCode ?? null,
      ...this.copyTitle(o.titleAr, o.titleEn),
      ...(o.brand
        ? {
            brand: o.brand.isNoBrandSentinel
              ? { mode: 'none' }
              : { mode: 'existing', brand_id: o.brand.id },
          }
        : {}),
      specs:
        o.templateAttributes && typeof o.templateAttributes === 'object'
          ? Object.fromEntries(
              Object.entries(
                o.templateAttributes as Record<string, unknown>,
              ).filter(
                ([, v]) => typeof v === 'string' && v.trim() && v !== 'N/A',
              ),
            )
          : {},
      colors,
      size_system: systems.size === 1 ? [...systems][0] : null,
      sizes,
      price: first ? Number(first.basePrice) : null,
      measurements: own,
      ...(o.modelHeightCm !== null && o.modelSize !== null
        ? { model: { height_cm: o.modelHeightCm, size: o.modelSize } }
        : {}),
      shared_images: withImages ? o.sharedMedia.map((m) => m.url) : [],
      description_ar: first?.specsTextAr ?? '',
      description_en: first?.specsTextEn ?? '',
      // a copy carries the fabric composition and the country of origin
      ...compositionView(o.composition, o.countryOfOrigin),
    };
  }

  /**
   * Phase A++ (item 3): «معاينة» - the draft as the shopper's product page
   * WILL show it once published, in the same shapes as the public reads
   * (GET /storefronts/:slug/offers/:id, .../options, .../size-guide) and
   * built with the same functions: the price view (base price + live
   * effective price, through the same price rules the creation uses),
   * colour/size names, each colour's images (first = main) then the shared
   * images, the specifications, the model line, the size table. The
   * choices come from the same builder as the public options
   * (productOptionChoices): a colour x size with no stock is a sold-out
   * choice in both - the published page lets a shopper ask to be told
   * when it is back. Reads only: nothing is written, no audit, no cart, no
   * alert; the page disables every action. Owner only, this store only.
   */
  async preview(vendorId: string, draftId: string) {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFound();
    const p = readDraftPayload(d.payload, await this.familyNames());
    const [t, vendor] = await Promise.all([
      this.taxonomy.get(),
      this.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        select: { slug: true, displayName: true, legalName: true },
      }),
    ]);
    let price: UnifiedPrice | null = null;
    if (p.price) {
      try {
        price = resolveUnifiedPrice({
          base_price: p.price,
          ...discountFields(p.discount),
        });
      } catch {
        // An unfinished discount is not shown (the publish check names it).
        price = resolveUnifiedPrice({ base_price: p.price });
      }
    }
    const stock = openingStock(p);
    // an edit draft: existing versions show the product's live stock
    const live = new Map<string, number>();
    if (d.editOfOfferId) {
      const ids =
        (d.baseSnapshot as { colorIds?: Record<string, string> } | null)
          ?.colorIds ?? {};
      const keyOfId = new Map(Object.entries(ids).map(([k, id]) => [id, k]));
      const rows = await this.prisma.offerVariant.findMany({
        where: { vendorOfferId: d.editOfOfferId, isCombination: true },
        select: {
          offerColorId: true,
          sizeCode: true,
          branchStocks: { select: { quantity: true } },
        },
      });
      for (const r of rows) {
        const k = r.offerColorId ? keyOfId.get(r.offerColorId) : undefined;
        if (k && r.sizeCode)
          live.set(
            versionKey(k, r.sizeCode),
            r.branchStocks.reduce((n, b) => n + b.quantity, 0),
          );
      }
    }
    const available = (key: string) =>
      (live.get(key) ?? 0) +
      Object.values(stock).reduce((n, per) => n + (per[key] ?? 0), 0);
    // Colours as the product will have them: the draft's key stands in for
    // the product colour id (in the seller's order).
    const draftColors = (p.colors ?? []).filter(
      (c) => c.family && t.colorByCode.has(c.family) && c.name_ar.trim(),
    );
    const colorOf = (key: string) => draftColors.find((c) => c.key === key);
    const versions = draftVersions(p).filter(
      (v) => colorOf(v.color) && t.sizeByCode.has(v.size),
    );
    const imagesOf = (color: string) => colorOf(color)?.images ?? [];
    const colorViews = draftColors.map((c, i) =>
      productColorView(
        {
          id: c.key,
          familyCode: c.family!,
          nameAr: c.name_ar.trim(),
          nameEn: c.name_en?.trim() || null,
          hex: c.hex ?? null,
          swatchUrl: c.swatch ?? null,
          sortOrder: i,
        },
        t.colors,
      ),
    );
    const now = new Date();
    const notPurchasable = (availability: string) => ({
      availability,
      delivery: {
        status: 'NOT_PURCHASABLE' as const,
        fee: null,
        minimum_order_value: null,
        earliest_slot_date: null,
      },
      pickup: { status: 'NOT_PURCHASABLE' as const, branches: [] },
    });
    const specs = specsForCategory(p.category, p.specs);
    const sizes = draftSizes(p);
    const sizeGuide = await this.sizeGuides.previewForDraft({
      vendorId,
      titleAr: p.title_ar ?? '',
      audience: p.audience ?? null,
      category: p.category ?? null,
      sizes,
      measurements: p.measurements ?? null,
    });
    const variants = versions.map((v) => {
      const key = versionKey(v.color, v.size);
      const q = available(key);
      return {
        id: key,
        condition: 'NEW',
        currency: 'ILS' as const,
        ...(price
          ? variantPriceView(price, now)
          : { base_price: null, sale_price: null }),
        specs_text_ar: p.description_ar?.trim() || null,
        specs_text_en: p.description_en?.trim() || null,
        canonical_variant_id: null,
        canonical_product_id: null,
        structural_attributes: null,
        availability: bucketForStock(q),
        fulfilment: notPurchasable(bucketForStock(q)),
        color_id: v.color,
        color_code: colorOf(v.color)!.family,
        color_label: colorOf(v.color)!.name_ar.trim(),
        color_name_en: colorOf(v.color)!.name_en?.trim() || null,
        size_code: v.size,
        size_label: sizeLabel(t, v.size),
        // The same order the creation gives them: the first image is the main one.
        media: imagesOf(v.color).map((url, i) =>
          mediaView({
            url,
            kind: i === 0 ? 'PRIMARY' : 'ADDITIONAL',
            mediaType: 'IMAGE',
            altTextAr: null,
            altTextEn: null,
            sortOrder: i,
          }),
        ),
      };
    });
    const model =
      modelProblem(p.model?.height_cm, p.model?.size, sizes) === null
        ? modelView(t, p.model?.height_cm ?? null, p.model?.size ?? null)
        : null;
    // the product page's choices: the same builder as the published options
    const choices = productOptionChoices(
      colorViews,
      t.sizes,
      versions.map((v) => ({
        variantId: versionKey(v.color, v.size),
        colorId: v.color,
        colorCode: colorOf(v.color)!.family,
        sizeCode: v.size,
        available: available(versionKey(v.color, v.size)),
      })),
    );
    // what the published page will show: the same view (only a complete composition)
    const composition = compositionView(p.composition, p.country_of_origin);
    return {
      draft_id: d.id,
      draft_status: d.status,
      vendor_slug: vendor.slug,
      offer: {
        id: d.id,
        purchasable: false,
        composition: composition.composition,
        country_of_origin: composition.country_of_origin,
        size_guide_available: sizeGuide.guides.length > 0,
        size_guide_kind: sizeGuide.guides[0]?.kind ?? null,
        bestseller: null,
        fulfilment_context: {
          zone: null,
          zone_source: 'NONE' as const,
          default_zone: null,
        },
        delivery_zones: [],
        vendor_id: vendorId,
        vendor_slug: vendor.slug,
        vendor_display_name: vendor.displayName ?? vendor.legalName,
        title_ar: (p.title_ar ?? '').trim(),
        title_en: (p.title_en ?? '').trim(),
        category_template: specs?.template ?? null,
        template_attributes: specs?.attributes ?? null,
        model,
        shared_images: p.shared_images ?? [],
        images: [...new Set((p.colors ?? []).flatMap((c) => c.images))],
        variants,
      },
      options: {
        offer_id: d.id,
        classified: true,
        audiences: p.audience ? [p.audience] : [],
        categories: p.category ? [p.category] : [],
        season: null,
        // the product's own colours that can be chosen, in the seller's order
        colors: choices.colors.map((c) => ({ ...c, code: c.family_code })),
        sizes: choices.sizes,
        combinations: choices.combinations,
      },
      size_guide: sizeGuide,
    };
  }

  async list(vendorId: string) {
    const rows = await this.prisma.offerDraft.findMany({
      where: { vendorId, status: 'OPEN' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const names = await this.familyNames();
    return {
      items: rows.map((d) => {
        const p = readDraftPayload(d.payload, names);
        return {
          id: d.id,
          title: draftDisplayTitle(p) ?? NEW_DRAFT_TITLE,
          edit_of_offer_id: d.editOfOfferId,
          // «مستورد»: created by the product import (then completed in the wizard)
          imported: d.importBatchId !== null,
          step: draftStep(p),
          revision: d.revision,
          thumbnail:
            p.colors?.find((c) => c.images.length > 0)?.images[0] ?? null,
          updated_at: d.updatedAt.toISOString(),
          created_at: d.createdAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Wizard phase A - the owner's own not-yet-published items, for cards
   * shown ONLY inside the store workspace (never on the public storefront,
   * search or discovery, which read published products only): products
   * created but never published (status DRAFT; «بانتظار اعتماد العلامة»
   * while their typed brand is under review) and open wizard drafts - each
   * with its audience / category so the page can show it in its place.
   */
  async unpublished(vendorId: string) {
    const offers = await this.prisma.vendorOffer.findMany({
      where: { vendorId, status: 'DRAFT', archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        createdAt: true,
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
        brandRequests: { where: { status: 'PENDING' }, select: { id: true } },
        variants: {
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: {
            media: {
              where: { kind: 'PRIMARY', mediaType: 'IMAGE' },
              take: 1,
              select: { url: true },
            },
          },
        },
      },
    });
    const drafts = await this.prisma.offerDraft.findMany({
      where: { vendorId, status: 'OPEN' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const names = await this.familyNames();
    return {
      items: [
        ...drafts.map((d) => {
          const p = readDraftPayload(d.payload, names);
          return {
            kind: 'draft' as const,
            id: d.id,
            title: draftDisplayTitle(p) ?? NEW_DRAFT_TITLE,
            label: d.editOfOfferId ? ('EDIT' as const) : ('DRAFT' as const),
            edit_of_offer_id: d.editOfOfferId,
            imported: d.importBatchId !== null,
            audience: p.audience ?? null,
            category: p.category ?? null,
            thumbnail:
              p.colors?.find((c) => c.images.length > 0)?.images[0] ?? null,
            updated_at: d.updatedAt.toISOString(),
          };
        }),
        ...offers.map((o) => ({
          kind: 'offer' as const,
          id: o.id,
          title: o.titleAr || o.titleEn,
          label:
            o.brandRequests.length > 0
              ? ('BRAND_PENDING' as const)
              : ('DRAFT' as const),
          audience: o.audiences[0]?.audience ?? null,
          category: o.categories[0]?.categoryCode ?? null,
          thumbnail: o.variants[0]?.media[0]?.url ?? null,
          updated_at: o.createdAt.toISOString(),
        })),
      ],
    };
  }

  async get(vendorId: string, draftId: string, viewerId?: string) {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFound();
    return await this.draftDto(d, this.prisma, viewerId);
  }

  async lockOpen(
    tx: Prisma.TransactionClient,
    vendorId: string,
    draftId: string,
    expectedRevision: number,
  ) {
    await tx.$queryRaw`SELECT id FROM offer_drafts WHERE id = ${draftId} FOR UPDATE`;
    const d = await tx.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFound();
    if (d.status !== 'OPEN') {
      throw new ConflictException({
        code: 'DRAFT_CLOSED',
        message: 'This draft is no longer open',
        details: [{ status: d.status, offer_id: d.offerId }],
      });
    }
    if (d.revision !== expectedRevision) {
      throw new ConflictException({
        code: 'DRAFT_REVISION_CONFLICT',
        message: 'This draft was changed elsewhere since you loaded it',
        details: [
          { revision: d.revision, updated_at: d.updatedAt.toISOString() },
        ],
      });
    }
    return d;
  }

  async save(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    rawPayload: unknown,
    userId: string,
  ) {
    const payload = normaliseDraftPayload(
      rawPayload,
      (url) =>
        parseOwnUploadUrl(url)
          ? ownUploadProblem(url, vendorId)
          : 'Only images uploaded to this store can be used',
      await this.familyNames(),
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, vendorId, draftId, expectedRevision);
      // an edit draft: what may not change is refused by the server, on every save
      if (d.editOfOfferId) {
        assertEditAllowed(d.baseSnapshot as unknown as EditSnapshot, payload);
      }
      const ledger = new Set<string>((d.uploads as string[]) ?? []);
      // an edit draft's ledger holds only images uploaded for it: the
      // product's own files are never deleted by applying an edit
      const own = d.editOfOfferId
        ? new Set(
            payloadImageUrls(
              (d.baseSnapshot as unknown as EditSnapshot).payload,
            ),
          )
        : new Set<string>();
      for (const url of payloadImageUrls(payload))
        if (!own.has(url)) ledger.add(url);
      await this.syncBrandRequest(tx, d, payload, userId);
      const saved = await tx.offerDraft.update({
        where: { id: draftId },
        data: {
          payload: payload as Prisma.InputJsonValue,
          uploads: [...ledger],
          revision: d.revision + 1,
          lastEditedByUserId: userId,
          lastEditedAt: new Date(),
        },
      });
      return this.draftDto(saved, tx, userId);
    });
    return updated;
  }

  /**
   * Phase A++ (item 2): «نسخ من فرع…» - ONE atomic change of the draft at
   * its current revision: every available colour x size cell of the target
   * branch takes the source branch's quantity (0 where it has none). Either
   * all of them change, or none: another tab's newer save (a stale
   * revision), a branch that is not this store's active branch, or any
   * failure leaves the draft exactly as it was. The single-cell save
   * (PATCH) is unchanged.
   */
  async copyStock(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    fromBranchId: string,
    toBranchId: string,
    userId: string,
    correlationId: string,
  ) {
    if (fromBranchId === toBranchId) {
      throw new BadRequestException({
        code: 'SAME_BRANCH',
        message: 'Choose two different branches',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, vendorId, draftId, expectedRevision);
      if (d.editOfOfferId) {
        throw new BadRequestException({
          code: 'EDIT_STOCK_EXISTING',
          message:
            "An existing version's stock is changed on the stock screen only",
        });
      }
      const active = await tx.storeBranch.count({
        where: {
          id: { in: [fromBranchId, toBranchId] },
          vendorId,
          archivedAt: null,
        },
      });
      if (active !== 2) {
        throw new BadRequestException({
          code: 'BRANCH_NOT_FOUND',
          message: "A branch is not one of this store's active branches",
        });
      }
      const p = readDraftPayload(d.payload, await this.familyNames());
      // The draft's explicit stock (an older draft's default/exceptions
      // written out first - exactly what it meant).
      const stock = openingStock(p);
      const target: Record<string, number> = {};
      let cells = 0;
      for (const v of draftVersions(p)) {
        const key = versionKey(v.color, v.size);
        cells += 1;
        const q = stock[fromBranchId]?.[key] ?? 0;
        if (q > 0) target[key] = q;
      }
      const next: DraftPayload = {
        ...p,
        stock: { ...stock, [toBranchId]: target },
      };
      delete next.default_stock;
      delete next.stock_overrides;
      const saved = await tx.offerDraft.update({
        where: { id: draftId },
        data: {
          payload: next as Prisma.InputJsonValue,
          revision: d.revision + 1,
        },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer_draft.stock_copied',
          entityType: 'OfferDraft',
          entityId: draftId,
          afterState: {
            from_branch_id: fromBranchId,
            to_branch_id: toBranchId,
            cells,
          },
        },
        tx,
      );
      return this.draftDto(saved, tx);
    });
  }

  async discard(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    userId: string,
    correlationId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, vendorId, draftId, expectedRevision);
      await tx.offerDraft.update({
        where: { id: draftId },
        data: {
          status: 'DISCARDED',
          closedAt: new Date(),
          revision: d.revision + 1,
        },
      });
      await tx.brandRequest.updateMany({
        where: { draftId, status: 'PENDING' },
        data: { status: 'WITHDRAWN' },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer_draft.discarded',
          entityType: 'OfferDraft',
          entityId: draftId,
        },
        tx,
      );
    });
    const cleaned = await this.cleanUploads(draftId);
    return {
      id: draftId,
      status: 'DISCARDED',
      removed_images: cleaned.removed,
    };
  }

  /**
   * Phase A+: THE judgement of whether a draft can be published - one
   * function, read-only (it never writes, audits or notifies), used by the
   * publish check the page shows and, inside the publishing transaction,
   * before anything is written. Problems carry the wizard step (1 details,
   * 2 colours and images, 3 sizes and measurements, 4 stock and price);
   * hints are suggestions that never block.
   */
  async publishProblems(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    d: OfferDraft,
  ): Promise<{ problems: DraftProblem[]; hints: DraftProblem[] }> {
    const p = readDraftPayload(d.payload, await this.familyNames());
    const problems: DraftProblem[] = draftProblems(p).filter(
      (x) => !d.editOfOfferId || x.code !== 'STOCK_REQUIRED',
    );
    const hints: DraftProblem[] = [];

    // Brand: under review blocks publishing (named as such); rejected or
    // withdrawn: choose again; an existing brand must still exist.
    if (p.brand?.mode === 'request' && p.brand.name.trim()) {
      const req = await this.brandRequestOf(db, d);
      if (req?.status === 'PENDING')
        problems.push({ code: 'BRAND_PENDING', step: 1 });
      else if (req?.status !== 'APPROVED')
        problems.push({ code: 'BRAND_REJECTED', step: 1 });
    } else if (p.brand?.mode === 'existing') {
      const b = await db.brand.findUnique({
        where: { id: p.brand.brand_id },
        select: { id: true },
      });
      if (!b) problems.push({ code: 'BRAND_NOT_FOUND', step: 1 });
    }

    // Stock: something to sell, only in this store's active branches.
    const stock = openingStock(p);
    const total = Object.values(stock)
      .flatMap((per) => Object.values(per))
      .reduce((a, q) => a + q, 0);
    // (an edit draft: live stock stays on the stock screen - not required here)
    if (!d.editOfOfferId && draftVersions(p).length > 0 && total <= 0)
      problems.push({ code: 'STOCK_REQUIRED', step: 4 });
    const branchIds = Object.keys(stock);
    if (branchIds.length > 0) {
      const active = await db.storeBranch.count({
        where: { id: { in: branchIds }, vendorId, archivedAt: null },
      });
      if (active !== branchIds.length)
        problems.push({ code: 'BRANCH_NOT_FOUND', step: 4 });
    }

    // Measurements: optional; once entered, complete and plausible.
    const sizes = draftSizes(p);
    const keys = measureKeysFor(p.category, p.audience);
    if (!measurementsEmpty(p.measurements)) {
      try {
        offerMeasurementsDraft(
          p.measurements,
          sizes,
          keys,
          await this.sizeGuides.sizeMap(db),
        );
      } catch (err) {
        if (!(err instanceof SizeGuideRuleError)) throw err;
        problems.push({ code: `MEASUREMENTS:${err.code}`, step: 3 });
      }
    } else {
      // Without its own table, a category guide that applies must describe
      // every size (PD-4) - the same rule the offer's publish gate applies.
      const compat = await this.sizeGuides.compatibilityForDraft(
        {
          vendorId,
          titleAr: p.title_ar ?? '',
          audience: p.audience ?? null,
          category: p.category ?? null,
          sizes,
        },
        db,
      );
      if (compat.mismatched.length > 0)
        problems.push({
          code: `SIZE_GUIDE_MISMATCH:${compat.mismatched.join(',')}`,
          step: 3,
        });
      if (keys.length > 0 && sizes.length > 0)
        hints.push({ code: 'MEASUREMENTS_SUGGESTED', step: 3 });
    }
    // fabric composition and country of origin: never required - a quiet hint
    if (!p.composition) hints.push({ code: 'COMPOSITION_SUGGESTED', step: 1 });
    if (!p.country_of_origin) hints.push({ code: 'ORIGIN_SUGGESTED', step: 1 });
    // «باركود المنتج للمحل»: a NEW product from the wizard is published only
    // with a valid code of its own (while the store's barcodes are on); a
    // typed or generated code must be valid and not already used in this
    // store - named on the review step, never dropped
    if (!d.editOfOfferId) {
      const problem = await this.storeBarcodeGate(db, vendorId, d, p);
      if (problem) problems.push({ code: problem, step: 5 });
    }
    return { problems, hints };
  }

  /**
   * The draft's store barcode against the publish gate: null = fine.
   * Required for every new-product draft (the wizard's and the import's)
   * while store_cashier_enabled is on; checked whenever one is given.
   * An imported draft without one is resolved before bulk publishing
   * (setStoreBarcode / generateStoreBarcodes) - never skipped.
   */
  private async storeBarcodeGate(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    d: OfferDraft,
    p: DraftPayload,
  ): Promise<string | null> {
    const b = p.store_barcode;
    const given =
      (b?.mode === 'external' && b.code.trim() !== '') ||
      b?.mode === 'generate';
    if (!given) {
      const required = await this.featureFlags.isEnabled(
        'store_cashier_enabled',
      );
      return required ? 'STORE_BARCODE:BARCODE_MISSING' : null;
    }
    if (b.mode === 'external') {
      return this.storeBarcodeProblem(db, vendorId, b.code);
    }
    // generated: the code reserved for this draft (older drafts: made at publish)
    if (!b.code) return null;
    const normalized = normalizeBarcode(b.code);
    if (
      !normalized.ok ||
      normalized.format !== 'EAN13' ||
      !normalized.code.startsWith('29')
    )
      return 'STORE_BARCODE:BARCODE_INVALID';
    const used = await this.barcodes.usedBy(db, vendorId, normalized.code);
    return used ? `STORE_BARCODE:BARCODE_ALREADY_USED:${used.titleAr}` : null;
  }

  /**
   * The draft's typed store barcode: null when it can be attached, else
   * STORE_BARCODE:<BARCODE_REQUIRED|BARCODE_INVALID|BARCODE_CHECK_DIGIT|
   * BARCODE_RESERVED> or STORE_BARCODE:BARCODE_ALREADY_USED:<the product's name>.
   */
  private async storeBarcodeProblem(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    raw: string,
  ): Promise<string | null> {
    const normalized = normalizeBarcode(raw);
    if (!normalized.ok) return `STORE_BARCODE:${normalized.problem}`;
    const used = await this.barcodes.usedBy(db, vendorId, normalized.code);
    return used ? `STORE_BARCODE:BARCODE_ALREADY_USED:${used.titleAr}` : null;
  }

  /** The store barcode an open new-product draft already carries (normalized), or null. */
  private draftBarcode(payload: unknown): string | null {
    const b = (payload as DraftPayload | null)?.store_barcode;
    if (b?.mode === 'external' && b.code.trim()) {
      const n = normalizeBarcode(b.code);
      return n.ok ? n.code : b.code.trim();
    }
    if (b?.mode === 'generate' && b.code) return b.code;
    return null;
  }

  /** The store's open drafts' codes (another draft already holds it): code -> the draft's name. */
  async openDraftBarcodes(
    db: Prisma.TransactionClient | PrismaService,
    vendorId: string,
    exceptDraftId?: string,
  ): Promise<Map<string, string>> {
    const rows = await db.offerDraft.findMany({
      where: {
        vendorId,
        status: 'OPEN',
        editOfOfferId: null,
        id: { not: exceptDraftId ?? '' },
      },
      select: { payload: true },
    });
    const out = new Map<string, string>();
    for (const r of rows) {
      const code = this.draftBarcode(r.payload);
      if (code)
        out.set(code, ((r.payload as DraftPayload)?.title_ar ?? '').trim());
    }
    return out;
  }

  private async lockOpenNewProductDraft(
    tx: Prisma.TransactionClient,
    vendorId: string,
    draftId: string,
  ) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM offer_drafts WHERE id = ${draftId} AND "vendorId" = ${vendorId} FOR UPDATE`;
    if (!row) throw notFound();
    const d = await tx.offerDraft.findUniqueOrThrow({ where: { id: draftId } });
    if (d.status !== 'OPEN') {
      throw new ConflictException({
        code: 'DRAFT_CLOSED',
        message: 'This draft is closed',
        details: [{ offer_id: d.offerId }],
      });
    }
    if (d.editOfOfferId) throw editUseApply();
    return d;
  }

  /**
   * Before bulk publishing - «إدخال/مسح باركود لكل منتج»: the code on the
   * item, for the whole product (every colour and size). Checked now (format,
   * not used by a product or another open draft of this store); saved into the
   * draft (a new revision), audited.
   */
  async setStoreBarcode(
    vendorId: string,
    draftId: string,
    raw: string,
    userId: string,
    correlationId: string,
  ) {
    const normalized = normalizeBarcode(raw);
    if (!normalized.ok) {
      throw new BadRequestException({
        code: normalized.problem,
        message: 'This is not a valid barcode',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpenNewProductDraft(tx, vendorId, draftId);
      const product = await this.barcodes.usedBy(tx, vendorId, normalized.code);
      const draft = product
        ? null
        : (await this.openDraftBarcodes(tx, vendorId, draftId)).get(
            normalized.code,
          );
      if (product || (draft !== undefined && draft !== null)) {
        throw new ConflictException({
          code: 'BARCODE_ALREADY_USED',
          message: 'This barcode is already used in this store',
          details: [
            {
              title_ar: product?.titleAr ?? draft,
              title_en: product?.titleEn ?? '',
            },
          ],
        });
      }
      const payload = {
        ...((d.payload ?? {}) as DraftPayload),
        store_barcode: { mode: 'external' as const, code: normalized.code },
      };
      const updated = await tx.offerDraft.update({
        where: { id: d.id },
        data: {
          payload: payload as unknown as Prisma.InputJsonValue,
          revision: d.revision + 1,
          lastEditedByUserId: userId,
          lastEditedAt: new Date(),
        },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer_draft.store_barcode_set',
          entityType: 'OfferDraft',
          entityId: d.id,
          afterState: { code: normalized.code, source: 'EXTERNAL' },
        },
        tx,
      );
      return {
        draft_id: d.id,
        revision: updated.revision,
        code: normalized.code,
        display_code: printableBarcode(normalized.code, normalized.format),
        format: normalized.format,
      };
    });
  }

  /**
   * Before bulk publishing - «إنشاء باركودات من النظام»: one in-store code for
   * each CHOSEN draft that has none yet (a draft that already has one is left
   * as it is), saved into the draft, audited; returned for the print list.
   */
  async generateStoreBarcodes(
    vendorId: string,
    draftIds: string[],
    userId: string,
    correlationId: string,
  ) {
    const ids = [...new Set(draftIds)].sort().slice(0, 100);
    return this.prisma.$transaction(async (tx) => {
      const items: {
        draft_id: string;
        title: string;
        code: string;
        display_code: string;
        format: 'EAN13';
        price: number | null;
      }[] = [];
      let skipped = 0;
      for (const id of ids) {
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM offer_drafts WHERE id = ${id} AND "vendorId" = ${vendorId} FOR UPDATE`;
        if (!row) {
          skipped += 1;
          continue;
        }
        const d = await tx.offerDraft.findUniqueOrThrow({ where: { id } });
        if (
          d.status !== 'OPEN' ||
          d.editOfOfferId ||
          this.draftBarcode(d.payload)
        ) {
          skipped += 1;
          continue;
        }
        const r = await this.barcodes.reserveInTx(tx, vendorId, {
          userId,
          correlationId,
        });
        const p = (d.payload ?? {}) as DraftPayload;
        await tx.offerDraft.update({
          where: { id },
          data: {
            payload: {
              ...p,
              store_barcode: { mode: 'generate', code: r.code },
            } as unknown as Prisma.InputJsonValue,
            revision: d.revision + 1,
            lastEditedByUserId: userId,
            lastEditedAt: new Date(),
          },
        });
        await this.auditLog.record(
          {
            actorId: userId,
            correlationId,
            action: 'offer_draft.store_barcode_set',
            entityType: 'OfferDraft',
            entityId: id,
            afterState: { code: r.code, source: 'GENERATED' },
          },
          tx,
        );
        items.push({
          draft_id: id,
          title: (p.title_ar ?? '').trim(),
          code: r.code,
          display_code: r.code,
          format: 'EAN13',
          price: typeof p.price === 'number' ? p.price : null,
        });
      }
      return { items, skipped };
    });
  }

  /** The publish check the wizard shows (read-only). */
  async publishCheck(vendorId: string, draftId: string) {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFound();
    if (d.status !== 'OPEN') {
      return {
        draft_id: d.id,
        revision: d.revision,
        status: d.status,
        offer_id: d.offerId,
        ready: false,
        problems: [],
        hints: [],
      };
    }
    const { problems, hints } = await this.publishProblems(
      this.prisma,
      vendorId,
      d,
    );
    return {
      draft_id: d.id,
      revision: d.revision,
      status: d.status,
      offer_id: null,
      ready: problems.length === 0,
      problems,
      hints,
    };
  }

  /**
   * «نشر»: creates the product from the draft AND publishes it, in ONE
   * transaction. The draft row is locked first (FOR UPDATE), so a second
   * request (double click, another tab) waits and then finds the draft
   * closed: 409 DRAFT_CLOSED naming the product the first one created -
   * never a second product. The judgement runs before anything is written
   * (incomplete: 409 DRAFT_NOT_PUBLISHABLE with the problems; no product,
   * the draft unchanged); the offer's own publish gate runs again on the
   * created product before it becomes ACTIVE.
   */
  async publish(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    userId: string,
    correlationId: string,
    /** Bulk publishing: no per-product follower notification (the run sends one summary). */
    opts: { notifyFollowers?: boolean } = {},
  ) {
    const t = await this.taxonomy.get();
    const result = await this.prisma
      .$transaction(async (tx) => {
        const d = await this.lockOpen(tx, vendorId, draftId, expectedRevision);
        if (d.editOfOfferId) throw editUseApply();
        const { problems } = await this.publishProblems(tx, vendorId, d);
        if (problems.length > 0) {
          throw new ConflictException({
            code: 'DRAFT_NOT_PUBLISHABLE',
            message: 'Some required information is still missing',
            details: problems,
          });
        }
        const created = await this.submitInTx(
          tx,
          t,
          vendorId,
          draftId,
          expectedRevision,
          userId,
          correlationId,
        );
        const p = readDraftPayload(d.payload, await this.familyNames());
        if (!measurementsEmpty(p.measurements)) {
          await this.sizeGuides.writeOfferMeasurements(
            tx,
            userId,
            correlationId,
            vendorId,
            created.offer_id,
            p.measurements!,
          );
        }
        await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${created.offer_id} FOR UPDATE`;
        const offer = await tx.vendorOffer.findUniqueOrThrow({
          where: { id: created.offer_id },
        });
        const published = await this.offerPublish.activate(
          tx,
          userId,
          correlationId,
          vendorId,
          offer,
          opts,
        );
        return { ...created, status: published.status };
      })
      .catch(uniqueConflict);
    await this.cleanUploads(draftId);
    return result;
  }

  /**
   * Creates the product from the draft - all of it in one transaction - and
   * closes the draft (SUBMITTED, pointing at the product). The product is
   * created as a DRAFT offer; publishing it is the existing status change
   * (and its publish gate), unchanged.
   */
  async submit(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    userId: string,
    correlationId: string,
  ) {
    const t = await this.taxonomy.get();
    const result = await this.prisma
      .$transaction(async (tx) => {
        return this.submitInTx(
          tx,
          t,
          vendorId,
          draftId,
          expectedRevision,
          userId,
          correlationId,
        );
      })
      .catch(uniqueConflict);
    // Images removed from the draft before it was created are no longer needed.
    await this.cleanUploads(draftId);
    return result;
  }

  private async submitInTx(
    tx: Prisma.TransactionClient,
    t: Awaited<ReturnType<TaxonomyService['get']>>,
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    userId: string,
    correlationId: string,
  ) {
    {
      const d = await this.lockOpen(tx, vendorId, draftId, expectedRevision);
      if (d.editOfOfferId) throw editUseApply();
      const p = readDraftPayload(d.payload, await this.familyNames());
      const problems = draftProblems(p);
      if (problems.length > 0) {
        throw new ConflictException({
          code: 'DRAFT_INCOMPLETE',
          message: 'Some required information is still missing',
          details: problems,
        });
      }
      const { audiences, categories } =
        await this.taxonomy.validateClassification({
          audiences: [p.audience!],
          categories: [p.category!],
        });
      const versions = draftVersions(p);
      const familyOf = new Map((p.colors ?? []).map((c) => [c.key, c.family!]));
      for (const v of versions) {
        await this.taxonomy.validateCombination(
          audiences,
          familyOf.get(v.color)!,
          v.size,
        );
      }

      // Brand: an existing one; the platform's "no brand" ONLY when chosen
      // explicitly; or the brand the seller asked for - approved: that
      // brand; still under review: no brand yet and NOT publishable until
      // approved (never shown as "no brand"); rejected: choose again.
      const sentinel = await tx.brand.findFirst({
        where: { isNoBrandSentinel: true },
        select: { id: true },
      });
      let brandId: string | null;
      let pendingRequestId: string | null = null;
      if (p.brand!.mode === 'existing') {
        const b = await tx.brand.findUnique({
          where: { id: p.brand!.brand_id },
          select: { id: true },
        });
        if (!b)
          throw new BadRequestException({
            code: 'BRAND_NOT_FOUND',
            message: 'This brand does not exist',
          });
        brandId = b.id;
      } else if (p.brand!.mode === 'request') {
        const req = await this.brandRequestOf(tx, d);
        if (!req || req.status === 'REJECTED' || req.status === 'WITHDRAWN') {
          throw new ConflictException({
            code: 'DRAFT_INCOMPLETE',
            message:
              'The requested brand was not approved - choose another brand',
            details: [{ code: 'BRAND_REJECTED', step: 1 }],
          });
        }
        if (req.status === 'APPROVED') {
          brandId = req.brand_id;
        } else {
          brandId = null;
          pendingRequestId = req.id;
        }
      } else {
        if (!sentinel)
          throw new ConflictException({
            code: 'NO_BRAND_SENTINEL_MISSING',
            message: 'The "no brand" brand is missing',
          });
        brandId = sentinel.id;
      }

      // Branches the stock goes to: this store's own, not archived.
      const stock = openingStock(p);
      const branchIds = new Set<string>(Object.keys(stock));
      if (branchIds.size > 0) {
        const branches = await tx.storeBranch.findMany({
          where: { id: { in: [...branchIds] }, vendorId, archivedAt: null },
          select: { id: true },
        });
        if (branches.length !== branchIds.size) {
          throw new BadRequestException({
            code: 'BRANCH_NOT_FOUND',
            message: "A branch is not one of this store's active branches",
          });
        }
      }
      for (const url of [
        ...p.colors!.flatMap((c) => c.images),
        ...p.colors!.flatMap((c) => (c.swatch ? [c.swatch] : [])),
        ...(p.shared_images ?? []),
      ]) {
        const problem = ownUploadProblem(url, vendorId);
        if (problem || !parseOwnUploadUrl(url)) {
          throw new BadRequestException({
            code: 'UPLOAD_NOT_USABLE',
            message: problem ?? 'Not an image of this store',
          });
        }
      }

      const specs = specsForCategory(p.category, p.specs);
      const offer = await tx.vendorOffer.create({
        data: {
          vendorId,
          titleAr: p.title_ar!.trim(),
          // Optional (SRS FR-CAT-014/015): '' = no English name.
          titleEn: (p.title_en ?? '').trim(),
          brandId,
          categoryTemplate: specs?.template ?? null,
          templateAttributes: specs
            ? (specs.attributes as Prisma.InputJsonValue)
            : Prisma.DbNull,
          season: null,
          taxonomyVersion: TAXONOMY_VERSION,
          requiresTaxonomy: true,
          // Phase A++ (item 5): checked by draftProblems (one of its sizes).
          modelHeightCm: p.model?.height_cm ?? null,
          modelSize: p.model?.size ?? null,
          // fabric composition (only a complete one - the gate checked it) and origin
          composition:
            (compositionForOffer(
              p.composition,
            ) as unknown as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          countryOfOrigin: p.country_of_origin ?? null,
        },
      });
      // «باركود المنتج للمحل»: the code chosen in the wizard, on the new
      // product in this same transaction (checked again here - a code another
      // product took meanwhile stops the publish, named, never dropped)
      const generatedCode =
        p.store_barcode?.mode === 'generate' ? p.store_barcode.code : undefined;
      if (generatedCode) {
        const problem = await this.storeBarcodeGate(tx, vendorId, d, p);
        if (problem) {
          throw new ConflictException({
            code: 'DRAFT_NOT_PUBLISHABLE',
            message: 'The product barcode cannot be used',
            details: [{ code: problem, step: 5 }],
          });
        }
        await this.barcodes.attachInTx(
          tx,
          vendorId,
          offer.id,
          {
            code: normalizeBarcode(generatedCode).code!,
            format: 'EAN13',
            source: 'GENERATED',
          },
          { userId, correlationId },
        );
      } else if (p.store_barcode?.mode === 'external') {
        const problem = await this.storeBarcodeProblem(
          tx,
          vendorId,
          p.store_barcode.code,
        );
        if (problem) {
          throw new ConflictException({
            code: 'DRAFT_NOT_PUBLISHABLE',
            message: 'The product barcode cannot be used',
            details: [{ code: problem, step: 5 }],
          });
        }
        const normalized = normalizeBarcode(p.store_barcode.code);
        await this.barcodes.attachInTx(
          tx,
          vendorId,
          offer.id,
          {
            code: normalized.code!,
            format: normalized.format!,
            source: 'EXTERNAL',
          },
          { userId, correlationId },
        );
      } else if (p.store_barcode?.mode === 'generate') {
        await this.barcodes.generateInTx(tx, vendorId, offer.id, {
          userId,
          correlationId,
        });
      }
      // Phase A++ (item 6): the product's own links to its shared images.
      if ((p.shared_images ?? []).length > 0) {
        await tx.vendorOfferSharedMedia.createMany({
          data: p.shared_images!.map((url, i) => ({
            vendorId,
            vendorOfferId: offer.id,
            url,
            sortOrder: i,
          })),
        });
      }
      // «مجموعات المتجر»: the collections chosen in the wizard - this
      // store's own only, the product added last in each. One deleted
      // meanwhile or already full never refuses the publish (a collection is
      // optional), but it is never skipped silently either: each one is
      // returned with why (DELETED / FULL), for the wizard to say so. The
      // draft keeps its choice as it was.
      const collectionsSkipped: {
        id: string;
        name: string | null;
        reason: 'DELETED' | 'FULL';
      }[] = [];
      if ((p.sections ?? []).length > 0) {
        const own = await tx.storeSection.findMany({
          where: { vendorId, id: { in: p.sections } },
          select: { id: true, name: true },
        });
        const names = new Map(own.map((x) => [x.id, x.name]));
        for (const sectionId of p.sections!) {
          if (!names.has(sectionId)) {
            collectionsSkipped.push({
              id: sectionId,
              name: null,
              reason: 'DELETED',
            });
            continue;
          }
          try {
            await appendToCollection(tx, vendorId, sectionId, [offer.id]);
          } catch (err) {
            if (
              err instanceof ConflictException &&
              (err.getResponse() as { code?: string }).code ===
                'STORE_COLLECTION_FULL'
            ) {
              collectionsSkipped.push({
                id: sectionId,
                name: names.get(sectionId) ?? null,
                reason: 'FULL',
              });
              continue;
            }
            throw err;
          }
        }
      }
      await tx.vendorOfferAudience.createMany({
        data: audiences.map((audience) => ({
          vendorOfferId: offer.id,
          vendorId,
          audience,
        })),
      });
      await tx.vendorOfferCategory.createMany({
        data: categories.map((categoryCode) => ({
          vendorOfferId: offer.id,
          vendorId,
          categoryCode,
        })),
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'vendor_offer.created',
          entityType: 'VendorOffer',
          entityId: offer.id,
          afterState: {
            title_ar: offer.titleAr,
            title_en: offer.titleEn,
            brand_id: brandId,
            audiences,
            categories,
            from_draft: draftId,
          },
        },
        tx,
      );

      // Every colour x size: one sellable version at the product's one price.
      // Phase A++: the discount through the same rules, on every version alike.
      const price = resolveUnifiedPrice({
        base_price: p.price!,
        ...discountFields(p.discount),
      });
      const now = new Date();
      // The product's colours, in the seller's order (the first is the
      // default): the draft's key -> the new product colour id.
      const colorIdOf = new Map<string, string>();
      const shadeOf = new Map<string, number>();
      const seenFamily = new Map<string, number>();
      for (const [i, c] of p.colors!.entries()) {
        const row = await tx.offerColor.create({
          data: {
            vendorId,
            vendorOfferId: offer.id,
            familyCode: c.family!,
            nameAr: c.name_ar.trim(),
            nameEn: c.name_en?.trim() || null,
            hex: c.hex ?? null,
            swatchUrl: c.swatch ?? null,
            sortOrder: i,
          },
        });
        colorIdOf.set(c.key, row.id);
        const n = (seenFamily.get(c.family!) ?? 0) + 1;
        seenFamily.set(c.family!, n);
        shadeOf.set(c.key, n);
      }
      const created: { id: string; color: string; size: string }[] = [];
      for (const v of versions) {
        const id = randomUUID();
        const key = versionKey(v.color, v.size);
        const family = familyOf.get(v.color)!;
        // The default SKU as before; a second shade of the same family gets
        // its number (SKUs are unique per store).
        const shade = shadeOf.get(v.color)!;
        const variant = await tx.offerVariant.create({
          data: {
            id,
            vendorId,
            vendorOfferId: offer.id,
            isCombination: true,
            offerColorId: colorIdOf.get(v.color)!,
            colorCode: family,
            sizeCode: v.size,
            colour: p.colors!.find((c) => c.key === v.color)!.name_ar.trim(),
            size: t.sizeByCode.get(v.size)!.label,
            sellerSku:
              p.sku_overrides?.[key] ??
              `${offer.id.slice(0, 8)}-${family}${shade > 1 ? shade : ''}-${v.size}`,
            storeInventoryBarcode: generateStoreInventoryBarcode(id),
            specsTextAr: p.description_ar?.trim() || null,
            specsTextEn: p.description_en?.trim() || null,
            matchProposalStatus: 'NONE',
            ...price,
          },
        });
        await tx.priceHistory.create({
          data: {
            vendorId,
            offerVariantId: variant.id,
            basePrice: variant.basePrice,
            salePrice: variant.salePrice,
            discountPercent: variant.discountPercent,
            discountStartAt: variant.discountStartAt,
            discountEndAt: variant.discountEndAt,
            effectivePriceAtChange: computeEffectivePrice(variant, now),
            reason: 'MANUAL_EDIT',
            changedBy: userId,
            changedAt: now,
          },
        });
        created.push({ id: variant.id, color: v.color, size: v.size });
      }

      // Each colour's images, copied to every size of that colour - all in
      // this transaction, so no size of a colour ever lacks its images.
      for (const c of p.colors!) {
        for (const v of created.filter((x) => x.color === c.key)) {
          await tx.offerVariantMedia.createMany({
            data: c.images.map((url, i) => ({
              vendorId,
              offerVariantId: v.id,
              url,
              kind: i === 0 ? ('PRIMARY' as const) : ('ADDITIONAL' as const),
              mediaType: 'IMAGE' as const,
              sortOrder: i,
            })),
          });
        }
      }

      // Opening stock: each colour x size x branch exactly as entered.
      const mutations = created.flatMap((v) =>
        Object.entries(stock)
          .map(([branchId, per]) => ({
            branchId,
            q: per[versionKey(v.color, v.size)] ?? 0,
          }))
          .filter(({ q }) => q > 0)
          .map(({ branchId, q }) => ({
            vendorId,
            branchId,
            offerVariantId: v.id,
            quantityDelta: q,
          })),
      );
      if (mutations.length > 0) {
        const results = await lockOffersWideForRestock(tx, mutations);
        for (const m of mutations) {
          const r = results.get(`${m.branchId}:${m.offerVariantId}`);
          const movement = await tx.stockMovement.create({
            data: {
              vendorId,
              branchId: m.branchId,
              offerVariantId: m.offerVariantId,
              quantityDelta: m.quantityDelta,
              resultingQuantity: r?.targetStock.quantity ?? m.quantityDelta,
              reason: 'INITIAL_STOCK',
              reasonNote: 'الكمية الافتتاحية عند إنشاء المنتج',
              actorId: userId,
            },
          });
          await this.auditLog.record(
            {
              actorId: userId,
              correlationId,
              action: 'stock_movement.recorded',
              entityType: 'StockMovement',
              entityId: movement.id,
              afterState: {
                offer_variant_id: m.offerVariantId,
                branch_id: m.branchId,
                quantity_delta: m.quantityDelta,
                reason: 'INITIAL_STOCK',
              },
            },
            tx,
          );
        }
      }
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'vendor_offer.combinations_created',
          entityType: 'VendorOffer',
          entityId: offer.id,
          afterState: {
            combinations: created.map((v) => ({
              variant_id: v.id,
              color_code: v.color,
              size_code: v.size,
            })),
          },
        },
        tx,
      );

      // A brand still under review follows the product: approving it
      // gives the product that brand (then it can be published).
      let brandRequest: { id: string; name: string; status: string } | null =
        null;
      if (pendingRequestId) {
        const br = await tx.brandRequest.update({
          where: { id: pendingRequestId },
          data: { offerId: offer.id },
        });
        brandRequest = { id: br.id, name: br.name, status: br.status };
      }

      await tx.offerDraft.update({
        where: { id: draftId },
        data: {
          status: 'SUBMITTED',
          offerId: offer.id,
          submittedAt: now,
          closedAt: now,
          revision: d.revision + 1,
        },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'offer_draft.submitted',
          entityType: 'OfferDraft',
          entityId: draftId,
          afterState: { offer_id: offer.id, versions: created.length },
        },
        tx,
      );
      return {
        offer_id: offer.id,
        versions: created.length,
        brand_request: brandRequest,
        collections_skipped: collectionsSkipped,
      };
    }
  }

  /**
   * Deletes the files of a CLOSED draft's upload ledger that nothing else
   * uses, then empties the ledger (so it runs once). "Used" = an offer
   * image, a store logo/cover/appearance, a branch photo, or any OPEN
   * draft (its images or its own ledger). Only this store's own upload
   * files are ever touched. Never throws for a file already gone.
   */
  async cleanUploads(
    draftId: string,
  ): Promise<{ removed: number; kept: number }> {
    const d = await this.prisma.offerDraft.findUnique({
      where: { id: draftId },
    });
    if (!d || d.status === 'OPEN') return { removed: 0, kept: 0 };
    const ledger = ((d.uploads as string[]) ?? []).filter(
      (u) => typeof u === 'string',
    );
    let removed = 0;
    let kept = 0;
    for (const url of ledger) {
      const own = parseOwnUploadUrl(url);
      if (!own || own.vendorId !== d.vendorId) {
        kept += 1;
        continue;
      }
      if (await this.isUploadInUse(url, own.file, draftId)) {
        kept += 1;
        continue;
      }
      try {
        await unlink(
          path.join(uploadsDir(), 'vendors', own.vendorId, own.file),
        );
        removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(
            `Could not remove draft upload ${own.file}: ${(err as Error).message}`,
          );
          kept += 1;
          continue;
        }
      }
    }
    await this.prisma.offerDraft.update({
      where: { id: draftId },
      data: { uploads: [] },
    });
    return { removed, kept };
  }

  /** Whether anything still uses this upload (also the import's clean-up of an interrupted confirm). */
  async isUploadInUse(
    url: string,
    file: string,
    exceptDraftId: string,
  ): Promise<boolean> {
    const like = `%${file}%`;
    const rows = await this.prisma.$queryRaw<{ used: boolean }[]>`
      SELECT (
        EXISTS (SELECT 1 FROM offer_variant_media WHERE url = ${url})
        OR EXISTS (SELECT 1 FROM vendor_offer_shared_media WHERE url = ${url})
        OR EXISTS (SELECT 1 FROM offer_colors WHERE "swatchUrl" = ${url})
        OR EXISTS (SELECT 1 FROM branch_order_items WHERE "colorSwatchUrlSnapshot" = ${url})
        OR EXISTS (SELECT 1 FROM vendors WHERE "logoUrl" = ${url} OR "coverImageUrl" = ${url} OR "storefrontAppearance"::text LIKE ${like})
        OR EXISTS (SELECT 1 FROM store_branches WHERE "verificationPhotoUrl" = ${url})
        OR EXISTS (SELECT 1 FROM store_sections WHERE "coverUrl" = ${url})
        OR EXISTS (SELECT 1 FROM offer_drafts WHERE id <> ${exceptDraftId} AND status = 'OPEN'
                   AND (payload::text LIKE ${like} OR uploads::text LIKE ${like}))
      ) AS used`;
    return rows[0]?.used ?? true;
  }

  /**
   * The clean-up sweep's work (see DraftUploadSweepService): close OPEN
   * drafts untouched for DRAFT_ABANDON_AFTER_DAYS (ABANDONED), then clean
   * the ledger of every closed draft that still has one. Bounded per run.
   */
  async sweepOnce(
    now = new Date(),
    limit = 50,
  ): Promise<{ abandoned: number; cleaned: number; removed: number }> {
    const cutoff = new Date(
      now.getTime() - DRAFT_ABANDON_AFTER_DAYS * 86_400_000,
    );
    const stale = await this.prisma.offerDraft.findMany({
      where: { status: 'OPEN', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: limit,
    });
    let abandoned = 0;
    for (const s of stale) {
      const r = await this.prisma.offerDraft.updateMany({
        where: { id: s.id, status: 'OPEN', updatedAt: { lt: cutoff } },
        data: { status: 'ABANDONED', closedAt: now },
      });
      abandoned += r.count;
    }
    const closed = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM offer_drafts WHERE status <> 'OPEN' AND jsonb_array_length(uploads) > 0 LIMIT ${limit}`;
    let removed = 0;
    for (const c of closed) removed += (await this.cleanUploads(c.id)).removed;
    return { abandoned, cleaned: closed.length, removed };
  }
}

function editUseApply() {
  return new ConflictException({
    code: 'EDIT_DRAFT_USE_APPLY',
    message:
      'This draft edits a published product - apply it, it is never published as a new one',
  });
}
