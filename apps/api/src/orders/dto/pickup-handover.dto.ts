import { Matches } from 'class-validator';

// Sprint 10's own six-digit pickup code format (RB-ORD-004) - reused
// here for the actual handover verification this sprint completes.
export class PickupHandoverDto {
  @Matches(/^\d{6}$/, { message: 'pickup_code must be exactly six digits' })
  pickup_code!: string;
}
