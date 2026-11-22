import {
  applyDecorators,
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const CONTENT_VIA_EDIT_DRAFT = 'contentViaEditDraft';

/**
 * Edit drafts: a published, classified product's CONTENT is changed by the
 * store only through its edit draft («تعديل المنتج»), so shoppers never see
 * a half-made change and nothing bypasses the review / conflict check. The
 * server refuses the direct content routes with 409 EDIT_VIA_DRAFT - not
 * just the interface. Not affected: a product never published (it keeps
 * editing directly), an unclassified product (its direct editing stays
 * until it is classified - it cannot have an edit draft), stock, status,
 * archiving, the quick price screen (PUT .../price, which raises the
 * product's content revision), and every admin or internal path (they do
 * not use these store routes).
 */
@Injectable()
export class ContentViaEditDraftGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const offerId = req.params.offerId;
    const vendorId = req.params.vendorId;
    if (typeof offerId !== 'string' || typeof vendorId !== 'string')
      return true;
    const offer = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, vendorId },
      select: { taxonomyVersion: true, firstPublishedAt: true },
    });
    // not found: the handler answers 404 as before
    if (!offer) return true;
    if (offer.taxonomyVersion !== null && offer.firstPublishedAt !== null) {
      throw new ConflictException({
        code: 'EDIT_VIA_DRAFT',
        message:
          "A published product's content is changed through its edit draft («تعديل المنتج»)",
        details: [{ offer_id: offerId }],
      });
    }
    return true;
  }
}

/** Marks a store route that changes a product's content (see ContentViaEditDraftGuard). */
export const ContentViaEditDraft = () =>
  applyDecorators(
    SetMetadata(CONTENT_VIA_EDIT_DRAFT, true),
    UseGuards(ContentViaEditDraftGuard),
  );
