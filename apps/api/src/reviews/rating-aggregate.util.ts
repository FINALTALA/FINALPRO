// Sprint 23 (final decision #2): arithmetic mean of VISIBLE reviews
// only, shown once at least 3 exist - fewer than that is withheld
// entirely (average: null), never shown as a misleadingly precise
// average of one or two reviews.
export const MIN_REVIEWS_TO_DISPLAY = 3;

export interface AggregateRating {
  average: number | null;
  count: number;
}

export function computeAggregateRating(ratings: number[]): AggregateRating {
  const count = ratings.length;
  if (count < MIN_REVIEWS_TO_DISPLAY) {
    return { average: null, count };
  }
  const sum = ratings.reduce((acc, r) => acc + r, 0);
  return { average: Math.round((sum / count) * 100) / 100, count };
}
