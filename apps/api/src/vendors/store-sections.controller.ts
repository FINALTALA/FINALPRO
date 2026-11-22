import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ownUploadProblem, parseOwnUploadUrl } from '../uploads/uploads.util';
import { CreateStoreSectionDto } from './dto/create-store-section.dto';
import { RenameStoreSectionDto } from './dto/rename-store-section.dto';
import { ReorderStoreSectionsDto } from './dto/reorder-store-sections.dto';
import {
  CollectionOffersDto,
  MoveCollectionOfferDto,
  OfferCollectionsDto,
} from './dto/store-collection-offers.dto';
import {
  appendToCollection,
  lockCollection,
  MAX_COLLECTION_PRODUCTS,
  MAX_STORE_COLLECTIONS,
  shopperVisible,
  writeCollectionOrder,
} from './store-collections.util';

type SectionRow = {
  id: string;
  name: string;
  nameEn: string | null;
  coverUrl: string | null;
  isVisible: boolean;
  sortOrder: number;
};

function sectionDto(section: SectionRow) {
  return {
    id: section.id,
    // `name` is the older field (the Arabic name) - kept for its readers.
    name: section.name,
    name_ar: section.name,
    name_en: section.nameEn,
    cover_url: section.coverUrl,
    visible: section.isVisible,
    sort_order: section.sortOrder,
  };
}

const notFound = () =>
  new NotFoundException({
    code: 'STORE_SECTION_NOT_FOUND',
    message: 'Store collection not found',
  });

/**
 * Shared field rules of create / update: a non-empty Arabic name, an
 * optional English name (empty = none), and a cover that is one of THIS
 * store's own uploads (null removes it). Returns the columns to write.
 */
function collectionFields(
  vendorId: string,
  dto: CreateStoreSectionDto,
  creating: boolean,
): Partial<Pick<SectionRow, 'name' | 'nameEn' | 'coverUrl' | 'isVisible'>> {
  const out: Partial<
    Pick<SectionRow, 'name' | 'nameEn' | 'coverUrl' | 'isVisible'>
  > = {};
  const ar = dto.name_ar ?? dto.name;
  if (ar !== undefined) {
    if (!ar.trim()) {
      throw new BadRequestException({
        code: 'STORE_COLLECTION_NAME_REQUIRED',
        message: 'The Arabic name is required',
      });
    }
    out.name = ar.trim();
  } else if (creating) {
    throw new BadRequestException({
      code: 'STORE_COLLECTION_NAME_REQUIRED',
      message: 'The Arabic name is required',
    });
  }
  if (dto.name_en !== undefined) out.nameEn = dto.name_en?.trim() || null;
  if (dto.cover_url !== undefined) {
    if (dto.cover_url === null || dto.cover_url === '') out.coverUrl = null;
    else {
      const problem = parseOwnUploadUrl(dto.cover_url)
        ? ownUploadProblem(dto.cover_url, vendorId)
        : 'The cover must be an image uploaded by this store';
      if (problem) {
        throw new BadRequestException({
          code: 'UPLOAD_NOT_USABLE',
          message: problem,
        });
      }
      out.coverUrl = dto.cover_url;
    }
  }
  if (dto.visible !== undefined) out.isVisible = dto.visible;
  return out;
}

