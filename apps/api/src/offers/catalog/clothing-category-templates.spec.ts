import {
  CLOSED_SPEC_VALUES,
  CLOTHING_CATEGORY_TEMPLATE_FIELDS,
  validateTemplateAttributes,
} from './clothing-category-templates';

describe('clothing specifications (phase A++ item 4: fit, stretch, occasion, care)', () => {
  it('the clothing templates take the four new keys; shoes and accessories do not', () => {
    for (const t of [
      'DRESSES',
      'TOPS_SHIRTS',
      'BOTTOMS',
      'COATS_JACKETS',
      'SETS_PYJAMAS',
      'KIDS_CLOTHING',
    ] as const) {
      expect(CLOTHING_CATEGORY_TEMPLATE_FIELDS[t]).toEqual(
        expect.arrayContaining(['fit', 'stretch', 'occasion', 'care']),
      );
    }
    for (const t of [
      'SHOES',
      'BAGS',
      'JEWELLERY_WATCHES',
      'OTHER_ACCESSORIES',
    ] as const) {
      expect(CLOTHING_CATEGORY_TEMPLATE_FIELDS[t]).not.toContain('stretch');
    }
  });

  it('all optional: none of them is ever required', () => {
    expect(validateTemplateAttributes('DRESSES', {})).toEqual([]);
  });

  it('closed lists: a known code passes, anything else is INVALID_VALUE', () => {
    expect(
      validateTemplateAttributes('DRESSES', {
        fit: 'REGULAR',
        stretch: 'SLIGHT',
        occasion: 'EVENING',
        care: 'HAND_WASH',
      }),
    ).toEqual([]);
    expect(validateTemplateAttributes('DRESSES', { occasion: 'سهرة' })).toEqual(
      [{ type: 'INVALID_VALUE', key: 'occasion' }],
    );
    expect(validateTemplateAttributes('BOTTOMS', { stretch: 'VERY' })).toEqual([
      { type: 'INVALID_VALUE', key: 'stretch' },
    ]);
  });

  it('care takes several codes, comma-separated - each known, none twice', () => {
    expect(
      validateTemplateAttributes('TOPS_SHIRTS', {
        care: 'MACHINE_WASH, NO_BLEACH,IRON_LOW',
      }),
    ).toEqual([]);
    expect(
      validateTemplateAttributes('TOPS_SHIRTS', { care: 'MACHINE_WASH,BOIL' }),
    ).toEqual([{ type: 'INVALID_VALUE', key: 'care' }]);
    expect(
      validateTemplateAttributes('TOPS_SHIRTS', {
        care: 'NO_BLEACH,NO_BLEACH',
      }),
    ).toEqual([{ type: 'INVALID_VALUE', key: 'care' }]);
    // A single-value key never takes a list.
    expect(
      validateTemplateAttributes('TOPS_SHIRTS', { fit: 'SLIM,LOOSE' }),
    ).toEqual([{ type: 'INVALID_VALUE', key: 'fit' }]);
  });

  it('older products keep validating: TOPS_SHIRTS fit stored as the Arabic words offered before', () => {
    for (const legacy of ['ضيّق', 'عادي', 'واسع', 'أوفرسايز']) {
      expect(
        validateTemplateAttributes('TOPS_SHIRTS', { fit: legacy }),
      ).toEqual([]);
    }
    // Free-text keys stay free text.
    expect(
      validateTemplateAttributes('DRESSES', { material: 'شيفون' }),
    ).toEqual([]);
    expect(Object.keys(CLOSED_SPEC_VALUES).sort()).toEqual([
      'care',
      'fit',
      'occasion',
      'stretch',
    ]);
  });
});
