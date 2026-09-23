import { IsIn, IsOptional, IsString } from 'class-validator';
import { SANDBOX_CARD_TOKENS } from '../sandbox-payment.service';

export class ConfirmCheckoutDto {
  @IsString()
  reservation_id!: string;

  // Sprint 14: the sandbox card token (see sandbox-payment.service.ts).
  // Only these documented test tokens are accepted - never a card
  // number. Optional: absent means the default sandbox success.
  @IsOptional()
  @IsIn(SANDBOX_CARD_TOKENS)
  sandbox_card_token?: (typeof SANDBOX_CARD_TOKENS)[number];
}
