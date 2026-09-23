import { SandboxPaymentService } from './sandbox-payment.service';

describe('SandboxPaymentService', () => {
  const service = new SandboxPaymentService();

  it('succeeds with no token (pre-Sprint-14 behaviour) and with the success token', async () => {
    expect((await service.charge(10)).success).toBe(true);
    expect((await service.charge(10, 'tok_sandbox_visa')).success).toBe(true);
  });

  it('declines with the documented decline tokens, reporting the decline code', async () => {
    const declined = await service.charge(10, 'tok_sandbox_declined');
    expect(declined).toMatchObject({
      success: false,
      declineCode: 'card_declined',
    });
    const funds = await service.charge(10, 'tok_sandbox_insufficient_funds');
    expect(funds).toMatchObject({
      success: false,
      declineCode: 'insufficient_funds',
    });
  });

  it('returns a unique reference per charge', async () => {
    const a = await service.charge(1);
    const b = await service.charge(1);
    expect(a.reference).not.toBe(b.reference);
  });
});
