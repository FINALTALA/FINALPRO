import { ArrayUnique, IsEnum } from 'class-validator';
import { StoreApplicableCategory } from '../../../generated/prisma/client';

// Sprint 8 (RB-STOREF-004, PDR-013): "Stores choose one or more
// applicable types... and may edit them." A full replace, not a delta -
// the owner always submits the complete desired set (may be empty; the
// non-empty requirement is enforced only at storefront publish time,
// see StorefrontController.publish()).
export class UpdateApplicableCategoriesDto {
  @IsEnum(StoreApplicableCategory, { each: true })
  @ArrayUnique()
  categories!: StoreApplicableCategory[];
}
