import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsEnum,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  StoreApplicableCategory,
  StoreType,
} from '../../../generated/prisma/client';
import { CreateBranchDto } from './create-branch.dto';

// FR-VEND-001 / BL-VEND-001: "application form + >=1 branch required
// to submit" - the ArrayMinSize(1) below is that acceptance criterion.
//
// Sprint 8 round 2 review fix (RB-STOREF-004, PDR-013): "the store is
// required to declare its type at registration, and may edit it
// later" - applicable_categories was originally deferred to storefront-
// publish time only (matching PDR-007's contact-method precedent), but
// the product owner confirmed PDR-013 is explicit that this one is
// required at REGISTRATION, not merely before going public. Required,
// non-empty, enum-only, no duplicates - the same shape
// UpdateApplicableCategoriesDto already validates for the owner-only
// later-edit endpoint (StorefrontController), which this does not
// replace.
// Sprint 15 review-round finding: store_type used to default silently
// to PHYSICAL (the schema column's own default) and could only be
// changed afterward via PUT :vendorId/store-type - a vendor applying
// with the clear intent to be ONLINE_ONLY was recorded as PHYSICAL
// until they remembered a separate call, contradicting PDR-010's
// model at the exact moment it matters most (registration). Required
// here, no default; VendorsController.apply() validates it against
// the submitted branches' is_physical values in the same transaction
// that creates them - see that method's own comment for the three
// invariants enforced (ONLINE_ONLY: zero physical branches;
// PHYSICAL/HYBRID: at least one).
export class CreateVendorDto {
  @IsString()
  legal_name!: string;

  @IsEnum(StoreType)
  store_type!: StoreType;

  @ValidateNested({ each: true })
  @Type(() => CreateBranchDto)
  @ArrayMinSize(1, { message: 'At least one branch is required to submit' })
  branches!: CreateBranchDto[];

  @IsEnum(StoreApplicableCategory, { each: true })
  @ArrayUnique()
  @ArrayMinSize(1, {
    message:
      'At least one applicable store category (Women/Men/Kids/Accessories) is required to register (PDR-013)',
  })
  applicable_categories!: StoreApplicableCategory[];
}
