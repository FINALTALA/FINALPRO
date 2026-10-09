import { deliveryNotAvailableBlocker } from './delivery-coverage.util';

describe('delivery-coverage.util', () => {
  describe('deliveryNotAvailableBlocker', () => {
    it('builds a structured DELIVERY blocker that carries no zone/fee detail', () => {
      const b = deliveryNotAvailableBlocker();
      expect(b.code).toBe('DELIVERY_NOT_AVAILABLE_IN_ZONE');
      expect(b.fulfilment_method).toBe('DELIVERY');
      expect(typeof b.message).toBe('string');
      expect(b).not.toHaveProperty('region');
      expect(b).not.toHaveProperty('fee');
    });
  });
});
