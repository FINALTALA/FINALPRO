import { offerMatchingText } from './matching.service';

describe('offer matching text (phase A+)', () => {
  it('an empty or whitespace-only English name is left out explicitly - never a blank token', () => {
    expect(offerMatchingText(['فستان سهرة', '', null, 'شيفون'])).toBe(
      'فستان سهرة شيفون',
    );
    expect(offerMatchingText(['فستان', '   ', undefined, ' أسود '])).toBe(
      'فستان أسود',
    );
    expect(offerMatchingText(['فستان', 'Evening dress'])).toBe(
      'فستان Evening dress',
    );
    expect(offerMatchingText(['', '  '])).toBe('');
  });
});
