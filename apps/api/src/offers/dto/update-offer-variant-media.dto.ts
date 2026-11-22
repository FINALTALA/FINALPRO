import { IsOptional, IsString, MaxLength } from 'class-validator';

// Sprint 17 (FR-CAT-005): alt text only - url/kind/media_type are
// immutable after creation (replacing a PRIMARY image is done by
// adding a new PRIMARY, which atomically supersedes the old one, same
// as before this sprint).
export class UpdateOfferVariantMediaDto {
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
