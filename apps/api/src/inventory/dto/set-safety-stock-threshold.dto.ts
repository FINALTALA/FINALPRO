import { IsInt, Min } from 'class-validator';

// Sprint 18a (FR-INV-007, product decision): 0 means "no alert" - see
// BranchStock.safetyStockThreshold's own schema.prisma comment. Owner
// policy, not an operational action - @RequireVendorRole('OWNER') on
// the controller method, not here.
export class SetSafetyStockThresholdDto {
  @IsInt()
  @Min(0)
  threshold!: number;
}
