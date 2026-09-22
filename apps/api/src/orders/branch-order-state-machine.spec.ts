import { allowedNextStates, canTransition } from './branch-order-state-machine';

describe('branch-order-state-machine', () => {
  describe('the happy path for DELIVERY', () => {
    it('walks PLACED -> PREPARING -> SENT -> DELIVERED -> COMPLETED', () => {
      expect(canTransition('PLACED', 'PREPARING', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
      expect(canTransition('PREPARING', 'SENT', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
      expect(canTransition('SENT', 'DELIVERED', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
      expect(
        canTransition('DELIVERED', 'COMPLETED', 'DELIVERY', 'ONLINE'),
      ).toBe(true);
    });

    it('never allows PICKED_UP for a DELIVERY order', () => {
      expect(
        canTransition('PREPARING', 'PICKED_UP', 'DELIVERY', 'ONLINE'),
      ).toBe(false);
    });
  });

  describe('the happy path for PICKUP', () => {
    it('walks PLACED -> PREPARING -> PICKED_UP -> COMPLETED', () => {
      expect(canTransition('PLACED', 'PREPARING', 'PICKUP', 'COD')).toBe(true);
      expect(canTransition('PREPARING', 'PICKED_UP', 'PICKUP', 'COD')).toBe(
        true,
      );
      expect(canTransition('PICKED_UP', 'COMPLETED', 'PICKUP', 'COD')).toBe(
        true,
      );
    });

    it('never allows SENT or DELIVERED for a PICKUP order', () => {
      expect(canTransition('PREPARING', 'SENT', 'PICKUP', 'COD')).toBe(false);
      expect(canTransition('PREPARING', 'DELIVERED', 'PICKUP', 'COD')).toBe(
        false,
      );
    });
  });

  describe('PDR-028: cancellation windows', () => {
    it('allows cancelling from PLACED (before preparation), regardless of payment method', () => {
      expect(canTransition('PLACED', 'CANCELLED', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
      expect(canTransition('PLACED', 'CANCELLED', 'PICKUP', 'COD')).toBe(true);
    });

    it('allows cancelling from PREPARING (after prep, before Sent/pickup), regardless of payment method', () => {
      expect(
        canTransition('PREPARING', 'CANCELLED', 'DELIVERY', 'ONLINE'),
      ).toBe(true);
      expect(canTransition('PREPARING', 'CANCELLED', 'PICKUP', 'COD')).toBe(
        true,
      );
    });

    it('"once Sent, neither side self-cancels in-app" - CANCELLED is unreachable from SENT, DELIVERED, PICKED_UP, or COMPLETED', () => {
      expect(canTransition('SENT', 'CANCELLED', 'DELIVERY', 'ONLINE')).toBe(
        false,
      );
      expect(
        canTransition('DELIVERED', 'CANCELLED', 'DELIVERY', 'ONLINE'),
      ).toBe(false);
      expect(canTransition('PICKED_UP', 'CANCELLED', 'PICKUP', 'COD')).toBe(
        false,
      );
      expect(
        canTransition('COMPLETED', 'CANCELLED', 'DELIVERY', 'ONLINE'),
      ).toBe(false);
    });
  });

  describe('PDR-025: the refund path is ONLINE-only', () => {
    it('allows REFUNDED from PLACED and PREPARING for an ONLINE order (unprepared-at-slot)', () => {
      expect(canTransition('PLACED', 'REFUNDED', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
      expect(canTransition('PREPARING', 'REFUNDED', 'DELIVERY', 'ONLINE')).toBe(
        true,
      );
    });

    it('never allows REFUNDED for a COD order - nothing was charged online to refund, so undoing it is a plain CANCELLED', () => {
      expect(canTransition('PLACED', 'REFUNDED', 'DELIVERY', 'COD')).toBe(
        false,
      );
      expect(canTransition('PREPARING', 'REFUNDED', 'PICKUP', 'COD')).toBe(
        false,
      );
    });

    it('REFUNDED is unreachable once fulfilment has actually happened, even for an ONLINE order', () => {
      expect(canTransition('SENT', 'REFUNDED', 'DELIVERY', 'ONLINE')).toBe(
        false,
      );
      expect(canTransition('DELIVERED', 'REFUNDED', 'DELIVERY', 'ONLINE')).toBe(
        false,
      );
      expect(canTransition('PICKED_UP', 'REFUNDED', 'PICKUP', 'ONLINE')).toBe(
        false,
      );
    });
  });

  describe('terminal states', () => {
    it('COMPLETED, CANCELLED, and REFUNDED permit no further transitions at all', () => {
      expect(allowedNextStates('COMPLETED', 'DELIVERY', 'ONLINE')).toEqual([]);
      expect(allowedNextStates('CANCELLED', 'DELIVERY', 'ONLINE')).toEqual([]);
      expect(allowedNextStates('REFUNDED', 'DELIVERY', 'ONLINE')).toEqual([]);
      expect(allowedNextStates('COMPLETED', 'PICKUP', 'COD')).toEqual([]);
      expect(allowedNextStates('CANCELLED', 'PICKUP', 'COD')).toEqual([]);
      expect(allowedNextStates('REFUNDED', 'PICKUP', 'COD')).toEqual([]);
    });
  });

  describe('allowedNextStates is fulfilment-method-aware', () => {
    it('from PREPARING, DELIVERY only ever offers SENT (never PICKED_UP)', () => {
      expect(
        allowedNextStates('PREPARING', 'DELIVERY', 'ONLINE').sort(),
      ).toEqual(['CANCELLED', 'REFUNDED', 'SENT'].sort());
    });

    it('from PREPARING, PICKUP only ever offers PICKED_UP (never SENT)', () => {
      expect(allowedNextStates('PREPARING', 'PICKUP', 'ONLINE').sort()).toEqual(
        ['CANCELLED', 'PICKED_UP', 'REFUNDED'].sort(),
      );
    });
  });

  describe('allowedNextStates is payment-method-aware', () => {
    it('from PREPARING, a COD order never offers REFUNDED (only CANCELLED and the fulfilment step)', () => {
      expect(allowedNextStates('PREPARING', 'DELIVERY', 'COD').sort()).toEqual(
        ['CANCELLED', 'SENT'].sort(),
      );
      expect(allowedNextStates('PREPARING', 'PICKUP', 'COD').sort()).toEqual(
        ['CANCELLED', 'PICKED_UP'].sort(),
      );
    });

    it('from PLACED, an ONLINE order offers both CANCELLED and REFUNDED; a COD order offers only CANCELLED', () => {
      expect(allowedNextStates('PLACED', 'DELIVERY', 'ONLINE').sort()).toEqual(
        ['CANCELLED', 'PREPARING', 'REFUNDED'].sort(),
      );
      expect(allowedNextStates('PLACED', 'DELIVERY', 'COD').sort()).toEqual(
        ['CANCELLED', 'PREPARING'].sort(),
      );
    });
  });

  it('never allows a transition to the same state (no-op self-loop)', () => {
    expect(canTransition('PLACED', 'PLACED', 'DELIVERY', 'ONLINE')).toBe(false);
    expect(canTransition('PREPARING', 'PREPARING', 'PICKUP', 'COD')).toBe(
      false,
    );
  });

  it('never allows skipping a state (e.g. PLACED straight to DELIVERED)', () => {
    expect(canTransition('PLACED', 'DELIVERED', 'DELIVERY', 'ONLINE')).toBe(
      false,
    );
    expect(canTransition('PLACED', 'SENT', 'DELIVERY', 'ONLINE')).toBe(false);
    expect(canTransition('PLACED', 'COMPLETED', 'DELIVERY', 'ONLINE')).toBe(
      false,
    );
  });
});