// Sprint 8 (RB-STOREF-002, PDR-012) store sections, extended 2026-11-18 into
// «مجموعات المتجر»: the store's own manual collections (Arabic name required,
// English optional, optional cover, visible/hidden, manual order of the
// collections AND of the products inside each, at most 20 collections and
// 500 products each). «الكل», «وصل حديثاً» and «تخفيضات» are automatic
// filters computed on read - never rows here.
//
// The owner sees every linked product with whether shoppers see it: a
// draft, unpublished or sold-out product stays linked but is not shown, and
// a collection with no product shoppers can see is not shown at all.
//
// Owner-only throughout, per-method (not class-level) @RequireVendorRole
// ('OWNER') - VendorMembershipGuard reads it via Reflector.get(KEY,
// context.getHandler()), which never sees a class-level decorator.
@Controller('vendors/:vendorId/sections')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StoreSectionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  /** Live stock (sellable branches) per offer of this store, for the given offers. */
  private async availableByOffer(
    vendorId: string,
    offerIds: string[],
  ): Promise<Map<string, number>> {
    if (offerIds.length === 0) return new Map();
    const variants = await this.prisma.offerVariant.findMany({
      where: { vendorOfferId: { in: offerIds } },
      select: { id: true, vendorOfferId: true },
    });
    const availability = await this.fulfilment.availableByVariant(
      variants.map((v) => ({ id: v.id, vendorId })),
    );
    const out = new Map<string, number>();
    for (const v of variants) {
      out.set(
        v.vendorOfferId,
        (out.get(v.vendorOfferId) ?? 0) + (availability.get(v.id)?.total ?? 0),
      );
    }
    return out;
  }

  @Get()
  @RequireVendorRole('OWNER')
  async list(@Param('vendorId') vendorId: string) {
    const sections = await this.prisma.storeSection.findMany({
      where: { vendorId },
      orderBy: { sortOrder: 'asc' },
      include: {
        offers: {
          orderBy: { sortOrder: 'asc' },
          select: { offerId: true, offer: { select: { status: true } } },
        },
      },
    });
    const available = await this.availableByOffer(vendorId, [
      ...new Set(sections.flatMap((s) => s.offers.map((o) => o.offerId))),
    ]);
    return sections.map((s) => {
      const shopperCount = s.offers.filter((o) =>
        shopperVisible(o.offer, available.get(o.offerId) ?? 0),
      ).length;
      return {
        ...sectionDto(s),
        product_count: s.offers.length,
        shopper_count: shopperCount,
        // what shoppers see of it: hidden by the owner, or no product they can see
        shown_to_shoppers: s.isVisible && shopperCount > 0,
        // offer_ids lets the owner screens show membership without a
        // round trip per collection (in the collection's own order).
        offer_ids: s.offers.map((o) => o.offerId),
      };
    });
  }

  @BlockWhenSuspended()
  @Post()
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  async create(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStoreSectionDto,
    @Req() req: Request,
  ) {
    const fields = collectionFields(vendorId, dto, true);
    return this.prisma.$transaction(async (tx) => {
      // The 20-collection cap must hold under concurrency - advisory-locked
      // per vendor before the count check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:store_sections:' || ${vendorId}))`;

      const count = await tx.storeSection.count({ where: { vendorId } });
      if (count >= MAX_STORE_COLLECTIONS) {
        throw new ForbiddenException({
          code: 'STORE_SECTION_LIMIT_REACHED',
          message: `A store may have at most ${MAX_STORE_COLLECTIONS} collections`,
        });
      }
      const last = await tx.storeSection.aggregate({
        where: { vendorId },
        _max: { sortOrder: true },
      });
      const section = await tx.storeSection.create({
        data: {
          vendorId,
          name: fields.name!,
          nameEn: fields.nameEn ?? null,
          coverUrl: fields.coverUrl ?? null,
          isVisible: fields.isVisible ?? true,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_section.created',
          entityType: 'StoreSection',
          entityId: section.id,
          afterState: sectionDto(section),
        },
        tx,
      );
      return sectionDto(section);
    });
  }

  private async requireOwnSection(vendorId: string, sectionId: string) {
    const section = await this.prisma.storeSection.findUnique({
      where: { id: sectionId },
    });
    if (!section || section.vendorId !== vendorId) throw notFound();
    return section;
  }

  /** The products of this store among `offerIds` (any status but archived); 404 for anything else. */
  private async requireOwnOffers(vendorId: string, offerIds: string[]) {
    const unique = [...new Set(offerIds)];
    const found = await this.prisma.vendorOffer.findMany({
      where: { id: { in: unique }, vendorId, status: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
  }

  /**
   * The picker («اختيار المنتجات»): this store's products (not archived),
   * filtered by search (Arabic/English name), category, status and stock,
   * a page at a time, each saying whether it is already in the collection.
   */
  @Get(':sectionId/candidates')
  @RequireVendorRole('OWNER')
  async candidates(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    const q = (query.q ?? '').trim().toLowerCase().slice(0, 80);
    const category = query.category?.trim() || null;
    const status = query.status?.trim().toUpperCase() || null;
    const stock = query.stock?.trim() || null; // 'in' | 'out'
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(
      60,
      Math.max(1, Number.parseInt(query.page_size ?? '30', 10) || 30),
    );
    const [offers, inIt] = await Promise.all([
      this.prisma.vendorOffer.findMany({
        where: { vendorId, status: { not: 'ARCHIVED' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          titleAr: true,
          titleEn: true,
          status: true,
          audiences: { select: { audience: true } },
          categories: { select: { categoryCode: true } },
          variants: {
            orderBy: [
              { offerColor: { sortOrder: 'asc' } },
              { createdAt: 'asc' },
            ],
            take: 1,
            select: { media: { select: { url: true, kind: true } } },
          },
        },
      }),
      this.prisma.storeSectionOffer.findMany({
        where: { sectionId },
        select: { offerId: true },
      }),
    ]);
    const available = await this.availableByOffer(
      vendorId,
      offers.map((o) => o.id),
    );
    const member = new Set(inIt.map((r) => r.offerId));
    const categories = [
      ...new Set(
        offers.flatMap((o) => o.categories.map((c) => c.categoryCode)),
      ),
    ];
    const matched = offers.filter((o) => {
      const stockNow = available.get(o.id) ?? 0;
      return (
        (!q ||
          o.titleAr.toLowerCase().includes(q) ||
          (o.titleEn ?? '').toLowerCase().includes(q)) &&
        (!category || o.categories.some((c) => c.categoryCode === category)) &&
        (!status || o.status === status) &&
        (!stock || (stock === 'in' ? stockNow > 0 : stockNow <= 0))
      );
    });
    return {
      total: matched.length,
      page,
      page_size: pageSize,
      categories,
      in_collection: member.size,
      items: matched.slice((page - 1) * pageSize, page * pageSize).map((o) => {
        const media = o.variants[0]?.media ?? [];
        return {
          offer_id: o.id,
          title_ar: o.titleAr,
          title_en: o.titleEn,
          status: o.status,
          audiences: o.audiences.map((a) => a.audience),
          categories: o.categories.map((c) => c.categoryCode),
          image_url:
            media.find((m) => m.kind === 'PRIMARY')?.url ??
            media[0]?.url ??
            null,
          available: available.get(o.id) ?? 0,
          in_collection: member.has(o.id),
        };
      }),
    };
  }

  @Get(':sectionId')
  @RequireVendorRole('OWNER')
  async detail(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') sizeRaw?: string,
  ) {
    const section = await this.requireOwnSection(vendorId, sectionId);
    const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(sizeRaw ?? '50', 10) || 50),
    );
    const [total, rows, all] = await Promise.all([
      this.prisma.storeSectionOffer.count({ where: { sectionId } }),
      this.prisma.storeSectionOffer.findMany({
        where: { sectionId },
        orderBy: { sortOrder: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          offer: {
            select: {
              id: true,
              titleAr: true,
              titleEn: true,
              status: true,
              audiences: { select: { audience: true } },
              categories: { select: { categoryCode: true } },
              variants: {
                orderBy: [
                  { offerColor: { sortOrder: 'asc' } },
                  { createdAt: 'asc' },
                ],
                take: 1,
                select: { media: { select: { url: true, kind: true } } },
              },
            },
          },
        },
      }),
      this.prisma.storeSectionOffer.findMany({
        where: { sectionId },
        select: { offerId: true, offer: { select: { status: true } } },
      }),
    ]);
    const available = await this.availableByOffer(
      vendorId,
      all.map((r) => r.offerId),
    );
    const shopperCount = all.filter((r) =>
      shopperVisible(r.offer, available.get(r.offerId) ?? 0),
    ).length;
    return {
      ...sectionDto(section),
      product_count: total,
      shopper_count: shopperCount,
      shown_to_shoppers: section.isVisible && shopperCount > 0,
      limit: MAX_COLLECTION_PRODUCTS,
      page,
      page_size: pageSize,
      items: rows.map((r, i) => {
        const media = r.offer.variants[0]?.media ?? [];
        const image =
          media.find((m) => m.kind === 'PRIMARY')?.url ?? media[0]?.url ?? null;
        const stock = available.get(r.offerId) ?? 0;
        return {
          offer_id: r.offer.id,
          title_ar: r.offer.titleAr,
          title_en: r.offer.titleEn,
          status: r.offer.status,
          audiences: r.offer.audiences.map((a) => a.audience),
          categories: r.offer.categories.map((c) => c.categoryCode),
          image_url: image,
          available: stock,
          shown_to_shoppers: shopperVisible(r.offer, stock),
          position: (page - 1) * pageSize + i,
        };
      }),
    };
  }

  private async update(
    vendorId: string,
    sectionId: string,
    user: AuthenticatedUser,
    dto: RenameStoreSectionDto,
    req: Request,
  ) {
    const existing = await this.requireOwnSection(vendorId, sectionId);
    const fields = collectionFields(vendorId, dto, false);
    const updated = await this.prisma.storeSection.update({
      where: { id: sectionId },
      data: fields,
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_section.updated',
      entityType: 'StoreSection',
      entityId: sectionId,
      beforeState: sectionDto(existing),
      afterState: sectionDto(updated),
    });
    return sectionDto(updated);
  }

  @BlockWhenSuspended()
  @Put(':sectionId')
  @RequireVendorRole('OWNER')
  async rename(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameStoreSectionDto,
    @Req() req: Request,
  ) {
    return this.update(vendorId, sectionId, user, dto, req);
  }

  @BlockWhenSuspended()
  @Patch(':sectionId')
  @RequireVendorRole('OWNER')
  async patch(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameStoreSectionDto,
    @Req() req: Request,
  ) {
    return this.update(vendorId, sectionId, user, dto, req);
  }

  @BlockWhenSuspended()
  @Post('reorder')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async reorder(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderStoreSectionsDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.storeSection.findMany({
        where: { vendorId },
      });
      const existingIds = new Set(existing.map((s) => s.id));
      const providedIds = dto.section_ids;
      const providedSet = new Set(providedIds);
      // The provided list must be EXACTLY this vendor's own collection
      // ids, no more, no fewer, no foreign ids - never a partial order.
      if (
        providedSet.size !== providedIds.length ||
        providedSet.size !== existingIds.size ||
        ![...providedSet].every((id) => existingIds.has(id))
      ) {
        throw new ForbiddenException({
          code: 'STORE_SECTION_REORDER_MISMATCH',
          message:
            "section_ids must contain exactly this store's own collection ids, each exactly once",
        });
      }

      for (let i = 0; i < providedIds.length; i += 1) {
        await tx.storeSection.update({
          where: { id: providedIds[i] },
          data: { sortOrder: i },
        });
      }
      const reordered = await tx.storeSection.findMany({
        where: { vendorId },
        orderBy: { sortOrder: 'asc' },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_sections.reordered',
          entityType: 'Vendor',
          entityId: vendorId,
          afterState: { section_ids: providedIds },
        },
        tx,
      );
      return reordered.map(sectionDto);
    });
  }

  @BlockWhenSuspended()
  @Delete(':sectionId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async remove(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const existing = await this.requireOwnSection(vendorId, sectionId);
    await this.prisma.$transaction(async (tx) => {
      // Deleting a collection removes only that grouping - the links, then
      // the collection; the products themselves are never touched.
      await tx.storeSectionOffer.deleteMany({ where: { sectionId } });
      await tx.storeSection.delete({ where: { id: sectionId } });
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_section.deleted',
      entityType: 'StoreSection',
      entityId: sectionId,
      beforeState: sectionDto(existing),
    });
    return { deleted: true };
  }

  /** One product, added last (idempotent: already in it = no change). */
  @BlockWhenSuspended()
  @Put(':sectionId/offers/:offerId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async addOffer(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    await this.requireOwnOffers(vendorId, [offerId]);
    const r = await this.prisma.$transaction((tx) =>
      appendToCollection(tx, vendorId, sectionId, [offerId]),
    );
    if (r.added.length > 0) {
      await this.auditLog.record({
        actorId: user.id,
        correlationId: req.correlationId,
        action: 'store_section.offer_added',
        entityType: 'StoreSection',
        entityId: sectionId,
        afterState: { offer_id: offerId },
      });
    }
    return { section_id: sectionId, offer_id: offerId };
  }

  /** Several products at once, added last in the given order. */
  @BlockWhenSuspended()
  @Post(':sectionId/offers')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async addOffers(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CollectionOffersDto,
    @Req() req: Request,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    await this.requireOwnOffers(vendorId, dto.offer_ids);
    const r = await this.prisma.$transaction(async (tx) => {
      const res = await appendToCollection(
        tx,
        vendorId,
        sectionId,
        dto.offer_ids,
      );
      if (res.added.length > 0) {
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'store_section.offers_added',
            entityType: 'StoreSection',
            entityId: sectionId,
            afterState: { offer_ids: res.added },
          },
          tx,
        );
      }
      return res;
    });
    const productCount = await this.prisma.storeSectionOffer.count({
      where: { sectionId },
    });
    return {
      added: r.added,
      already_in: r.already,
      product_count: productCount,
    };
  }

  /** Several products out at once (not in it = ignored); the rest keep their order. */
  @BlockWhenSuspended()
  @Post(':sectionId/offers/remove')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async removeOffers(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CollectionOffersDto,
    @Req() req: Request,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    const removed = await this.prisma.$transaction(async (tx) => {
      await lockCollection(tx, sectionId);
      const res = await tx.storeSectionOffer.deleteMany({
        where: { sectionId, offerId: { in: dto.offer_ids } },
      });
      if (res.count > 0) {
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'store_section.offers_removed',
            entityType: 'StoreSection',
            entityId: sectionId,
            beforeState: { offer_ids: dto.offer_ids },
          },
          tx,
        );
      }
      return res.count;
    });
    return { removed };
  }

  /** Moves one product to a position (0-based); the others shift. */
  @BlockWhenSuspended()
  @Post(':sectionId/offers/move')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async moveOffer(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MoveCollectionOfferDto,
    @Req() req: Request,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    return this.prisma.$transaction(async (tx) => {
      await lockCollection(tx, sectionId);
      const rows = await tx.storeSectionOffer.findMany({
        where: { sectionId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { offerId: true },
      });
      const ids = rows.map((r) => r.offerId);
      const from = ids.indexOf(dto.offer_id);
      if (from < 0) {
        throw new NotFoundException({
          code: 'STORE_SECTION_OFFER_NOT_FOUND',
          message: 'This product is not in this collection',
        });
      }
      const to = Math.min(dto.position, ids.length - 1);
      ids.splice(from, 1);
      ids.splice(to, 0, dto.offer_id);
      await writeCollectionOrder(tx, sectionId, ids);
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_section.offer_moved',
          entityType: 'StoreSection',
          entityId: sectionId,
          beforeState: { offer_id: dto.offer_id, position: from },
          afterState: { offer_id: dto.offer_id, position: to },
        },
        tx,
      );
      return { offer_id: dto.offer_id, position: to };
    });
  }

  @BlockWhenSuspended()
  @Delete(':sectionId/offers/:offerId')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async removeOffer(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireOwnSection(vendorId, sectionId);
    const membership = await this.prisma.storeSectionOffer.findUnique({
      where: { sectionId_offerId: { sectionId, offerId } },
    });
    if (!membership) {
      throw new NotFoundException({
        code: 'STORE_SECTION_OFFER_NOT_FOUND',
        message: 'This offer is not in this section',
      });
    }
    await this.prisma.storeSectionOffer.delete({
      where: { id: membership.id },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_section.offer_removed',
      entityType: 'StoreSection',
      entityId: sectionId,
      beforeState: { offer_id: offerId },
    });
    return { deleted: true };
  }
}

