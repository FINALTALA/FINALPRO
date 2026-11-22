import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { MAX_OFFER_PAIRINGS } from '../offer-pairings.service';

export class SetOfferPairingsDto {
  /** The complete, ordered list (an empty list removes every pairing). */
  @IsArray()
  @ArrayMaxSize(MAX_OFFER_PAIRINGS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  paired_offer_ids!: string[];
}
