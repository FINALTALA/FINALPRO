import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { BOARD_FILTERS } from '../stock-board.service';

// «إدارة مخزون الفرع v1»: GET .../stock/board - validated here (400
// otherwise); anything else is dropped by the global whitelist pipe.
export class StockBoardQueryDto {
  /** a product name, a barcode or the internal SKU */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsIn(BOARD_FILTERS)
  filter?: (typeof BOARD_FILTERS)[number];

  @IsOptional()
  @Matches(/^\d{1,6}$/, { message: 'cursor must come from a previous page' })
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,2}$/, { message: 'limit must be a number from 1 to 50' })
  limit?: string;

  /** a line to show first (a link from a low-stock notice) */
  @IsOptional()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'variant must be an id' })
  variant?: string;
}

export class StockLedgerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,2}$/, { message: 'limit must be a number from 1 to 50' })
  limit?: string;
}
