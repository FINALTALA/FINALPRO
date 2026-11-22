import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
} from 'class-validator';
import { ProductAudience } from '../../../generated/prisma/client';

export class UpdateStorefrontCatalogueDto {
  /** The main departments the store offers (full replacement). */
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(3)
  @IsIn(['WOMEN', 'MEN', 'KIDS'], { each: true })
  departments!: ProductAudience[];

  /**
   * { WOMEN: ['DRESSES_WOMEN', ...], MEN: [...] } - the detailed category
   * codes per department, in display order. Its contents (codes, the
   * category-audience fit) are checked by the controller.
   */
  @IsOptional()
  @IsObject()
  categories?: Record<string, string[]>;
}
