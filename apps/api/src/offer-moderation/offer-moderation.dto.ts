import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** VIA phase 2C: an administrator places a platform hold on an offer. */
export class PlaceOfferHoldDto {
  @IsIn(['HIDE', 'REQUEST_CHANGES'])
  action!: 'HIDE' | 'REQUEST_CHANGES';

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

/** An administrator sends a submitted correction back to the store. */
export class ReturnCorrectionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

/** RESTORE: closes the hold; `offer_revision` is the version reviewed. */
export class RestoreOfferDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;

  @IsInt()
  @Min(1)
  offer_revision!: number;
}

/** The store submits one exact content revision as its correction. */
export class SubmitCorrectionDto {
  @IsInt()
  @Min(1)
  offer_revision!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
