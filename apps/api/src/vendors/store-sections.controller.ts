import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
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
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreSectionDto } from './dto/create-store-section.dto';
import { RenameStoreSectionDto } from './dto/rename-store-section.dto';
import { ReorderStoreSectionsDto } from './dto/reorder-store-sections.dto';

const MAX_CUSTOM_SECTIONS = 20;

function sectionDto(section: { id: string; name: string; sortOrder: number }) {
  return { id: section.id, name: section.name, sort_order: section.sortOrder };
}

// Sprint 8 (RB-STOREF-002, PDR-012): "Store product sections are one
// level: fixed All, automatic New arrivals/Discounts, plus up to 20
// vendor-created sections... owner-only for create/rename/reorder/
// delete." Only CUSTOM sections are managed here - the three automatic
// ones are computed on read by StoreOffersPublicController and never
// appear as rows a vendor can CRUD.
//
// Owner-only throughout, per-method (not class-level) @RequireVendorRole
// ('OWNER') - VendorMembershipGuard reads it via Reflector.get(KEY,
// context.getHandler()), which never sees a class-level decorator (the
// same requirement already documented, and already gotten wrong once
// each, on VendorOffersController/SubscriptionsController/
// OffersImportController - see their own comments).
@Controller('vendors/:vendorId/sections')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StoreSectionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  @RequireVendorRole('OWNER')
  async list(@Param('vendorId') vendorId: string) {
    const sections = await this.prisma.storeSection.findMany({
      where: { vendorId },
      orderBy: { sortOrder: 'asc' },
      // offer_ids lets the owner dashboard render each section's
      // current membership without a separate round trip per section -
      // there is no public equivalent of this (StoreOffersPublicController's
      // own read is filtered to ACTIVE offers of an available store
      // only, unsuitable for an owner managing a draft/unpublished one).
      include: { offers: { select: { offerId: true } } },
    });
    return sections.map((s) => ({
      ...sectionDto(s),
      offer_ids: s.offers.map((o) => o.offerId),
    }));
  }

  @Post()
  @HttpCode(201)
  @RequireVendorRole('OWNER')
  async create(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStoreSectionDto,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // PDR-012's 20-custom-section cap must hold under concurrency -
      // two simultaneous create requests could otherwise both read
      // count=19 and both insert a 21st row. Advisory-locked per vendor
      // before the count check, the same established pattern already
      // used for staff invites/category re-parenting/cross-import
      // identifier records elsewhere in this codebase.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:store_sections:' || ${vendorId}))`;

      const count = await tx.storeSection.count({ where: { vendorId } });
      if (count >= MAX_CUSTOM_SECTIONS) {
        throw new ForbiddenException({
          code: 'STORE_SECTION_LIMIT_REACHED',
          message: `A store may have at most ${MAX_CUSTOM_SECTIONS} custom sections`,
        });
      }

      const section = await tx.storeSection.create({
        data: { vendorId, name: dto.name, sortOrder: count },
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
    if (!section || section.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'STORE_SECTION_NOT_FOUND',
        message: 'Store section not found',
      });
    }
    return section;
  }

  @Put(':sectionId')
  @RequireVendorRole('OWNER')
  async rename(
    @Param('vendorId') vendorId: string,
    @Param('sectionId') sectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameStoreSectionDto,
    @Req() req: Request,
  ) {
    const existing = await this.requireOwnSection(vendorId, sectionId);
    const updated = await this.prisma.storeSection.update({
      where: { id: sectionId },
      data: { name: dto.name },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_section.renamed',
      entityType: 'StoreSection',
      entityId: sectionId,
      beforeState: sectionDto(existing),
      afterState: sectionDto(updated),
    });
    return sectionDto(updated);
  }

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
      // BOLA/consistency: the provided list must be EXACTLY this
      // vendor's own custom-section id set, no more, no fewer, no
      // foreign ids smuggled in - never partially apply an untrusted
      // ordering.
      if (
        providedSet.size !== providedIds.length ||
        providedSet.size !== existingIds.size ||
        ![...providedSet].every((id) => existingIds.has(id))
      ) {
        throw new ForbiddenException({
          code: 'STORE_SECTION_REORDER_MISMATCH',
          message:
            "section_ids must contain exactly this store's own custom section ids, each exactly once",
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
      // PDR-012: "deletion removes only that grouping, not its
      // products" - explicit two-step delete (join rows, then the
      // section itself), never a DB cascade, so this stays as
      // deliberate/auditable as every other deletion-adjacent action in
      // this codebase. The VendorOffer rows themselves are never
      // touched.
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
    // BOLA: the offer being added must belong to THIS same vendor - a
    // section can never reference another vendor's offer.
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    // Idempotent: adding an offer already in this section is a no-op,
    // not an error - PDR-012's "a product can be in several sections"
    // never implies duplicate membership rows within the SAME section.
    await this.prisma.storeSectionOffer.upsert({
      where: { sectionId_offerId: { sectionId, offerId } },
      create: { vendorId, sectionId, offerId },
      update: {},
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_section.offer_added',
      entityType: 'StoreSection',
      entityId: sectionId,
      afterState: { offer_id: offerId },
    });
    return { section_id: sectionId, offer_id: offerId };
  }

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
