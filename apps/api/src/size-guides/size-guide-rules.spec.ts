import {
  assertPublishable,
  DraftInput,
  groupForAudiences,
  guideFitsSize,
  normaliseDraft,
  SizeGuideRuleError,
  SizeInfo,
  toTenths,
} from './size-guide-rules';

const sizes = new Map<string, SizeInfo>([
  ['ONE_SIZE', { group: 'ADULT', sortOrder: 0 }],
  ['S', { group: 'ADULT', sortOrder: 2 }],
  ['M', { group: 'ADULT', sortOrder: 3 }],
  ['L', { group: 'ADULT', sortOrder: 4 }],
  ['EU_38', { group: 'ADULT', sortOrder: 11 }],
  ['AGE_4_5Y', { group: 'KIDS_AGE', sortOrder: 30 }],
  ['AGE_6_7Y', { group: 'KIDS_AGE', sortOrder: 32 }],
]);

const base = (patch: Partial<DraftInput> = {}): DraftInput => ({
  basis: 'BODY',
  measurements: [
    { key: 'CHEST', is_range: true },
    { key: 'WAIST', is_range: true },
  ],
  rows: [
    {
      size_code: 'M',
      values: { CHEST: { min: 92, max: 96 }, WAIST: { min: 74, max: 78 } },
    },
    {
      size_code: 'S',
      values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 } },
    },
  ],
  ...patch,
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SizeGuideRuleError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('PD-4 size guide rules', () => {
  it('cm with at most one decimal becomes integer tenths; anything else is refused', () => {
    expect(toTenths(90.5)).toBe(905);
    expect(toTenths(90)).toBe(900);
    expect(toTenths(90.55)).toBeNull();
    expect(toTenths('90')).toBeNull();
    expect(toTenths(Number.NaN)).toBeNull();
  });

  it('normalises a valid draft and orders rows by the taxonomy, not the client', () => {
    const d = normaliseDraft(base(), 'STANDARD', sizes, ['WOMEN']);
    expect(d.rows.map((r) => r.sizeCode)).toEqual(['S', 'M']);
    expect(d.rows[0].cells).toEqual([
      { key: 'CHEST', minTenths: 880, maxTenths: 920 },
      { key: 'WAIST', minTenths: 700, maxTenths: 740 },
    ]);
  });

  it('a standard guide measures the body only; a product guide may measure the garment', () => {
    expect(
      code(() =>
        normaliseDraft(base({ basis: 'GARMENT' }), 'STANDARD', sizes, []),
      ),
    ).toBe('BASIS_NOT_ALLOWED');
    expect(
      code(() =>
        normaliseDraft(base({ basis: 'GARMENT' }), 'PRODUCT', sizes, []),
      ),
    ).toBe('OK');
  });

  it('refuses empty guides, duplicate columns/sizes and unknown sizes', () => {
    expect(
      code(() => normaliseDraft(base({ rows: [] }), 'STANDARD', sizes, [])),
    ).toBe('SIZE_GUIDE_EMPTY');
    expect(
      code(() =>
        normaliseDraft(
          base({
            measurements: [
              { key: 'CHEST', is_range: true },
              { key: 'CHEST', is_range: false },
            ],
          }),
          'STANDARD',
          sizes,
          [],
        ),
      ),
    ).toBe('DUPLICATE_MEASUREMENT');
    expect(
      code(() =>
        normaliseDraft(
          base({
            rows: [
              { size_code: 'M', values: {} },
              { size_code: 'M', values: {} },
            ],
          }),
          'STANDARD',
          sizes,
          [],
        ),
      ),
    ).toBe('DUPLICATE_SIZE');
    expect(
      code(() =>
        normaliseDraft(
          base({ rows: [{ size_code: 'XXS', values: {} }] }),
          'STANDARD',
          sizes,
          [],
        ),
      ),
    ).toBe('UNKNOWN_SIZE');
  });

  it('keeps one size group, matching the audiences the guide applies to', () => {
    const mixed = base({
      rows: [
        { size_code: 'M', values: {} },
        { size_code: 'AGE_4_5Y', values: {} },
      ],
    });
    expect(code(() => normaliseDraft(mixed, 'STANDARD', sizes, []))).toBe(
      'SIZE_GROUP_NOT_ALLOWED',
    );
    const kidsRows = base({ rows: [{ size_code: 'AGE_4_5Y', values: {} }] });
    expect(
      code(() => normaliseDraft(kidsRows, 'STANDARD', sizes, ['WOMEN'])),
    ).toBe('SIZE_GROUP_NOT_ALLOWED');
    expect(
      code(() => normaliseDraft(kidsRows, 'STANDARD', sizes, ['KIDS'])),
    ).toBe('OK');
    expect(
      code(() => normaliseDraft(base(), 'STANDARD', sizes, ['KIDS'])),
    ).toBe('SIZE_GROUP_NOT_ALLOWED');
    // ONE_SIZE fits either group.
    expect(
      code(() =>
        normaliseDraft(
          base({
            rows: [
              { size_code: 'ONE_SIZE', values: {} },
              { size_code: 'AGE_4_5Y', values: {} },
            ],
          }),
          'STANDARD',
          sizes,
          ['KIDS'],
        ),
      ),
    ).toBe('OK');
  });

  it('checks every value: number format, plausible range, single vs range, max >= min', () => {
    const one = (
      values: DraftInput['rows'][number]['values'],
      measurements = base().measurements,
    ) =>
      code(() =>
        normaliseDraft(
          base({ measurements, rows: [{ size_code: 'M', values }] }),
          'STANDARD',
          sizes,
          [],
        ),
      );
    expect(one({ CHEST: { min: 90.25, max: 94 } })).toBe('INVALID_VALUE');
    expect(one({ CHEST: { min: 30, max: 94 } })).toBe(
      'SIZE_VALUE_OUT_OF_RANGE',
    );
    expect(one({ CHEST: { min: 96, max: 92 } })).toBe('INVALID_RANGE');
    expect(
      one({ CHEST: { min: 90, max: 94 } }, [{ key: 'CHEST', is_range: false }]),
    ).toBe('NOT_A_RANGE');
    expect(one({ HIP: { min: 100 } })).toBe('VALUE_FOR_UNKNOWN_MEASUREMENT');
    expect(
      code(() =>
        normaliseDraft(
          base({ notes_ar: 'أ'.repeat(1001) }),
          'STANDARD',
          sizes,
          [],
        ),
      ),
    ).toBe('NOTE_TOO_LONG');
  });

  it('publishing needs every cell (both ends of a range) and never-decreasing values', () => {
    expect(
      code(() =>
        assertPublishable(normaliseDraft(base(), 'STANDARD', sizes, [])),
      ),
    ).toBe('OK');
    const incomplete = base({
      rows: [{ size_code: 'S', values: { CHEST: { min: 88, max: 92 } } }],
    });
    expect(
      code(() =>
        assertPublishable(normaliseDraft(incomplete, 'STANDARD', sizes, [])),
      ),
    ).toBe('SIZE_GUIDE_INCOMPLETE');
    const openRange = base({
      rows: [
        {
          size_code: 'S',
          values: { CHEST: { min: 88 }, WAIST: { min: 70, max: 74 } },
        },
      ],
    });
    expect(
      code(() =>
        assertPublishable(normaliseDraft(openRange, 'STANDARD', sizes, [])),
      ),
    ).toBe('SIZE_GUIDE_INCOMPLETE');
    const shrinking = base({
      rows: [
        {
          size_code: 'S',
          values: { CHEST: { min: 92, max: 96 }, WAIST: { min: 70, max: 74 } },
        },
        {
          size_code: 'M',
          values: { CHEST: { min: 90, max: 94 }, WAIST: { min: 74, max: 78 } },
        },
      ],
    });
    expect(
      code(() =>
        assertPublishable(normaliseDraft(shrinking, 'STANDARD', sizes, [])),
      ),
    ).toBe('SIZE_VALUES_NOT_MONOTONIC');
    // Equal values are allowed; ONE_SIZE stays out of the order.
    const withOneSize = base({
      rows: [
        {
          size_code: 'ONE_SIZE',
          values: {
            CHEST: { min: 120, max: 130 },
            WAIST: { min: 100, max: 110 },
          },
        },
        {
          size_code: 'S',
          values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 } },
        },
        {
          size_code: 'M',
          values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 } },
        },
      ],
    });
    expect(
      code(() =>
        assertPublishable(normaliseDraft(withOneSize, 'STANDARD', sizes, [])),
      ),
    ).toBe('OK');
  });

  it('maps audiences to size groups and guides to the sizes they describe', () => {
    expect(groupForAudiences(['WOMEN', 'MEN'])).toBe('ADULT');
    expect(groupForAudiences(['KIDS'])).toBe('KIDS_AGE');
    expect(groupForAudiences(['KIDS', 'WOMEN'])).toBe('MIXED');
    expect(guideFitsSize(['KIDS'], 'KIDS_AGE')).toBe(true);
    expect(guideFitsSize(['WOMEN'], 'KIDS_AGE')).toBe(false);
    expect(guideFitsSize(['WOMEN'], 'ADULT')).toBe(true);
    expect(guideFitsSize('ALL', 'KIDS_AGE')).toBe(true);
  });
});
