import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateDeliveryZoneDto {
  @IsBoolean()
  enabled!: boolean;

  // Sprint 10 (RB-ORD-003): optional - omitting it (or the caller
  // never having set one yet) leaves the region unpriced, which
  // checkout treats as "not actually usable for delivery" regardless
  // of `enabled` (see VendorDeliveryZone's own schema.prisma comment).
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;
}
