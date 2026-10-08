import {
  minimumOrderBlocker,
  normalizeMinimumOrderValue,
  resolveDeliveryMinimumOrderValue,
} from './minimum-order.util';

describe('minimum-order.util', () => {
  describe('normalizeMinimumOrderValue', () => {
    it('converts a raw Decimal-like value to a number', () => {
      expect(normalizeMinimumOrderValue('50.00')).toBe(50);
      expect(normalizeMinimumOrderValue(50)).toBe(50);
    });
    it('returns null for null/undefined', () => {
      expect(normalizeMinimumOrderValue(null)).toBeNull();
      expect(normalizeMinimumOrderValue(undefined)).toBeNull();
    });
    it('does NOT turn null into 0 - the exact bug this function exists to prevent', () => {
      expect(normalizeMinimumOrderValue(null)).not.toBe(0);
    });
  });

  describe('resolveDeliveryMinimumOrderValue (zone override, branch fallback)', () => {
    it('the zone override takes precedence when both are set', () => {
      expect(resolveDeliveryMinimumOrderValue(50, 80)).toBe(80);
    });
    it('falls back to the branch default when the zone has no override', () => {
      expect(resolveDeliveryMinimumOrderValue(50, null)).toBe(50);
    });
    it('a zone override of exactly 0 still overrides a non-null branch default', () => {
      expect(resolveDeliveryMinimumOrderValue(50, 0)).toBe(0);
    });
    it('returns null when neither is set', () => {
      expect(resolveDeliveryMinimumOrderValue(null, null)).toBeNull();
    });
  });

  describe('minimumOrderBlocker', () => {
    it('builds a structured blocker with the exact fulfilment method/amounts given', () => {
      const b = minimumOrderBlocker('PICKUP', 50, 30);
      expect(b.code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      expect(b.fulfilment_method).toBe('PICKUP');
      expect(b.required).toBe(50);
      expect(b.current).toBe(30);
    });
  });
});
