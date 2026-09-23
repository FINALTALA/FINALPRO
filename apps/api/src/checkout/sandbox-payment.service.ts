import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

export interface SandboxChargeResult {
  success: boolean;
  reference: string;
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
  // Always succeeds by design - there is no real failure mode to
  // simulate honestly without inventing arbitrary behaviour a real
  // gateway never specified. The interface still returns a
  // success/failure shape (rather than always resolving) so
  // CheckoutService's own "payment failed -> roll back everything"
  // path is real, reachable code, exercised in tests via a mocked
  // SandboxPaymentService that returns success: false.
  async charge(amount: number): Promise<SandboxChargeResult> {
    void amount;
    return { success: true, reference: `sandbox_${randomUUID()}` };
  }
}
