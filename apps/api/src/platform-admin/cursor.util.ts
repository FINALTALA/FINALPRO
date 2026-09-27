import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset cursor: base64url(JSON array of primitive key parts).
 * Not signed - it carries no authority, it only says "resume after this
 * sort key" - so every part is strictly re-validated on decode and any
 * malformed value is a 400, never passed to SQL unchecked.
 */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(
  raw: string | undefined,
  validators: ((v: unknown) => boolean)[],
): unknown[] | null {
  if (raw === undefined || raw === '') return null;
  const invalid = () =>
    new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'The cursor is malformed - restart from the first page',
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== validators.length ||
    !parsed.every((v, i) => validators[i](v))
  ) {
    throw invalid();
  }
  return parsed;
}

export const isIsoDateString = (v: unknown): boolean =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  !Number.isNaN(Date.parse(v));

export const isUuidLike = (v: unknown): boolean =>
  typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v);

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 20;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException({
      code: 'INVALID_LIMIT',
      message: 'limit must be a positive integer',
    });
  }
  const n = Number(raw);
  if (n < 1 || n > 50) {
    throw new BadRequestException({
      code: 'INVALID_LIMIT',
      message: 'limit must be between 1 and 50',
    });
  }
  return n;
}
