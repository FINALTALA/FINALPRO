import { normalizeColorName } from './color-name';

describe('normalizeColorName (the same rule as the database)', () => {
  it.each([
    ['\u0645\u0648\u0643\u0627', '\u0645\u0648\u0643\u0627'],
    [
      '  \u0628\u064A\u062C   \u0631\u0645\u0644\u064A ',
      '\u0628\u064A\u062C \u0631\u0645\u0644\u064A',
    ],
    ['\u0623\u062D\u0645\u0631', '\u0627\u062D\u0645\u0631'],
    ['\u0625\u0633\u0645\u0631', '\u0627\u0633\u0645\u0631'],
    ['\u0622\u062C\u0631\u064A', '\u0627\u062C\u0631\u064A'],
    ['\u0641\u0648\u0634\u064A\u0629', '\u0641\u0648\u0634\u064A\u0647'],
    ['\u0645\u0634\u0645\u0634\u0649', '\u0645\u0634\u0645\u0634\u064A'],
    ['\u200F\u0628\u064F\u0646\u0640\u0651\u064A', '\u0628\u0646\u064A'],
    ['Sand  BEIGE', 'sand beige'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeColorName(input)).toBe(expected);
  });

  it('two shades stay different; only the stated variations collapse', () => {
    expect(
      normalizeColorName('\u0628\u064A\u062C \u0631\u0645\u0644\u064A'),
    ).not.toBe(
      normalizeColorName('\u0628\u064A\u062C \u063A\u0627\u0645\u0642'),
    );
  });
});
