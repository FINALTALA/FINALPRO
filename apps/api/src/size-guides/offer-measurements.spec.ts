import { SizeGroup } from '../../generated/prisma/client';
import {
  measureKeysFor,
  measurementsEmpty,
  offerMeasurementsDraft,
  parseMeasurementsInput,
  SizeGuideRuleError,
  SizeInfo,
} from './size-guide-rules';

const SIZES = new Map<string, SizeInfo>(
  (
    [
      ['S', 'ADULT', 1],
      ['M', 'ADULT', 2],
      ['L', 'ADULT', 3],
      ['ONE_SIZE', 'ADULT', 0],
      ['AGE_4', 'KIDS_AGE', 4],
    ] as [string, SizeGroup, number][]
  ).map(([c, group, sortOrder]) => [c, { group, sortOrder }]),
);
const fails = (fn: () => unknown, code: string) => {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SizeGuideRuleError);
  expect((thrown as SizeGuideRuleError).code).toBe(code);
};

describe("a product's own measurements (phase A+)", () => {
  it('the measurements each category takes', () => {
    expect(measureKeysFor('DRESSES_WOMEN', 'WOMEN')).toEqual([
      'CHEST',
      'WAIST',
      'HIP',
      'LENGTH',
    ]);
    expect(measureKeysFor('COATS', 'MEN')).toEqual([
      'CHEST',
      'SHOULDER',
      'SLEEVE',
      'LENGTH',
    ]);
    expect(measureKeysFor('TROUSERS', 'MEN')).toEqual([
      'WAIST',
      'HIP',
      'INSEAM',
      'LENGTH',
    ]);
    expect(measureKeysFor('SKIRTS', 'WOMEN')).toEqual([
      'WAIST',
      'HIP',
      'LENGTH',
    ]);
    expect(measureKeysFor('TWO_PIECE_SETS', 'WOMEN')).toEqual([
      'CHEST',
      'WAIST',
      'HIP',
      'LENGTH',
    ]);
    expect(measureKeysFor('GIRLS_DRESSES', 'KIDS')).toEqual([
      'HEIGHT',
      'CHEST',
      'WAIST',
      'LENGTH',
    ]);
    expect(measureKeysFor('SHOES', 'KIDS')).toEqual(['FOOT_LENGTH']);
    expect(measureKeysFor('BAGS', 'WOMEN')).toEqual([]);
    expect(measureKeysFor(null, 'WOMEN')).toEqual([]);
  });

  it('no measurement chosen is no table; once one is chosen, its values are required (a blank cell is not a value)', () => {
    expect(measurementsEmpty(null)).toBe(true);
    expect(measurementsEmpty({ keys: [], values: {} })).toBe(true);
    expect(
      offerMeasurementsDraft({ keys: [], values: {} }, ['S'], ['CHEST'], SIZES),
    ).toBeNull();
    expect(measurementsEmpty({ keys: ['CHEST'], values: {} })).toBe(false);
    fails(
      () =>
        offerMeasurementsDraft(
          parseMeasurementsInput({
            keys: ['CHEST'],
            values: { S: { CHEST: '' } },
          }),
          ['S'],
          ['CHEST'],
          SIZES,
        ),
      'SIZE_GUIDE_INCOMPLETE',
    );
  });

  it('a partial table is legitimate: a dress with chest, waist and length only - hip (or shoulder, sleeve) is never required', () => {
    const d = offerMeasurementsDraft(
      {
        keys: ['CHEST', 'WAIST', 'LENGTH'],
        values: {
          S: { CHEST: 86, WAIST: 68, LENGTH: 120 },
          M: { CHEST: 90, WAIST: 72, LENGTH: 121 },
        },
      },
      ['S', 'M'],
      measureKeysFor('DRESSES_WOMEN', 'WOMEN'),
      SIZES,
    )!;
    expect(d.measurements.map((m) => m.key)).toEqual([
      'CHEST',
      'WAIST',
      'LENGTH',
    ]);
    expect(d.rows.every((r) => r.cells.length === 3)).toBe(true);
    // A value for a measurement that was not chosen is refused, not stored.
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['CHEST'], values: { S: { CHEST: 86, HIP: 92 } } },
          ['S'],
          measureKeysFor('DRESSES_WOMEN', 'WOMEN'),
          SIZES,
        ),
      'VALUE_FOR_UNKNOWN_MEASUREMENT',
    );
  });

  it('a complete table: garment, single values, sizes in their order', () => {
    const d = offerMeasurementsDraft(
      {
        keys: ['CHEST', 'LENGTH'],
        values: {
          M: { CHEST: 92, LENGTH: 121 },
          S: { CHEST: 88, LENGTH: 120 },
        },
      },
      ['M', 'S'],
      ['CHEST', 'WAIST', 'HIP', 'LENGTH'],
      SIZES,
    )!;
    expect(d.basis).toBe('GARMENT');
    expect(d.measurements.map((m) => [m.key, m.isRange])).toEqual([
      ['CHEST', false],
      ['LENGTH', false],
    ]);
    expect(d.rows.map((r) => r.sizeCode)).toEqual(['S', 'M']);
    expect(d.rows[0].cells).toEqual(
      expect.arrayContaining([
        { key: 'CHEST', minTenths: 880, maxTenths: null },
      ]),
    );
  });

  it('refuses: a measurement of another category, a size the product does not have, a missing cell, a value out of range, a smaller value for a larger size', () => {
    const keys = measureKeysFor('DRESSES_WOMEN', 'WOMEN');
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['INSEAM'], values: { S: { INSEAM: 80 } } },
          ['S'],
          keys,
          SIZES,
        ),
      'MEASUREMENT_NOT_FOR_CATEGORY',
    );
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['CHEST'], values: { L: { CHEST: 90 } } },
          ['S', 'M'],
          keys,
          SIZES,
        ),
      'SIZE_NOT_IN_PRODUCT',
    );
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['CHEST'], values: { S: { CHEST: 88 } } },
          ['S', 'M'],
          keys,
          SIZES,
        ),
      'SIZE_GUIDE_INCOMPLETE',
    );
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['CHEST'], values: { S: { CHEST: 900 } } },
          ['S'],
          keys,
          SIZES,
        ),
      'SIZE_VALUE_OUT_OF_RANGE',
    );
    fails(
      () =>
        offerMeasurementsDraft(
          { keys: ['CHEST'], values: { S: { CHEST: 90 }, M: { CHEST: 88 } } },
          ['S', 'M'],
          keys,
          SIZES,
        ),
      'SIZE_VALUES_NOT_MONOTONIC',
    );
  });

  it('reads only the expected shape from a request or a saved draft', () => {
    expect(parseMeasurementsInput(null)).toBeNull();
    expect(
      parseMeasurementsInput({ keys: ['CHEST'], values: { S: { CHEST: 88 } } }),
    ).toEqual({ keys: ['CHEST'], values: { S: { CHEST: 88 } } });
    fails(() => parseMeasurementsInput([]), 'INVALID_MEASUREMENTS');
    fails(
      () => parseMeasurementsInput({ keys: ['NECK'], values: {} }),
      'INVALID_MEASUREMENTS',
    );
    fails(
      () =>
        parseMeasurementsInput({
          keys: ['CHEST'],
          values: { S: { CHEST: 'x' } },
        }),
      'INVALID_MEASUREMENTS',
    );
    fails(
      () => parseMeasurementsInput({ keys: ['CHEST'], values: { 's m': {} } }),
      'INVALID_MEASUREMENTS',
    );
  });
});
