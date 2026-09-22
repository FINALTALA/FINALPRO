import { allowedNextStates, canTransition } from './branch-order-state-machine';

describe('branch-order-state-machine', () => {
  describe('the happy path for DELIVERY', () => {
    it('walks PLACED -> PREPARING -> SENT -> DELIVERED -> COMPLETED', () => {
      expect(canTransition('PLACED', 'PREPARING', 'DELIVERY')).toBe(true);
      expect(canTransition('PREPARING', 'SENT', 'DELIVERY')).toBe(true);
      expect(canTransition('SENT', 'DELIVERED', 'DELIVERY')).toBe(true);
      expect(canTransition('DELIVERED', 'COMPLETED', 'DELIVERY')).toBe(true);
    });

    it('never allows PICKED_UP for a DELIVERY order', () => {
      expect(canTransition('PREPARING', 'PICKED_UP', 'DELIVERY')).toBe(false);
    });
  });

  describe('the happy path for PICKUP', () => {
    it('walks PLACED -> PREPARING -> PICKED_UP -> COMPLETED', () => {
      expect(canTransition('PLACED', 'PREPARING', 'PICKUP')).toBe(true);
      expect(canTransition('PREPARING', 'PICKED_UP', 'PICKUP')).toBe(true);
      expect(canTransition('PICKED_UP', 'COMPLETED', 'PICKUP')).toBe(true);
    });

    it('never allows SENT or DELIVERED for a PICKUP order', () => {
      expect(canTransition('PREPARING', 'SENT', 'PICKUP')).toBe(false);
      expect(canTransition('PREPARING', 'DELIVERED', 'PICKUP')).toBe(false);
    });
  });

  describe('PDR-028: cancellation windows', () => {
    it('allows cancelling from PLACED (before preparation)', () => {
      expect(canTransition('PLACED', 'CANCELLED', 'DELIVERY')).toBe(true);
      expect(canTransition('PLACED', 'CANCELLED', 'PICKUP')).toBe(true);
    });

    it('allows cancelling from PREPARING (after prep, before Sent/pickup)', () => {
      expect(canTransition('PREPARING', 'CANCELLED', 'DELIVERY')).toBe(true);
      expect(canTransition('PREPARING', 'CANCELLED', 'PICKUP')).toBe(true);
    });

    it('"once Sent, neither side self-cancels in-app" - CANCELLED is unreachable from SENT, DELIVERED, PICKED_UP, or COMPLETED', () => {
      expect(canTransition('SENT', 'CANCELLED', 'DELIVERY')).toBe(false);
      expect(canTransition('DELIVERED', 'CANCELLED', 'DELIVERY')).toBe(false);
      expect(canTransition('PICKED_UP', 'CANCELLED', 'PICKUP')).toBe(false);
      expect(canTransition('COMPLETED', 'CANCELLED', 'DELIVERY')).toBe(false);
    });
  });

  describe('PDR-025: the refund path', () => {
    it('allows REFUNDED from PLACED and PREPARING (unprepared-at-slot)', () => {
      expect(canTransition('PLACED', 'REFUNDED', 'DELIVERY')).toBe(true);
      expect(canTransition('PREPARING', 'REFUNDED', 'DELIVERY')).toBe(true);
    });

    it('REFUNDED is unreachable once fulfilment has actually happened', () => {
      expect(canTransition('SENT', 'REFUNDED', 'DELIVERY')).toBe(false);
      expect(canTransition('DELIVERED', 'REFUNDED', 'DELIVERY')).toBe(false);
      expect(canTransition('PICKED_UP', 'REFUNDED', 'PICKUP')).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('COMPLETED, CANCELLED, and REFUNDED permit no further transitions at all', () => {
      expect(allowedNextStates('COMPLETED', 'DELIVERY')).toEqual([]);
      expect(allowedNextStates('CANCELLED', 'DELIVERY')).toEqual([]);
      expect(allowedNextStates('REFUNDED', 'DELIVERY')).toEqual([]);
      expect(allowedNextStates('COMPLETED', 'PICKUP')).toEqual([]);
      expect(allowedNextStates('CANCELLED', 'PICKUP')).toEqual([]);
      expect(allowedNextStates('REFUNDED', 'PICKUP')).toEqual([]);
    });
  });

  describe('allowedNextStates is fulfilment-method-aware', () => {
    it('from PREPARING, DELIVERY only ever offers SENT (never PICKED_UP)', () => {
      expect(allowedNextStates('PREPARING', 'DELIVERY').sort()).toEqual(
        ['CANCELLED', 'REFUNDED', 'SENT'].sort(),
      );
    });

    it('from PREPARING, PICKUP only ever offers PICKED_UP (never SENT)', () => {
      expect(allowedNextStates('PREPARING', 'PICKUP').sort()).toEqual(
        ['CANCELLED', 'PICKED_UP', 'REFUNDED'].sort(),
      );
    });
  });

  it('never allows a transition to the same state (no-op self-loop)', () => {
    expect(canTransition('PLACED', 'PLACED', 'DELIVERY')).toBe(false);
    expect(canTransition('PREPARING', 'PREPARING', 'PICKUP')).toBe(false);
  });

  it('never allows skipping a state (e.g. PLACED straight to DELIVERED)', () => {
    expect(canTransition('PLACED', 'DELIVERED', 'DELIVERY')).toBe(false);
    expect(canTransition('PLACED', 'SENT', 'DELIVERY')).toBe(false);
    expect(canTransition('PLACED', 'COMPLETED', 'DELIVERY')).toBe(false);
  });
});
