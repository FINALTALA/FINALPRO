import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

// Sprint 7 (RB-STOREF-001, PDR-011): partial update - every field
// optional, only the ones sent are changed. slug is never here (stable,
// immutable, set once at vendor creation - see slug.util.ts).
export class UpdateStorefrontDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsUrl(undefined, { message: 'logo_url must be a valid URL' })
  logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsUrl(undefined, { message: 'cover_image_url must be a valid URL' })
  cover_image_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  cover_color?: string;

  @IsOptional()
  @IsUrl(undefined, { message: 'instagram_url must be a valid URL' })
  instagram_url?: string;

  @IsOptional()
  @IsUrl(undefined, { message: 'facebook_url must be a valid URL' })
  facebook_url?: string;

  @IsOptional()
  @IsUrl(undefined, { message: 'whatsapp_url must be a valid URL' })
  whatsapp_url?: string;
}
