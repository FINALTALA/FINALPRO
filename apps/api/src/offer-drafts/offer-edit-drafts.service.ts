import { compositionForOffer, compositionView } from '../offers/composition';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OfferDraft, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { lockOffersWideForRestock } from '../checkout/stock-lock.util';
import { generateStoreInventoryBarcode } from '../common/barcode.util';
import { MatchingService } from '../matching/matching.service';
import { modelProblem } from '../offers/offer-presentation';
import { OfferPublishService } from '../offers/offer-publish.service';
import { applyOfferPrice } from '../offers/pricing/apply-offer-price';
import { computeEffectivePrice } from '../offers/pricing/effective-price.util';
import { resolveUnifiedPrice } from '../offers/pricing/unified-price.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { SizeGuidesService } from '../size-guides/size-guides.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import {
  DraftDiscount,
  DraftPayload,
  discountFields,
  draftVersions,
  readDraftPayload,
  sizeSystemOf,
  specsForCategory,
  versionKey,
} from './draft-payload';
import {
  assertEditAllowed,
  changedGroups,
  conflictGroups,
  EDIT_GROUPS,
  EditGroup,
  EditSnapshot,
  groupValue,
} from './edit-rules';
import { OfferDraftsService } from './offer-drafts.service';

type Tx = Prisma.TransactionClient;

/**
 * Edit drafts of a published product. The product stays exactly as it is
 * while the draft is edited (the preview shows the result); «تطبيق
 * التعديلات» applies the whole result in ONE transaction - or nothing: the
 * price through the one price path (history + outbox notifications in the
 * same transaction), content, colours, new versions (with an opening
 * quantity), images, model, the size table (a new version), then the
 * publish check on the final state (an ACTIVE product must pass; an
 * INACTIVE one is applied and stays INACTIVE, its problems are notes). A
 * content change made elsewhere since the draft was opened (the product's
 * contentRevision moved) stops the apply with the groups that changed -
 * nothing is merged silently.
 */
