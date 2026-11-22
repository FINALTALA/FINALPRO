import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Bulk add / remove: the products, in the order to add them (they go last). */
export class CollectionOffersDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  offer_ids!: string[];
}

/** Moves one product to a 0-based position inside the collection. */
export class MoveCollectionOfferDto {
  @IsString()
  offer_id!: string;

  @IsInt()
  @Min(0)
  @Max(499)
  position!: number;
}

/** A product's own «المجموعات»: exactly the collections it should be in. */
export class OfferCollectionsDto {
  @IsString({ each: true })
  @ArrayMaxSize(20)
  section_ids!: string[];
}
