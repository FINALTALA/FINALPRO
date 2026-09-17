import { IsLatitude, IsLongitude, IsString } from 'class-validator';

// FR-VEND-002: a mandatory pin + storefront photo, required before
// approval (not at BL-VEND-001's initial application submission, where
// both are optional). Also usable to *resubmit* after a REJECTED or
// RESUBMISSION_REQUESTED decision - see the controller.
export class SubmitBranchEvidenceDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsString()
  verification_photo_url!: string;
}
