import { computeAggregateRating } from './rating-aggregate.util';

describe('rating-aggregate.util', () => {
  describe('computeAggregateRating', () => {
    it('withholds the average entirely below 3 reviews', () => {
      expect(computeAggregateRating([])).toEqual({ average: null, count: 0 });
      expect(computeAggregateRating([5])).toEqual({ average: null, count: 1 });
      expect(computeAggregateRating([5, 1])).toEqual({
        average: null,
        count: 2,
      });
    });

    it('shows the arithmetic mean at exactly 3 reviews', () => {
      expect(computeAggregateRating([5, 4, 3])).toEqual({
        average: 4,
        count: 3,
      });
    });

    it('rounds the mean to 2 decimal places', () => {
      expect(computeAggregateRating([5, 4, 4])).toEqual({
        average: 4.33,
        count: 3,
      });
    });

    it('counts every VISIBLE review passed in, however many', () => {
      expect(computeAggregateRating([1, 1, 1, 1, 5])).toEqual({
        average: 1.8,
        count: 5,
      });
    });
  });
});
