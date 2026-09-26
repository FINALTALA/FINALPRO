import { BadRequestException } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from './cursor.util';

const UUID = '3f2b8c1e-9d4a-4c55-8a1e-0b7d6f5e4c3a';
const validators = [
  isIsoDateString,
  (v: unknown) => v === 'BRANCH',
  isUuidLike,
];

describe('cursor.util', () => {
  it('round-trips a valid cursor as opaque base64url', () => {
    const parts = ['2026-09-29T10:00:00.000Z', 'BRANCH', UUID];
    const raw = encodeCursor(parts);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw, validators)).toEqual(parts);
  });

  it('treats a missing or empty cursor as "first page"', () => {
    expect(decodeCursor(undefined, validators)).toBeNull();
    expect(decodeCursor('', validators)).toBeNull();
  });

  it.each([
    ['not base64 json', '@@@'],
    ['json but not an array', Buffer.from('{}').toString('base64url')],
    ['wrong length', encodeCursor(['2026-09-29T10:00:00.000Z', 'BRANCH'])],
    ['bad date', encodeCursor(['yesterday', 'BRANCH', UUID])],
    ['bad kind', encodeCursor(['2026-09-29T10:00:00.000Z', 'OTHER', UUID])],
    [
      'sql in a part',
      encodeCursor([
        '2026-09-29T10:00:00.000Z',
        'BRANCH',
        "x'; DROP TABLE users;--",
      ]),
    ],
    [
      'non-string part',
      Buffer.from(JSON.stringify([1, 'BRANCH', UUID])).toString('base64url'),
    ],
  ])('rejects a malformed cursor (%s) with INVALID_CURSOR', (_name, raw) => {
    let caught: unknown;
    try {
      decodeCursor(raw, validators);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });

  it('parseLimit defaults to 20, accepts 1..50, rejects everything else', () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit('')).toBe(20);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('50')).toBe(50);
    for (const bad of ['0', '51', '-1', '1.5', 'abc', ' 5', '5 ']) {
      expect(() => parseLimit(bad)).toThrow(BadRequestException);
    }
  });
});