/**
 * A product's own «المجموعات» (the owner's product page and the edit
 * wizard's review): read and set directly - not through an edit draft (a
 * collection is the store's own arrangement, not product content), with an
 * audit record. Setting adds the product LAST in each new collection and
 * takes it out of the ones not listed.
 */
@Controller('vendors/:vendorId/offers/:offerId/sections')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class OfferCollectionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async requireOwnOffer(vendorId: string, offerId: string) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: { id: true, vendorId: true, status: true },
    });
    if (!offer || offer.vendorId !== vendorId || offer.status === 'ARCHIVED') {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
  }

  @Get()
  @RequireVendorRole('OWNER')
  async get(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
  ) {
    await this.requireOwnOffer(vendorId, offerId);
    const rows = await this.prisma.storeSectionOffer.findMany({
      where: { vendorId, offerId },
      select: { sectionId: true },
    });
    return { section_ids: rows.map((r) => r.sectionId) };
  }

  @BlockWhenSuspended()
  @Put()
  @RequireVendorRole('OWNER')
  async set(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OfferCollectionsDto,
    @Req() req: Request,
  ) {
    await this.requireOwnOffer(vendorId, offerId);
    const wanted = [...new Set(dto.section_ids)];
    const own = await this.prisma.storeSection.findMany({
      where: { vendorId, id: { in: wanted } },
      select: { id: true },
    });
    if (own.length !== wanted.length) throw notFound();
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.storeSectionOffer.findMany({
        where: { vendorId, offerId },
        select: { sectionId: true },
      });
      const before = current.map((c) => c.sectionId);
      const toRemove = before.filter((id) => !wanted.includes(id));
      const toAdd = wanted.filter((id) => !before.includes(id));
      for (const sectionId of toRemove) {
        await lockCollection(tx, sectionId);
        await tx.storeSectionOffer.deleteMany({
          where: { sectionId, offerId },
        });
      }
      for (const sectionId of toAdd) {
        await appendToCollection(tx, vendorId, sectionId, [offerId]);
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'offer.collections_set',
            entityType: 'VendorOffer',
            entityId: offerId,
            beforeState: { section_ids: before },
            afterState: { section_ids: wanted },
          },
          tx,
        );
      }
      return { section_ids: wanted };
    });
  }
}
