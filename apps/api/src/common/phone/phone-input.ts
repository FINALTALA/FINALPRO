import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsPhoneNumber,
  Matches,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Phase A++ (item 8): the ONE place a phone number typed by a person is
 * cleaned before it is checked - login, registration, OTP, password reset,
 * reactivation, staff invites, the phone change and addresses all use it
 * (through @PhoneField below). The web has the same function
 * (apps/web/src/lib/phone.ts); the server is the reference.
 *
 * Cleaning only - it never turns an invalid number into a valid one:
 *  - removes spaces (any Unicode space), dashes, dots, brackets and slashes;
 *  - removes invisible characters: direction marks (LRM/RLM, the embedding,
 *    override and isolate controls), zero-width characters and the BOM;
 *  - turns Arabic-Indic (٠-٩) and Persian (۰-۹) digits into 0-9;
 *  - writes the international prefix "00" as "+" (the same number).
 * A local form such as 059... is NOT rewritten to +970...: after cleaning
 * the number must be strict E.164 (+, then 8-15 digits) and pass the same
 * libphonenumber check as before - storage stays E.164 exactly as today.
 */
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SEPARATORS =
  /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000\-\u2010-\u2015\u2212.()[\]/]/g;

export function normalizePhoneInput(raw: string): string {
  let s = raw.replace(INVISIBLE, '').replace(SEPARATORS, '');
  s = s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // A full-width or Arabic plus sign written by some keyboards.
  s = s.replace(/[\uFF0B\u2795]/g, '+');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return s;
}

/** Strict E.164: "+", a non-zero first digit, 8-15 digits in all. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/** The validation message marker the error filter turns into PHONE_INVALID. */
export const PHONE_INVALID_MARKER = 'PHONE_INVALID:';
const phoneMessage = (args: ValidationArguments) =>
  `${PHONE_INVALID_MARKER}${args.property}`;

/**
 * A phone number field: cleaned (normalizePhoneInput), then strictly
 * validated. An invalid number fails with the PHONE_INVALID marker, which
 * HttpExceptionFilter reports as `{ code: 'PHONE_INVALID', details: [{ field }] }`
 * - never class-validator's English sentence.
 */
export function PhoneField(options: ValidationOptions = {}) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? normalizePhoneInput(value) : value,
    ),
    Matches(E164, { ...options, message: phoneMessage }),
    IsPhoneNumber(undefined, { ...options, message: phoneMessage }),
  );
}
