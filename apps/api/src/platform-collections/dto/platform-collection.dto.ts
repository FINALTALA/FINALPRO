import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ProductAudience } from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';
import { MAX_COLLECTION_ITEMS } from '../platform-collections.service';

const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const AUDIENCES = Object.values(ProductAudience);

export class CreatePlatformCollectionDto {
  @Matches(SLUG, { message: 'slug: lowercase letters, digits and dashes' })
  slug!: string;

  @TrimmedText(1, 80)
  title_ar!: string;

  @TrimmedText(1, 80)
  title_en!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description_ar?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description_en?: string | null;

  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: ProductAudience | null;

  @IsOptional()
  @IsBoolean()
  show_on_home?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publish_from?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publish_until?: Date | null;
}

/** Every field optional; `null` clears an optional one. */
export class UpdatePlatformCollectionDto {
  @IsOptional()
  @Matches(SLUG, { message: 'slug: lowercase letters, digits and dashes' })
  slug?: string;

  @IsOptional()
  @TrimmedText(1, 80)
  title_ar?: string;

  @IsOptional()
  @TrimmedText(1, 80)
  title_en?: string;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description_ar?: string | null;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description_en?: string | null;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: ProductAudience | null;

  @IsOptional()
  @IsBoolean()
  show_on_home?: boolean;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publish_from?: Date | null;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publish_until?: Date | null;
}

export class SetCollectionItemsDto {
  /** The complete, ordered list (an empty list removes every item). */
  @IsArray()
  @ArrayMaxSize(MAX_COLLECTION_ITEMS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  canonical_product_ids!: string[];
}

export class OrderCollectionsDto {
  /** Every collection id, in the wanted display order. */
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  collection_ids!: string[];
}
