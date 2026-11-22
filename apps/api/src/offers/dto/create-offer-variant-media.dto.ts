import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MediaKind, MediaType } from '../../../generated/prisma/client';
import { IsUrlOrOwnUpload } from '../../uploads/uploads.util';

// Sprint 6 (RB-MATCH-001); Sprint 17 (D9) makes media_type mandatory -
// there is no way to infer image vs video from a bare URL. No upload
// pipeline exists in this codebase - url is a plain, already-hosted
// URL, the same minimal pattern StoreBranch.verificationPhotoUrl
// already uses. A video's max 60-second duration cannot be verified
// from an external URL (no media-inspection capability) and is never
// checked or claimed.
export class CreateOfferVariantMediaDto {
  // Sprint 26: or a URL returned by POST /vendors/:id/uploads (same
  // vendor only - checked in addVariantMedia).
  @IsUrlOrOwnUpload('url must be a valid URL')
  url!: string;

  @IsOptional()
  @IsIn(['PRIMARY', 'ADDITIONAL'])
  kind?: MediaKind;

  // Sprint 17 (D9): PRIMARY may only ever be IMAGE - checked here
  // (before the DB is even touched) and again by the CHECK constraint
  // (offer_variant_media_primary_image_only_check).
  @IsIn(['IMAGE', 'VIDEO'])
  media_type!: MediaType;

  @IsOptional()
  @IsString()
  // PD-1: alt text is read aloud / shown as the image caption.
  @MaxLength(250, { message: 'alt_text_ar must be at most 250 characters' })
  alt_text_ar?: string;

  @IsOptional()
  @IsString()
  // PD-1: alt text is read aloud / shown as the image caption.
  @MaxLength(250, { message: 'alt_text_en must be at most 250 characters' })
  alt_text_en?: string;
}
