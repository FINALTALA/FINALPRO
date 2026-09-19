import { IsIn, IsOptional, IsUrl } from 'class-validator';
import { MediaKind } from '../../../generated/prisma/client';

// Sprint 6 (RB-MATCH-001): a primary image plus additional images -
// full media breadth (10 images/3 videos/reorder) is RB-MATCH-001b,
// Should, not built this sprint. No upload pipeline exists in this
// codebase - url is a plain, already-hosted URL, the same minimal
// pattern StoreBranch.verificationPhotoUrl already uses.
export class CreateOfferVariantMediaDto {
  @IsUrl(undefined, { message: 'url must be a valid URL' })
  url!: string;

  @IsOptional()
  @IsIn(['PRIMARY', 'ADDITIONAL'])
  kind?: MediaKind;
}
