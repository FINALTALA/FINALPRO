import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BrandRequest, Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A brand a seller typed that is not in the platform's list: never a
 * public Brand until an administrator decides. It is attached to the
 * seller's draft (and to the product created from it); the product keeps
 * NO brand - never the "no brand" choice - and cannot be published until
 * the request is approved. Approving creates the Brand (or points at an
 * existing one); the draft then uses it, and a product created meanwhile
 * gets it (unless its identity is locked by a confirmed match, or the
 * seller already chose another brand). Rejecting records why; the seller
 * chooses again.
 */
@Injectable()
export class BrandRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private dto(
    r: BrandRequest & {
      offer?: { id: string; titleAr: string } | null;
      brand?: { id: string; name: string } | null;
    },
  ) {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      draft_id: r.draftId,
      offer: r.offer ? { id: r.offer.id, title_ar: r.offer.titleAr } : null,
      brand: r.brand ? { id: r.brand.id, name: r.brand.name } : null,
      rejection_reason: r.rejectionReason,
      created_at: r.createdAt.toISOString(),
      decided_at: r.decidedAt?.toISOString() ?? null,
    };
  }

  async listForVendor(vendorId: string) {
    const rows = await this.prisma.brandRequest.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        offer: { select: { id: true, titleAr: true } },
        brand: { select: { id: true, name: true } },
      },
    });
    return { items: rows.map((r) => this.dto(r)) };
  }

  async listForAdmin(status?: string) {
    const where: Prisma.BrandRequestWhereInput =
      status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED'
        ? { status }
        : {};
    const rows = await this.prisma.brandRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        offer: { select: { id: true, titleAr: true } },
        brand: { select: { id: true, name: true } },
        vendor: { select: { id: true, displayName: true, legalName: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        ...this.dto(r),
        vendor: {
          id: r.vendor.id,
          name: r.vendor.displayName ?? r.vendor.legalName,
        },
      })),
    };
  }

  async decide(
    requestId: string,
    adminId: string,
    correlationId: string,
    dto: { decision: 'approve' | 'reject'; brand_id?: string; reason?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM brand_requests WHERE id = ${requestId} FOR UPDATE`;
      const r = await tx.brandRequest.findUnique({ where: { id: requestId } });
      if (!r)
        throw new NotFoundException({
          code: 'BRAND_REQUEST_NOT_FOUND',
          message: 'Brand request not found',
        });
      if (r.status !== 'PENDING') {
        throw new ConflictException({
          code: 'BRAND_REQUEST_ALREADY_DECIDED',
          message: 'This request was already decided',
        });
      }
      const now = new Date();
      if (dto.decision === 'reject') {
        const reason = (dto.reason ?? '').trim();
        if (reason.length < 3) {
          throw new BadRequestException({
            code: 'REJECTION_REASON_REQUIRED',
            message: 'Say why the brand is rejected',
          });
        }
        const done = await tx.brandRequest.update({
          where: { id: requestId },
          data: {
            status: 'REJECTED',
            decidedAt: now,
            decidedByUserId: adminId,
            rejectionReason: reason,
          },
        });
        await this.auditLog.record(
          {
            actorId: adminId,
            correlationId,
            action: 'brand_request.rejected',
            entityType: 'BrandRequest',
            entityId: requestId,
            afterState: { reason },
          },
          tx,
        );
        return { ...this.dto(done), offer_updated: false };
      }

      let brandId: string;
      if (dto.brand_id) {
        const b = await tx.brand.findUnique({ where: { id: dto.brand_id } });
        if (!b || b.isNoBrandSentinel) {
          throw new BadRequestException({
            code: 'BRAND_NOT_FOUND',
            message: 'Choose an existing brand',
          });
        }
        brandId = b.id;
      } else {
        const existing = await tx.brand.findFirst({
          where: {
            normalizedName: {
              in: [r.normalizedName, r.name.trim().toLowerCase()],
            },
          },
        });
        brandId = existing
          ? existing.id
          : (
              await tx.brand.create({
                data: { name: r.name, normalizedName: r.normalizedName },
              })
            ).id;
      }
      const done = await tx.brandRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          decidedAt: now,
          decidedByUserId: adminId,
          brandId,
        },
      });

      // The product created while this brand was under review has no
      // brand yet (and cannot be published): it gets the approved one. A
      // product whose seller has since chosen a brand is left as it is.
      let offerUpdated = false;
      if (r.offerId) {
        await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${r.offerId} FOR UPDATE`;
        const offer = await tx.vendorOffer.findUnique({
          where: { id: r.offerId },
          select: { brandId: true, canonicalProductId: true },
        });
        if (offer && offer.brandId === null && !offer.canonicalProductId) {
          await tx.vendorOffer.update({
            where: { id: r.offerId },
            data: { brandId },
          });
          offerUpdated = true;
        }
      }
      await this.auditLog.record(
        {
          actorId: adminId,
          correlationId,
          action: 'brand_request.approved',
          entityType: 'BrandRequest',
          entityId: requestId,
          afterState: {
            brand_id: brandId,
            offer_id: r.offerId,
            offer_updated: offerUpdated,
          },
        },
        tx,
      );
      return { ...this.dto(done), offer_updated: offerUpdated };
    });
  }
}
