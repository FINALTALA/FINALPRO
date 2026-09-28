import { IsOptional, IsString } from 'class-validator';

// Sprint 17 (FR-CAT-005): alt text only - url/kind/media_type are
// immutable after creation (replacing a PRIMARY image is done by
// adding a new PRIMARY, which atomically supersedes the old one, same
// as before this sprint).
export class UpdateOfferVariantMediaDto {
  @IsOptional()
  @IsString()
  alt_text_ar?: string;

  @IsOptional()
  @IsString()
  alt_text_en?: string;
}
