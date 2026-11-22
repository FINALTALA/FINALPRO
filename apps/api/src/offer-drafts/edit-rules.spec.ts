import { DraftPayload } from './draft-payload';
import {
  assertEditAllowed,
  changedGroups,
  conflictGroups,
  EditSnapshot,
} from './edit-rules';

const base: DraftPayload = {
  audience: 'WOMEN',
  category: 'DRESSES_WOMEN',
  size_system: 'LETTER',
  title_ar: 'فستان',
  price: 200,
  colors: [{ key: 'BEIGE', family: 'BEIGE', name_ar: 'بيج', images: ['a'] }],
  sizes: { BEIGE: ['S', 'M'] },
};
const snap: EditSnapshot = {
  payload: base,
  colorIds: { BEIGE: 'c1' },
  mixedImages: [],
};
const code = (f: () => void) => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as { getResponse: () => { code: string } }).getResponse().code;
  }
};

describe('edit rules', () => {
  it('a new colour, a new size and a new version quantity are allowed', () => {
    expect(
      code(() =>
        assertEditAllowed(snap, {
          ...base,
          colors: [
            ...base.colors!,
            { key: 'BROWN', family: 'BROWN', name_ar: 'موكا', images: [] },
          ],
          sizes: { BEIGE: ['S', 'M', 'L'], BROWN: ['M'] },
          stock: { b1: { 'BEIGE|L': 2, 'BROWN|M': 1, 'BEIGE|S': 0 } },
        }),
      ),
    ).toBeNull();
  });
  it.each([
    [
      'removing a colour',
      { ...base, colors: [], sizes: {} },
      'EDIT_REMOVE_NOT_ALLOWED',
    ],
    [
      'removing a size',
      { ...base, sizes: { BEIGE: ['S'] } },
      'EDIT_REMOVE_NOT_ALLOWED',
    ],
    [
      'an existing version quantity',
      { ...base, stock: { b1: { 'BEIGE|S': 3 } } },
      'EDIT_STOCK_EXISTING',
    ],
    [
      'an existing version SKU',
      { ...base, sku_overrides: { 'BEIGE|M': 'X' } },
      'EDIT_SKU_EXISTING',
    ],
    ['the category', { ...base, category: 'TOPS_WOMEN' }, 'EDIT_LOCKED_FIELD'],
    [
      'the size system',
      { ...base, size_system: 'EU' as const },
      'EDIT_LOCKED_FIELD',
    ],
    [
      'an existing colour family',
      { ...base, colors: [{ ...base.colors![0], family: 'BROWN' }] },
      'EDIT_LOCKED_FIELD',
    ],
  ])('%s is refused', (_label, p, expected) => {
    expect(code(() => assertEditAllowed(snap, p as DraftPayload))).toBe(
      expected,
    );
  });
  it('conflicts are named per group: changed elsewhere only, or in both - never merged', () => {
    const current = { ...base, price: 210, title_ar: 'فستان جديد' };
    const mine = { ...base, price: 180 };
    expect(changedGroups(base, mine)).toEqual(['price']);
    expect(
      conflictGroups(base, current, mine).map((g) => [g.group, g.kind]),
    ).toEqual([
      ['title', 'elsewhere'],
      ['price', 'both'],
    ]);
  });
});
