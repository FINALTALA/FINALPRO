import Decimal from 'decimal.js';
import {
  buildReturnPolicySnapshot,
  checkReturnEligibility,
  computeReturnRefundAmount,
} from './return-policy.util';

describe('return-policy.util', () => {
  describe('buildReturnPolicySnapshot', () => {
    it('copies the vendor policy fields verbatim, converting the fee to Decimal', () => {
      const snap = buildReturnPolicySnapshot({
        returnsEnabled: true,
        returnMode: 'REFUND_ONLY',
        returnWindowDays: 14,
        returnFeeIls: '10.00',
        returnPolicyUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(snap.returnPolicySnapshotEnabled).toBe(true);
      expect(snap.returnPolicySnapshotMode).toBe('REFUND_ONLY');
      expect(snap.returnPolicySnapshotWindowDays).toBe(14);
      expect(snap.returnPolicySnapshotFeeIls!.toNumber()).toBe(10);
      expect(snap.returnPolicySnapshotVersion).toEqual(
        new Date('2026-01-01T00:00:00Z'),
      );
    });

    it('a vendor with returnsEnabled=false still gets a real snapshot (not null) - legacy vs. "disabled by choice" stay distinguishable', () => {
      const snap = buildReturnPolicySnapshot({
        returnsEnabled: false,
        returnMode: 'NO_RETURN',
        returnWindowDays: null,
        returnFeeIls: null,
        returnPolicyUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(snap.returnPolicySnapshotEnabled).toBe(false);
      expect(snap.returnPolicySnapshotVersion).not.toBeNull();
    });
  });

  describe('checkReturnEligibility', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const baseDelivery = {
      status: 'DELIVERED',
      fulfilmentMethod: 'DELIVERY' as const,
      paymentMethod: 'ONLINE' as const,
      deliveredAt: new Date('2026-01-25T00:00:00Z'),
      pickedUpAt: null,
      codCollectedAt: null,
      returnPolicySnapshotEnabled: true,
      returnPolicySnapshotMode: 'REFUND_ONLY',
      returnPolicySnapshotWindowDays: 14,
    };

    it('no snapshot at all (legacy order) is never eligible', () => {
      const r = checkReturnEligibility(
        {
          ...baseDelivery,
          returnPolicySnapshotEnabled: null,
          returnPolicySnapshotMode: null,
        },
        now,
      );
      expect(r.eligible).toBe(false);
      expect(r.reasonCode).toBe('NO_POLICY_SNAPSHOT');
    });

    it('snapshot disabled or NO_RETURN blocks eligibility', () => {
      expect(
        checkReturnEligibility(
          { ...baseDelivery, returnPolicySnapshotEnabled: false },
          now,
        ).reasonCode,
      ).toBe('RETURNS_DISABLED');
      expect(
        checkReturnEligibility(
          { ...baseDelivery, returnPolicySnapshotMode: 'NO_RETURN' },
          now,
        ).reasonCode,
      ).toBe('RETURNS_DISABLED');
    });

    it('DELIVERY: not yet DELIVERED/COMPLETED is ineligible', () => {
      const r = checkReturnEligibility(
        { ...baseDelivery, status: 'SENT', deliveredAt: null },
        now,
      );
      expect(r.eligible).toBe(false);
      expect(r.reasonCode).toBe('NOT_YET_ARRIVED');
    });

    it('DELIVERY: COMPLETED with deliveredAt set is eligible within the window', () => {
      const r = checkReturnEligibility(
        { ...baseDelivery, status: 'COMPLETED' },
        now,
      );
      expect(r.eligible).toBe(true);
    });

    it('PICKUP: requires PICKED_UP/COMPLETED and pickedUpAt set', () => {
      const pickup = {
        ...baseDelivery,
        fulfilmentMethod: 'PICKUP' as const,
        deliveredAt: null,
      };
      expect(
        checkReturnEligibility(
          { ...pickup, status: 'PICKED_UP', pickedUpAt: null },
          now,
        ).reasonCode,
      ).toBe('NOT_YET_ARRIVED');
      expect(
        checkReturnEligibility(
          {
            ...pickup,
            status: 'PICKED_UP',
            pickedUpAt: new Date('2026-01-25T00:00:00Z'),
          },
          now,
        ).eligible,
      ).toBe(true);
    });

    it('COD: additionally requires codCollectedAt set', () => {
      const r = checkReturnEligibility(
        { ...baseDelivery, paymentMethod: 'COD', codCollectedAt: null },
        now,
      );
      expect(r.eligible).toBe(false);
      expect(r.reasonCode).toBe('COD_NOT_COLLECTED');
      const r2 = checkReturnEligibility(
        {
          ...baseDelivery,
          paymentMethod: 'COD',
          codCollectedAt: new Date('2026-01-25T00:00:00Z'),
        },
        now,
      );
      expect(r2.eligible).toBe(true);
    });

    it('window expired (now past deliveredAt + windowDays) is ineligible', () => {
      const r = checkReturnEligibility(
        {
          ...baseDelivery,
          deliveredAt: new Date('2026-01-01T00:00:00Z'),
          returnPolicySnapshotWindowDays: 14,
        },
        now,
      );
      expect(r.eligible).toBe(false);
      expect(r.reasonCode).toBe('WINDOW_EXPIRED');
    });

    it('exactly at the window boundary is still eligible (inclusive)', () => {
      const anchor = new Date('2026-01-18T00:00:00Z');
      const boundary = new Date(anchor.getTime() + 14 * 24 * 60 * 60 * 1000);
      const r = checkReturnEligibility(
        { ...baseDelivery, deliveredAt: anchor },
        boundary,
      );
      expect(r.eligible).toBe(true);
    });
  });

  describe('computeReturnRefundAmount', () => {
    it('item_total minus fee, never negative', () => {
      expect(computeReturnRefundAmount('100.00', 1, '10.00').toNumber()).toBe(
        90,
      );
    });

    it('multiplies by quantity', () => {
      expect(computeReturnRefundAmount('50.00', 2, '10.00').toNumber()).toBe(
        90,
      );
    });

    it('fee greater than item total floors at 0, never negative', () => {
      expect(computeReturnRefundAmount('5.00', 1, '10.00').toNumber()).toBe(0);
    });

    it('null fee (no fee configured) refunds the full item total', () => {
      expect(computeReturnRefundAmount('100.00', 1, null).toNumber()).toBe(100);
    });

    it('never includes any delivery-fee component - caller never passes one', () => {
      const amount = computeReturnRefundAmount('100.00', 1, '0.00');
      expect(amount).toBeInstanceOf(Decimal);
      expect(amount.toNumber()).toBe(100);
    });
  });
});
