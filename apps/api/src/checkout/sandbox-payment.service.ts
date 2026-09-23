import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Sprint 14: sandbox card tokens. The browser's sandbox card form maps
 * ONLY the documented test card numbers to one of these tokens and sends
 * the token - a card number, expiry or CVC never reaches this API, is
 * never stored, and is never logged. (Same idea as a real gateway's
 * test tokens.) Sending no token keeps the pre-Sprint-14 behaviour: the
 * sandbox charge succeeds.
 */
export const SANDBOX_CARD_TOKENS = [
  'tok_sandbox_visa',
  'tok_sandbox_declined',
  'tok_sandbox_insufficient_funds',
] as const;
export type SandboxCardToken = (typeof SANDBOX_CARD_TOKENS)[number];

export type SandboxDeclineCode = 'card_declined' | 'insufficient_funds';

export interface SandboxChargeResult {
  success: boolean;
  reference: string;
  declineCode?: SandboxDeclineCode;
}

/**
 * RB-ORD-003: "no real gateway, no payment secrets, no external
 * integration - a clear, tested sandbox/mock." This is the ENTIRE
 * boundary - no real payment provider exists anywhere in this
 * codebase, and none is meant to for this FYP's scope. Deliberately
 * its own injectable class (not inlined into CheckoutService) so a
 * unit test can substitute a failing mock without touching real
 * checkout logic, and so a future real integration has one obvious
 * seam to replace.
 */
@Injectable()
export class SandboxPaymentService {
  // Succeeds unless the (sandbox) card token asks for a decline - the
  // decline outcomes are the documented sandbox test tokens above, not
  // invented gateway behaviour.
  async charge(
    amount: number,
    cardToken?: SandboxCardToken,
  ): Promise<SandboxChargeResult> {
    void amount;
    const reference = `sandbox_${randomUUID()}`;
    if (cardToken === 'tok_sandbox_declined') {
      return { success: false, reference, declineCode: 'card_declined' };
    }
    if (cardToken === 'tok_sandbox_insufficient_funds') {
      return { success: false, reference, declineCode: 'insufficient_funds' };
    }
    return { success: true, reference };
  }
}
