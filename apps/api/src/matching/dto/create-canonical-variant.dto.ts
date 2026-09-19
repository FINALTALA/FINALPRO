import { IsObject, IsOptional, IsString } from 'class-validator';

// FR-MATCH-008, level 2: structural_attributes only for dimensions the
// manufacturer treats as a distinct model/MPN (storage/color/size).
// Free-shape JSON by design - Sprint 3 does not build
// AttributeDefinition/AttributeOption.
export class CreateCanonicalVariantDto {
  @IsObject()
  structural_attributes!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  mpn?: string;

  @IsOptional()
  @IsString()
  gtin?: string;
}
