import {
  allowedNextStates,
  canTransition,
  isTerminalBranchOrderStatus,
} from './branch-order-state-machine';

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

  // Sprint 20a (PDR-027): delivery-failure attempt-count boundaries.
  describe('PDR-027: delivery failure and the deliveryAttemptCount axis', () => {
    it('attempt 1 (count=0): SENT->DELIVERY_FAILED is legal for ONLINE and COD alike', () => {
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'DELIVERY', 'ONLINE', 0),
      ).toBe(true);
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'DELIVERY', 'COD', 0),
      ).toBe(true);
    });

    it('attempt 1 failure does NOT allow SENT->CANCELLED directly for COD (that only opens at count>=1)', () => {
      expect(canTransition('SENT', 'CANCELLED', 'DELIVERY', 'COD', 0)).toBe(
        false,
      );
    });

    it('reschedule DELIVERY_FAILED(count=1)->SENT is legal for both payment methods', () => {
      expect(
        canTransition('DELIVERY_FAILED', 'SENT', 'DELIVERY', 'ONLINE', 1),
      ).toBe(true);
      expect(
        canTransition('DELIVERY_FAILED', 'SENT', 'DELIVERY', 'COD', 1),
      ).toBe(true);
    });

    it('exact boundary: 0 -> 1 (SENT->DELIVERY_FAILED) -> SENT (reschedule, count still 1) -> 2 (second failure)', () => {
      // Starting count 0, first failure is legal.
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'DELIVERY', 'ONLINE', 0),
      ).toBe(true);
      // Now at DELIVERY_FAILED with count=1 (incremented by the
      // transition above) - reschedule back to SENT is legal.
      expect(
        canTransition('DELIVERY_FAILED', 'SENT', 'DELIVERY', 'ONLINE', 1),
      ).toBe(true);
      // Back at SENT, count is STILL 1 (rescheduling never resets or
      // further increments it) - the second failure is now legal and
      // must land on DELIVERY_FAILED again for ONLINE.
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'DELIVERY', 'ONLINE', 1),
      ).toBe(true);
      // ...but for COD, that same second failure (count=1) must skip
      // DELIVERY_FAILED and go straight to CANCELLED instead.
      expect(canTransition('SENT', 'CANCELLED', 'DELIVERY', 'COD', 1)).toBe(
        true,
      );
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'DELIVERY', 'COD', 1),
      ).toBe(false);
    });

    it('once count reaches 2, DELIVERY_FAILED can no longer reschedule back to SENT for either payment method', () => {
      expect(
        canTransition('DELIVERY_FAILED', 'SENT', 'DELIVERY', 'ONLINE', 2),
      ).toBe(false);
      expect(
        canTransition('DELIVERY_FAILED', 'SENT', 'DELIVERY', 'COD', 2),
      ).toBe(false);
    });

    it('COD never rests at DELIVERY_FAILED(count>=2) - it is cancelled directly by the SENT->CANCELLED transition, so DELIVERY_FAILED has no COD exit left at count=2', () => {
      expect(
        canTransition('DELIVERY_FAILED', 'CANCELLED', 'DELIVERY', 'COD', 2),
      ).toBe(false);
    });

    it('ONLINE at DELIVERY_FAILED(count=1) can auto-refund or auto-cancel-equivalent via the 48h sweep path (REFUNDED only, never CANCELLED for ONLINE)', () => {
      expect(
        canTransition('DELIVERY_FAILED', 'REFUNDED', 'DELIVERY', 'ONLINE', 1),
      ).toBe(true);
      expect(
        canTransition('DELIVERY_FAILED', 'CANCELLED', 'DELIVERY', 'ONLINE', 1),
      ).toBe(false);
    });

    it('COD at DELIVERY_FAILED(count=1) can only auto-cancel via the 48h sweep path (CANCELLED only, never REFUNDED - nothing was charged)', () => {
      expect(
        canTransition('DELIVERY_FAILED', 'CANCELLED', 'DELIVERY', 'COD', 1),
      ).toBe(true);
      expect(
        canTransition('DELIVERY_FAILED', 'REFUNDED', 'DELIVERY', 'COD', 1),
      ).toBe(false);
    });

    it('REFUND_REQUESTED only opens from DELIVERY_FAILED at count>=2, ONLINE only', () => {
      expect(
        canTransition(
          'DELIVERY_FAILED',
          'REFUND_REQUESTED',
          'DELIVERY',
          'ONLINE',
          2,
        ),
      ).toBe(true);
      expect(
        canTransition(
          'DELIVERY_FAILED',
          'REFUND_REQUESTED',
          'DELIVERY',
          'ONLINE',
          1,
        ),
      ).toBe(false);
      expect(
        canTransition(
          'DELIVERY_FAILED',
          'REFUND_REQUESTED',
          'DELIVERY',
          'COD',
          2,
        ),
      ).toBe(false);
    });

    it('REFUND_REQUESTED->REFUNDED is the only legal exit, and only staff/owner approval reaches it (never automatic)', () => {
      expect(
        canTransition('REFUND_REQUESTED', 'REFUNDED', 'DELIVERY', 'ONLINE', 2),
      ).toBe(true);
      expect(allowedNextStates('REFUND_REQUESTED', 'DELIVERY', 'ONLINE', 2)).toEqual(
        ['REFUNDED'],
      );
    });

    it('PICKUP never reaches DELIVERY_FAILED/REFUND_REQUESTED at all (delivery-failure is a DELIVERY-only concept)', () => {
      expect(
        canTransition('SENT', 'DELIVERY_FAILED', 'PICKUP', 'ONLINE', 0),
      ).toBe(false);
      expect(
        allowedNextStates('DELIVERY_FAILED', 'PICKUP', 'ONLINE', 1),
      ).toEqual([]);
    });

    it('DELIVERY_FAILED and REFUND_REQUESTED are correctly NON-terminal', () => {
      expect(isTerminalBranchOrderStatus('DELIVERY_FAILED')).toBe(false);
      expect(isTerminalBranchOrderStatus('REFUND_REQUESTED')).toBe(false);
    });

    it('every other target is illegal from DELIVERY_FAILED at count=1 (exhaustive, not representative) - SENT is the one legal exit, tested separately above', () => {
      const illegal: Array<Parameters<typeof canTransition>[1]> = [
        'PLACED',
        'PREPARING',
        'PICKED_UP',
        'DELIVERED',
        'COMPLETED',
        'REFUND_REQUESTED',
      ];
      for (const to of illegal) {
        expect(canTransition('DELIVERY_FAILED', to, 'DELIVERY', 'ONLINE', 1)).toBe(
          false,
        );
      }
    });

    it('every other target is illegal from DELIVERY_FAILED at count=2 (exhaustive, not representative)', () => {
      const illegal: Array<Parameters<typeof canTransition>[1]> = [
        'PLACED',
        'PREPARING',
        'SENT',
        'PICKED_UP',
        'DELIVERED',
        'COMPLETED',
        'CANCELLED',
      ];
      for (const to of illegal) {
        expect(canTransition('DELIVERY_FAILED', to, 'DELIVERY', 'ONLINE', 2)).toBe(
          false,
        );
      }
    });

    it('every other target is illegal from REFUND_REQUESTED (exhaustive, not representative)', () => {
      const illegal: Array<Parameters<typeof canTransition>[1]> = [
        'PLACED',
        'PREPARING',
        'SENT',
        'PICKED_UP',
        'DELIVERED',
        'COMPLETED',
        'CANCELLED',
        'DELIVERY_FAILED',
      ];
      for (const to of illegal) {
        expect(
          canTransition('REFUND_REQUESTED', to, 'DELIVERY', 'ONLINE', 2),
        ).toBe(false);
      }
    });
  });
});