@Injectable()
export class OfferEditDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly auditLog: AuditLogService,
    private readonly sizeGuides: SizeGuidesService,
    private readonly offerPublish: OfferPublishService,
    private readonly outbox: OutboxEventService,
    private readonly matching: MatchingService,
    private readonly drafts: OfferDraftsService,
  ) {}

  /** The product's current content as an edit draft payload (no stock, no SKUs). */
  async snapshot(
    db: Tx | PrismaService,
    vendorId: string,
    offerId: string,
    keys: Record<string, string> = {},
  ): Promise<EditSnapshot> {
    const o = await db.vendorOffer.findFirst({
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
          include: {
            media: {
              where: { mediaType: 'IMAGE' },
              orderBy: { sortOrder: 'asc' },
              select: { url: true, kind: true },
            },
          },
        },
      },
    });
    if (!o) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    const keyOfId = new Map(Object.entries(keys).map(([k, id]) => [id, k]));
    const used = new Set(keyOfId.values());
    const shades = new Map<string, number>();
    const colorIds: Record<string, string> = {};
    const colors: DraftPayload['colors'] = [];
    const sizes: Record<string, string[]> = {};
    const mixedImages: string[] = [];
    const ordered = (m: { url: string; kind: string }[]) =>
      [
        ...m.filter((x) => x.kind === 'PRIMARY'),
        ...m.filter((x) => x.kind !== 'PRIMARY'),
      ].map((x) => x.url);
    for (const c of o.colors) {
      const own = o.variants.filter((v) => v.offerColorId === c.id);
      let key = keyOfId.get(c.id);
      if (!key) {
        const n = (shades.get(c.familyCode) ?? 0) + 1;
        let shade = n;
        key = shade === 1 ? c.familyCode : `${c.familyCode}-${shade}`;
        while (used.has(key)) {
          shade += 1;
          key = `${c.familyCode}-${shade}`;
        }
        shades.set(c.familyCode, shade);
      }
      used.add(key);
      colorIds[key] = c.id;
      const sets = own.map((v) => JSON.stringify(ordered(v.media)));
      if (new Set(sets).size > 1) mixedImages.push(key);
      colors.push({
        key,
        family: c.familyCode,
        name_ar: c.nameAr,
        ...(c.nameEn ? { name_en: c.nameEn } : {}),
        ...(c.hex ? { hex: c.hex } : {}),
        ...(c.swatchUrl ? { swatch: c.swatchUrl } : {}),
        images: own[0] ? ordered(own[0].media) : [],
      });
      sizes[key] = [...new Set(own.map((v) => v.sizeCode!).filter(Boolean))];
    }
    const first = o.variants[0];
    const systems = new Set(Object.values(sizes).flat().map(sizeSystemOf));
    const discount: DraftDiscount | null = !first
      ? null
      : first.discountPercent !== null
        ? {
            mode: 'window',
            percent: Number(first.discountPercent),
            start_at: first.discountStartAt?.toISOString() ?? null,
            end_at: first.discountEndAt?.toISOString() ?? null,
          }
        : first.salePrice !== null
          ? { mode: 'sale', sale_price: Number(first.salePrice) }
          : null;
    const measurements = (
      await this.sizeGuides.offerMeasurements(vendorId, offerId)
    ).measurements;
    const payload: DraftPayload = {
      layout: 5,
      step: 1,
      audience: o.audiences[0]?.audience ?? null,
      category: o.categories[0]?.categoryCode ?? null,
      title_ar: o.titleAr,
      title_en: o.titleEn,
      ...(o.brand
        ? {
            brand: o.brand.isNoBrandSentinel
              ? { mode: 'none' as const }
              : { mode: 'existing' as const, brand_id: o.brand.id },
          }
        : {}),
      specs:
        o.templateAttributes && typeof o.templateAttributes === 'object'
          ? (Object.fromEntries(
              Object.entries(
                o.templateAttributes as Record<string, unknown>,
              ).filter(
                ([, v]) => typeof v === 'string' && v.trim() && v !== 'N/A',
              ),
            ) as Record<string, string>)
          : {},
      colors,
      size_system: systems.size === 1 ? [...systems][0] : null,
      sizes,
      price: first ? Number(first.basePrice) : null,
      discount,
      measurements: measurements ?? null,
      ...(o.modelHeightCm !== null && o.modelSize !== null
        ? { model: { height_cm: o.modelHeightCm, size: o.modelSize } }
        : {}),
      shared_images: o.sharedMedia.map((m) => m.url),
      description_ar: first?.specsTextAr ?? '',
      description_en: first?.specsTextEn ?? '',
      // fabric composition and country of origin - its own group
      ...compositionView(o.composition, o.countryOfOrigin),
    };
    return { payload, colorIds, mixedImages };
  }

  /**
   * «تعديل المنتج»: the product's ONE open edit draft - created now, or the
   * one a member of the store's team already opened (never a second).
   * Classified, published products only; an unclassified product keeps its
   * direct editing and gets OFFER_NOT_CLASSIFIED_FOR_EDIT here.
   */
  async open(
    vendorId: string,
    offerId: string,
    userId: string,
    correlationId: string,
  ) {
    const existing = await this.prisma.offerDraft.findFirst({
      where: { vendorId, editOfOfferId: offerId, status: 'OPEN' },
    });
    if (existing) {
      return {
        created: false,
        draft: await this.drafts.draftDto(existing, this.prisma, userId),
      };
    }
    const offer = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, vendorId },
    });
    if (!offer) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    if (offer.taxonomyVersion === null) {
      throw new ConflictException({
        code: 'OFFER_NOT_CLASSIFIED_FOR_EDIT',
        message: 'Classify this product first to use the edit wizard',
      });
    }
    if (offer.firstPublishedAt === null || offer.status === 'ARCHIVED') {
      throw new ConflictException({
        code: 'OFFER_NOT_EDITABLE_BY_DRAFT',
        message:
          'Only a published (active or paused) product is edited with an edit draft',
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
        const locked = await tx.vendorOffer.findUniqueOrThrow({
          where: { id: offerId },
        });
        const snap = await this.snapshot(tx, vendorId, offerId);
        const d = await tx.offerDraft.create({
          data: {
            vendorId,
            createdByUserId: userId,
            payload: snap.payload as Prisma.InputJsonValue,
            uploads: [],
            editOfOfferId: offerId,
            baseRevision: locked.contentRevision,
            baseSnapshot: snap as unknown as Prisma.InputJsonValue,
            lastEditedByUserId: userId,
            lastEditedAt: new Date(),
          },
        });
        await this.auditLog.record(
          {
            actorId: userId,
            correlationId,
            action: 'offer_draft.edit_opened',
            entityType: 'OfferDraft',
            entityId: d.id,
            afterState: {
              offer_id: offerId,
              base_revision: locked.contentRevision,
            },
          },
          tx,
        );
        return {
          created: true,
          draft: await this.drafts.draftDto(d, tx, userId),
        };
      });
    } catch (err) {
      // two members opening at once: the unique index keeps ONE - return it
      if ((err as { code?: string }).code === 'P2002') {
        const d = await this.prisma.offerDraft.findFirstOrThrow({
          where: { vendorId, editOfOfferId: offerId, status: 'OPEN' },
        });
        return {
          created: false,
          draft: await this.drafts.draftDto(d, this.prisma, userId),
        };
      }
      throw err;
    }
  }

  private baseOf(d: OfferDraft): EditSnapshot {
    return d.baseSnapshot as unknown as EditSnapshot;
  }

  /** The groups changed elsewhere since the draft was opened (empty when none). */
  async conflicts(tx: Tx | PrismaService, d: OfferDraft, mine: DraftPayload) {
    const base = this.baseOf(d);
    const current = await this.snapshot(
      tx,
      d.vendorId,
      d.editOfOfferId!,
      base.colorIds,
    );
    return {
      current,
      groups: conflictGroups(base.payload, current.payload, mine),
    };
  }

  /**
   * «تحديث المسودة» after a conflict: groups changed only elsewhere take the
   * product's current value; a group changed in both takes the seller's
   * explicit choice ('mine' | 'current' - required). The draft then builds
   * on the product's current revision. Nothing is decided silently.
   */
  async rebase(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    choices: Record<string, 'mine' | 'current'>,
    userId: string,
    correlationId: string,
  ) {
    const names = await this.drafts.familyNames();
    return this.prisma.$transaction(async (tx) => {
      const d = await this.drafts.lockOpen(
        tx,
        vendorId,
        draftId,
        expectedRevision,
      );
      if (!d.editOfOfferId) throw notEdit();
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${d.editOfOfferId} FOR UPDATE`;
      const offer = await tx.vendorOffer.findUniqueOrThrow({
        where: { id: d.editOfOfferId },
      });
      const mine = readDraftPayload(d.payload, names);
      const { current, groups } = await this.conflicts(tx, d, mine);
      const undecided = groups.filter(
        (g) => g.kind === 'both' && !choices[g.group],
      );
      if (undecided.length > 0) {
        throw new ConflictException({
          code: 'EDIT_CHOICE_REQUIRED',
          message:
            'Choose, for each group changed in both places, which version to keep',
          details: undecided,
        });
      }
      const next: DraftPayload = { ...mine };
      for (const g of groups) {
        if (g.kind === 'elsewhere' || choices[g.group] === 'current') {
          takeGroup(next, current.payload, g.group);
        }
      }
      // colours added elsewhere (or kept from the draft) stay keyed as the product has them
      const colorIds = { ...current.colorIds };
      const saved = await tx.offerDraft.update({
        where: { id: draftId },
        data: {
          payload: next as Prisma.InputJsonValue,
          baseRevision: offer.contentRevision,
          baseSnapshot: {
            ...current,
            colorIds,
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
          action: 'offer_draft.edit_rebased',
          entityType: 'OfferDraft',
          entityId: draftId,
          afterState: {
            base_revision: offer.contentRevision,
            groups: groups.map((g) => ({
              group: g.group,
              kind: g.kind,
              took: g.kind === 'elsewhere' ? 'current' : choices[g.group],
            })),
          },
        },
        tx,
      );
      return this.drafts.draftDto(saved, tx, userId);
    });
  }

  /** The review step: the groups this draft changes, and any conflict. */
  async review(vendorId: string, draftId: string) {
    const d = await this.prisma.offerDraft.findFirst({
      where: { id: draftId, vendorId },
    });
    if (!d) throw notFoundDraft();
    if (!d.editOfOfferId) throw notEdit();
    const mine = readDraftPayload(d.payload, await this.drafts.familyNames());
    const base = this.baseOf(d);
    const offer = await this.prisma.vendorOffer.findUniqueOrThrow({
      where: { id: d.editOfOfferId },
    });
    const groups = changedGroups(base.payload, mine).map((g) => ({
      group: g,
      before: groupValue(base.payload, g),
      after: groupValue(mine, g),
    }));
    const conflict =
      offer.contentRevision !== d.baseRevision
        ? (await this.conflicts(this.prisma, d, mine)).groups
        : [];
    const newColors = (mine.colors ?? [])
      .filter((c) => !base.colorIds[c.key])
      .map((c) => c.name_ar);
    const existing = new Set(
      draftVersions(base.payload).map((v) => versionKey(v.color, v.size)),
    );
    const newVersions = draftVersions(mine).filter(
      (v) => !existing.has(versionKey(v.color, v.size)),
    ).length;
    return {
      draft_id: d.id,
      offer_id: d.editOfOfferId,
      offer_status: offer.status,
      base_revision: d.baseRevision,
      current_revision: offer.contentRevision,
      groups,
      new_colors: newColors,
      new_versions: newVersions,
      mixed_images: base.mixedImages.filter((k) =>
        groups.some(
          (g) =>
            g.group === 'images' &&
            JSON.stringify((g.after as Record<string, unknown>)[k]) !==
              JSON.stringify((g.before as Record<string, unknown>)[k]),
        ),
      ),
      conflict,
    };
  }

  /** «تطبيق التعديلات»: everything, in one transaction - or nothing. */
  async apply(
    vendorId: string,
    draftId: string,
    expectedRevision: number,
    userId: string,
    correlationId: string,
    /** e2e only: throws after this step, to prove the rollback. */
    failAfter?: string,
  ) {
    const t = await this.taxonomy.get();
    const names = await this.drafts.familyNames();
    const result = await this.prisma
      .$transaction(
        async (tx) => {
          const d = await this.drafts.lockOpen(
            tx,
            vendorId,
            draftId,
            expectedRevision,
          );
          if (!d.editOfOfferId) throw notEdit();
          const offerId = d.editOfOfferId;
          await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;
          const offer = await tx.vendorOffer.findUniqueOrThrow({
            where: { id: offerId },
            include: { audiences: { select: { audience: true } } },
          });
          const base = this.baseOf(d);
          const p = readDraftPayload(d.payload, names);
          if (offer.contentRevision !== d.baseRevision) {
            const { groups } = await this.conflicts(tx, d, p);
            throw new ConflictException({
              code: 'EDIT_CONFLICT',
              message:
                'This product was changed elsewhere since the draft was opened',
              details: groups,
            });
          }
          assertEditAllowed(base, p);
          // the same judgement the wizard shows (the draft, its size table,
          // its brand) - live stock is not part of an edit
          const { problems } = await this.drafts.publishProblems(
            tx,
            vendorId,
            d,
          );
          if (problems.length > 0) {
            throw new ConflictException({
              code: 'DRAFT_NOT_PUBLISHABLE',
              message: 'Some required information is still missing',
              details: problems,
            });
          }
          const changed = new Set<EditGroup>(changedGroups(base.payload, p));
          const step = (name: string) => {
            if (failAfter === name)
              throw new Error(`E2E_EDIT_FAIL_AFTER:${name}`);
          };

          // brand: an existing one, «بدون علامة», or the one the seller asked
          // for - only once it is approved (a pending one blocks the apply)
          let brandId: string | null = offer.brandId;
          if (changed.has('brand')) {
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
            } else if (p.brand!.mode === 'none') {
              brandId = (
                await tx.brand.findFirstOrThrow({
                  where: { isNoBrandSentinel: true },
                  select: { id: true },
                })
              ).id;
            } else {
              const req = await this.drafts.brandRequestOf(tx, d);
              if (!req || req.status !== 'APPROVED' || !req.brand_id) {
                throw new ConflictException({
                  code: 'EDIT_BRAND_PENDING',
                  message:
                    'The requested brand is not approved yet - nothing was applied',
                  details: [{ status: req?.status ?? null }],
                });
              }
              brandId = req.brand_id;
            }
          }
          if (
            offer.canonicalProductId &&
            (changed.has('brand') || changed.has('specs'))
          ) {
            throw new ConflictException({
              code: 'CONFIRMED_MATCH_IDENTITY_LOCKED',
              message:
                'This product is matched to a canonical product - its brand and specifications cannot change',
            });
          }

          // 1. the price - the one price path (history + outbox in this transaction)
          if (changed.has('price')) {
            await applyOfferPrice(
              tx,
              { outbox: this.outbox, auditLog: this.auditLog },
              {
                vendorId,
                offerId,
                price: resolveUnifiedPrice({
                  base_price: p.price!,
                  ...discountFields(p.discount),
                }),
                userId,
                correlationId,
              },
            );
          }
          step('price');

          // 2. the product's own content
          const data: Prisma.VendorOfferUpdateInput = {};
          if (changed.has('title')) {
            data.titleAr = (p.title_ar ?? '').trim();
            data.titleEn = (p.title_en ?? '').trim();
          }
          if (changed.has('brand')) data.brand = { connect: { id: brandId! } };
          if (changed.has('specs')) {
            const specs = specsForCategory(p.category, p.specs);
            data.templateAttributes = specs
              ? (specs.attributes as Prisma.InputJsonValue)
              : Prisma.DbNull;
          }
          if (changed.has('model')) {
            const sizes = Object.values(p.sizes ?? {}).flat();
            const problem = modelProblem(
              p.model?.height_cm,
              p.model?.size,
              sizes,
            );
            if (problem)
              throw new BadRequestException({
                code: problem,
                message: 'Model information is not valid',
              });
            data.modelHeightCm = p.model?.height_cm ?? null;
            data.modelSize = p.model?.size?.trim() || null;
          }
          if (changed.has('composition')) {
            data.composition =
              (compositionForOffer(
                p.composition,
              ) as unknown as Prisma.InputJsonValue | null) ?? Prisma.DbNull;
            data.countryOfOrigin = p.country_of_origin ?? null;
          }
          if (Object.keys(data).length > 0) {
            await tx.vendorOffer.update({ where: { id: offerId }, data });
          }
          if (changed.has('description')) {
            await tx.offerVariant.updateMany({
              where: { vendorOfferId: offerId },
              data: {
                specsTextAr: (p.description_ar ?? '').trim() || null,
                specsTextEn: (p.description_en ?? '').trim() || null,
              },
            });
          }
          step('content');

          // 3. colours: existing ones (names, swatch, HEX, order), new ones
          const colorIdOf = new Map(Object.entries(base.colorIds));
          const existingRows = await tx.offerColor.findMany({
            where: { vendorOfferId: offerId },
          });
          const renamed = (p.colors ?? []).filter((c) => {
            const id = colorIdOf.get(c.key);
            const row = existingRows.find((r) => r.id === id);
            return row && row.nameAr !== c.name_ar.trim();
          });
          // two-phase rename, so two colours may swap names in one apply
          for (const c of renamed) {
            await tx.offerColor.update({
              where: { id: colorIdOf.get(c.key)! },
              data: { nameAr: `~${colorIdOf.get(c.key)!.slice(0, 30)}` },
            });
          }
          for (const [i, c] of (p.colors ?? []).entries()) {
            const id = colorIdOf.get(c.key);
            const fields = {
              nameAr: c.name_ar.trim(),
              nameEn: (c.name_en ?? '').trim() || null,
              hex: c.hex ?? null,
              swatchUrl: c.swatch ?? null,
              sortOrder: i,
            };
            if (id) {
              await tx.offerColor.update({ where: { id }, data: fields });
            } else {
              const row = await tx.offerColor.create({
                data: {
                  vendorId,
                  vendorOfferId: offerId,
                  familyCode: c.family!,
                  ...fields,
                },
              });
              colorIdOf.set(c.key, row.id);
            }
          }
          step('colors');

          // 4. new versions (a new colour, or a new size of a colour) at the
          //    product's price (already updated above), with their opening quantity
          const audiences = offer.audiences.map((a) => a.audience);
          const existing = new Set(
            draftVersions(base.payload).map((v) => versionKey(v.color, v.size)),
          );
          const fresh = draftVersions(p).filter(
            (v) => !existing.has(versionKey(v.color, v.size)),
          );
          const priced = await tx.offerVariant.findFirst({
            where: { vendorOfferId: offerId },
            orderBy: { id: 'asc' },
          });
          const familyOf = new Map(
            (p.colors ?? []).map((c) => [c.key, c.family!]),
          );
          const shadeOf = new Map<string, number>();
          const seen = new Map<string, number>();
          for (const c of p.colors ?? []) {
            const n = (seen.get(c.family!) ?? 0) + 1;
            seen.set(c.family!, n);
            shadeOf.set(c.key, n);
          }
          const now = new Date();
          const created: { id: string; color: string; size: string }[] = [];
          for (const v of fresh) {
            const family = familyOf.get(v.color)!;
            await this.taxonomy.validateCombination(audiences, family, v.size);
            const id = randomUUID();
            const key = versionKey(v.color, v.size);
            const shade = shadeOf.get(v.color)!;
            const variant = await tx.offerVariant.create({
              data: {
                id,
                vendorId,
                vendorOfferId: offerId,
                isCombination: true,
                offerColorId: colorIdOf.get(v.color)!,
                colorCode: family,
                sizeCode: v.size,
                colour: (p.colors ?? [])
                  .find((c) => c.key === v.color)!
                  .name_ar.trim(),
                size: t.sizeByCode.get(v.size)!.label,
                sellerSku:
                  p.sku_overrides?.[key] ??
                  `${offerId.slice(0, 8)}-${family}${shade > 1 ? shade : ''}-${v.size}`,
                storeInventoryBarcode: generateStoreInventoryBarcode(id),
                specsTextAr: (p.description_ar ?? '').trim() || null,
                specsTextEn: (p.description_en ?? '').trim() || null,
                matchProposalStatus: 'NONE',
                basePrice: priced!.basePrice,
                salePrice: priced!.salePrice,
                discountPercent: priced!.discountPercent,
                discountStartAt: priced!.discountStartAt,
                discountEndAt: priced!.discountEndAt,
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
          step('versions');

          // 5. images: a colour whose images changed (or a new colour) gets
          //    them on every one of its versions; a new size of an unchanged
          //    colour gets the colour's images
          const baseImages = groupValue(base.payload, 'images') as Record<
            string,
            string[]
          >;
          const all = await tx.offerVariant.findMany({
            where: { vendorOfferId: offerId, isCombination: true },
            select: { id: true, offerColorId: true },
          });
          for (const c of p.colors ?? []) {
            const colorId = colorIdOf.get(c.key)!;
            const isNew = !base.colorIds[c.key];
            const imagesChanged =
              isNew ||
              JSON.stringify(baseImages[c.key] ?? []) !==
                JSON.stringify(c.images);
            const targets = imagesChanged
              ? all.filter((v) => v.offerColorId === colorId).map((v) => v.id)
              : created.filter((v) => v.color === c.key).map((v) => v.id);
            if (targets.length === 0) continue;
            if (imagesChanged) {
              await tx.offerVariantMedia.deleteMany({
                where: { offerVariantId: { in: targets } },
              });
            }
            for (const id of targets) {
              await tx.offerVariantMedia.createMany({
                data: c.images.map((url, i) => ({
                  vendorId,
                  offerVariantId: id,
                  url,
                  kind:
                    i === 0 ? ('PRIMARY' as const) : ('ADDITIONAL' as const),
                  mediaType: 'IMAGE' as const,
                  sortOrder: i,
                })),
              });
            }
          }
          if (changed.has('shared_images')) {
            await tx.vendorOfferSharedMedia.deleteMany({
              where: { vendorOfferId: offerId },
            });
            const urls = p.shared_images ?? [];
            if (urls.length > 0) {
              await tx.vendorOfferSharedMedia.createMany({
                data: urls.map((url, i) => ({
                  vendorId,
                  vendorOfferId: offerId,
                  url,
                  sortOrder: i,
                })),
              });
            }
          }
          step('images');

          // 6. the size table: a new version (old orders keep theirs)
          if (changed.has('measurements')) {
            await this.sizeGuides.writeOfferMeasurements(
              tx,
              userId,
              correlationId,
              vendorId,
              offerId,
              p.measurements ?? null,
            );
          }
          step('measurements');

          // 7. opening quantities - new versions only (live stock is never touched)
          const mutations = created.flatMap((v) =>
            Object.entries(p.stock ?? {})
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
            const branchIds = [...new Set(mutations.map((m) => m.branchId))];
            const branches = await tx.storeBranch.count({
              where: { id: { in: branchIds }, vendorId, archivedAt: null },
            });
            if (branches !== branchIds.length) {
              throw new BadRequestException({
                code: 'BRANCH_NOT_FOUND',
                message: "A branch is not one of this store's active branches",
              });
            }
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
                  reasonNote:
                    'الكمية الافتتاحية لنسخة جديدة عند تطبيق تعديل المنتج',
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
          step('stock');

          // 8. the publish check on the FINAL state: an ACTIVE product must
          //    pass (else everything rolls back); a paused one is applied and
          //    stays paused - its problems are notes for the next publish
          const final = await tx.vendorOffer.findUniqueOrThrow({
            where: { id: offerId },
          });
          const gate = await this.offerPublish.problems(tx, vendorId, final, {
            lock: false,
          });
          // live stock is outside the edit (it never blocks applying content):
          // every other publish rule applies to the final state
          gate.missing = gate.missing.filter((m) => m !== 'available_stock');
          if (offer.status === 'ACTIVE' && gate.missing.length > 0) {
            throw new ConflictException({
              code: 'EDIT_NOT_PUBLISHABLE',
              message:
                'After these changes the product would not pass the publish check - nothing was applied',
              details: gate.missing.map((m) => ({ missing: m })),
            });
          }

          // the matching proposals follow a new name / brand / specs
          if (
            changed.has('title') ||
            changed.has('brand') ||
            changed.has('specs')
          ) {
            const unmatched = await tx.offerVariant.findMany({
              where: {
                vendorOfferId: offerId,
                matchProposalStatus: { in: ['NONE', 'REJECTED'] },
              },
              select: { id: true },
            });
            for (const v of unmatched)
              await this.matching.searchNonExactCandidates(vendorId, v.id, tx);
          }

          await tx.offerDraft.update({
            where: { id: draftId },
            data: {
              status: 'APPLIED',
              closedAt: now,
              revision: d.revision + 1,
              lastEditedByUserId: userId,
              lastEditedAt: now,
            },
          });
          const groups = [...changed];
          await this.auditLog.record(
            {
              actorId: userId,
              correlationId,
              action: 'vendor_offer.edit_applied',
              entityType: 'VendorOffer',
              entityId: offerId,
              beforeState: { content_revision: d.baseRevision },
              afterState: {
                draft_id: draftId,
                groups,
                new_versions: created.length,
                status: offer.status,
              },
            },
            tx,
          );
          step('end');
          return {
            offer_id: offerId,
            status: offer.status,
            groups,
            new_versions: created.length,
            notes: offer.status === 'ACTIVE' ? [] : gate.missing,
          };
        },
        { timeout: 30_000 },
      )
      .catch((err: unknown) => {
        // a new version's SKU already used in this store: nothing applied
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          JSON.stringify(err.meta ?? {}).includes('sellerSku')
        ) {
          throw new ConflictException({
            code: 'SELLER_SKU_ALREADY_EXISTS',
            message:
              'One of these SKUs is already used by another product of this store - nothing was applied',
          });
        }
        throw err;
      });
    await this.drafts.cleanUploads(draftId);
    return result;
  }
}

function notEdit() {
  return new ConflictException({
    code: 'NOT_AN_EDIT_DRAFT',
    message: 'This draft does not edit a product',
  });
}
function notFoundDraft() {
  return new NotFoundException({
    code: 'DRAFT_NOT_FOUND',
    message: 'Draft not found',
  });
}

/** A conflict resolution: one group of the draft takes the product's current value. */
function takeGroup(next: DraftPayload, cur: DraftPayload, g: EditGroup) {
  switch (g) {
    case 'title':
      next.title_ar = cur.title_ar;
      next.title_en = cur.title_en;
      return;
    case 'description':
      next.description_ar = cur.description_ar;
      next.description_en = cur.description_en;
      return;
    case 'specs':
      next.specs = cur.specs;
      return;
    case 'brand':
      next.brand = cur.brand;
      return;
    case 'price':
      next.price = cur.price;
      next.discount = cur.discount;
      return;
    case 'colors': {
      // the current colours' names / swatches / order; the draft's new colours stay at the end
      const mineByKey = new Map((next.colors ?? []).map((c) => [c.key, c]));
      const curKeys = new Set((cur.colors ?? []).map((c) => c.key));
      next.colors = [
        ...(cur.colors ?? []).map((c) => ({
          ...c,
          images: mineByKey.get(c.key)?.images ?? c.images,
        })),
        ...(next.colors ?? []).filter((c) => !curKeys.has(c.key)),
      ];
      return;
    }
    case 'images':
      next.colors = (next.colors ?? []).map((c) => {
        const now = (cur.colors ?? []).find((x) => x.key === c.key);
        return now ? { ...c, images: now.images } : c;
      });
      return;
    case 'sizes':
      next.sizes = {
        ...(next.sizes ?? {}),
        ...Object.fromEntries(
          Object.entries(cur.sizes ?? {}).map(([k, l]) => [
            k,
            [...new Set([...l, ...((next.sizes ?? {})[k] ?? [])])],
          ]),
        ),
      };
      return;
    case 'shared_images':
      next.shared_images = cur.shared_images;
      return;
    case 'model':
      next.model = cur.model ?? null;
      return;
    case 'measurements':
      next.measurements = cur.measurements ?? null;
      return;
    case 'composition':
      next.composition = cur.composition ?? null;
      next.country_of_origin = cur.country_of_origin ?? null;
      return;
  }
}

export { EDIT_GROUPS };
