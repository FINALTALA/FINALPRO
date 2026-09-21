import { ArrayUnique, IsEnum } from 'class-validator';
import { StoreApplicableCategory } from '../../../generated/prisma/client';

// Sprint 8 (RB-STOREF-004, PDR-013): "Stores choose one or more
// applicable types at registration and MAY EDIT THEM" - this is that
// edit path (registration itself requires >=1 non-empty set, see
// CreateVendorDto). A full replace, not a delta - the owner always
// submits the complete desired set. Deliberately still allows an empty
// array here (unlike registration) - StorefrontController.publish()'s
// own >=1 check is what actually blocks an empty set from ever going
// public, the same backstop role it already plays for vendors that
// predate the registration-time requirement.
export class UpdateApplicableCategoriesDto {
  @IsEnum(StoreApplicableCategory, { each: true })
  @ArrayUnique()
  categories!: StoreApplicableCategory[];
}
