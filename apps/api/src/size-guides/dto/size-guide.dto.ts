import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ProductAudience,
  SizeGuideKind,
  SizeMeasureBasis,
  SizeMeasureKey,
} from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';
import { MAX_GUIDE_ROWS, MEASURE_KEYS } from '../size-guide-rules';

// PD-4: request bodies. Shapes and simple types are checked here; every
// measurement value, range, size group and ordering rule is checked by
// size-guide-rules.ts (one place, unit-tested).

export class CreateSizeGuideDto {
  @Matches(/^[a-z0-9][a-z0-9-]{1,59}$/, {
    message: 'code: lowercase letters, digits and dashes',
  })
  code!: string;

  @TrimmedText(1, 120)
  name_ar!: string;

  @TrimmedText(1, 120)
  name_en!: string;

  @IsIn(Object.values(SizeGuideKind))
  kind!: SizeGuideKind;

  @IsOptional()
  @IsUUID()
  canonical_product_id?: string | null;

  @IsOptional()
  @IsIn(Object.values(SizeMeasureBasis))
  basis?: SizeMeasureBasis;
}

export class RenameSizeGuideDto {
  @TrimmedText(1, 120)
  name_ar!: string;

  @TrimmedText(1, 120)
  name_en!: string;
}

class MeasurementDto {
  @IsIn(MEASURE_KEYS)
  key!: SizeMeasureKey;

  @IsBoolean()
  is_range!: boolean;
}

class RowDto {
  @Matches(/^[A-Z0-9_]{1,40}$/)
  size_code!: string;

  /** { CHEST: { min: 88, max: 92 }, ... } in cm. */
  @IsObject()
  values!: Record<string, { min: number; max?: number | null }>;
}

export class SaveDraftDto {
  @IsIn(Object.values(SizeMeasureBasis))
  basis!: SizeMeasureBasis;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes_ar?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes_en?: string | null;

  @IsArray()
  @ArrayMaxSize(MEASURE_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => MeasurementDto)
  measurements!: MeasurementDto[];

  @IsArray()
  @ArrayMaxSize(MAX_GUIDE_ROWS)
  @ValidateNested({ each: true })
  @Type(() => RowDto)
  rows!: RowDto[];
}

class ApplicabilityPairDto {
  @Matches(/^[A-Z0-9_]{1,60}$/)
  category_code!: string;

  @IsIn(Object.values(ProductAudience))
  audience!: ProductAudience;

  @IsBoolean()
  is_default!: boolean;
}

export class SetApplicabilityDto {
  @IsArray()
  @ArrayMaxSize(120)
  @ValidateNested({ each: true })
  @Type(() => ApplicabilityPairDto)
  pairs!: ApplicabilityPairDto[];
}

export class DecideSizeGuideRequestDto {
  @IsIn(['RESOLVED', 'REJECTED'])
  decision!: 'RESOLVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsOptional()
  @IsUUID()
  guide_id?: string | null;
}

export class ChooseSizeGuideDto {
  /** null = back to the default guide. */
  @IsOptional()
  @IsUUID()
  size_guide_id?: string | null;
}

export class RequestSizeGuideDto {
  @TrimmedText(1, 1000)
  message!: string;
}

/** Phase A+: an offer's own measurements; null (or nothing entered) removes the table. */
export class OfferMeasurementsDto {
  @IsOptional()
  @IsObject()
  measurements?: Record<string, unknown> | null;
}
