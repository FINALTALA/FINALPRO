import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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
}
