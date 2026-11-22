import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Confirming a check: the products chosen, the duplicates chosen anyway, the same file again. */
export class ConfirmProductImportDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  refs!: string[];

  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  include_duplicates?: string[];

  @IsOptional()
  @IsBoolean()
  reimport_same_file?: boolean;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expected_sha256!: string;
}

/** A product's barcode typed / scanned on the check. */
export class ImportBarcodeDto {
  @IsString()
  @MaxLength(64)
  code!: string;
}

/** The chosen products a system barcode is generated for, on the check. */
export class ImportGenerateBarcodesDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  refs!: string[];
}
