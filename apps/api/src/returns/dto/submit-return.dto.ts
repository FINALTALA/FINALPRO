import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Sprint 21b: desired_outcome/replacement_* are only ever meaningful
// for an EXCHANGE outcome - the service itself is the real gate on
// whether a given order's snapshotted policy mode even permits that
// outcome (REFUND_ONLY/EXCHANGE_ONLY/BOTH), never this DTO alone; this
// DTO only enforces "if you say EXCHANGE, you must say which
// replacement and which branch."
export class SubmitReturnDto {
  @IsIn([
    'DAMAGED',
    'WRONG_ITEM',
    'COUNTERFEIT_CLAIM',
    'WARRANTY_CLAIM',
    'CHANGE_OF_MIND',
  ])
  reason!:
    | 'DAMAGED'
    | 'WRONG_ITEM'
    | 'COUNTERFEIT_CLAIM'
    | 'WARRANTY_CLAIM'
    | 'CHANGE_OF_MIND';

  @IsOptional()
  @TrimmedText(1, 1000)
  reason_note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => trimString({ value: v })) : value,
  )
  photo_urls?: string[];

  @IsOptional()
  @IsIn(['RETURN', 'EXCHANGE'])
  desired_outcome?: 'RETURN' | 'EXCHANGE';

  @ValidateIf((o) => o.desired_outcome === 'EXCHANGE')
  @IsString()
  replacement_offer_variant_id?: string;

  @ValidateIf((o) => o.desired_outcome === 'EXCHANGE')
  @IsString()
  replacement_branch_id?: string;
}
