import { ArrayMinSize, ArrayUnique, IsEnum } from 'class-validator';
import { StoreApplicableCategory } from '../../../generated/prisma/client';

// Sprint 8 round 3 review fix (RB-STOREF-004, PDR-013): "Stores choose
// one or more applicable types at registration and MAY EDIT THEM" - a
// store is ALWAYS required to hold at least one, registration onward;
// editing may change WHICH categories apply, never clear the set to
// none. Round 2 left this endpoint accepting an empty array (relying on
// StorefrontController.publish()'s own >=1 check as the only backstop),
// which let an owner of an ALREADY-PUBLISHED store clear every category
// and stay published with none - publish() only checks at the moment of
// publishing, not continuously. @ArrayMinSize(1) here closes that: this
// is a full replace, not a delta, so the owner always submits the
// complete desired non-empty set.
export class UpdateApplicableCategoriesDto {
  @IsEnum(StoreApplicableCategory, { each: true })
  @ArrayUnique()
  @ArrayMinSize(1, {
    message:
      'At least one applicable store category (Women/Men/Kids/Accessories) must remain set (PDR-013)',
  })
  categories!: StoreApplicableCategory[];
}
