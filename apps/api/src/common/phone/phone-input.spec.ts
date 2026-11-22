import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  E164,
  normalizePhoneInput,
  PHONE_INVALID_MARKER,
  PhoneField,
} from './phone-input';

class Probe {
  @PhoneField()
  phone!: string;
}
const check = (phone: unknown) => {
  const dto = plainToInstance(Probe, { phone });
  const errors = validateSync(dto);
  return {
    phone: dto.phone,
    errors: errors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
};

describe('phone input (phase A++ item 8: one cleaning rule, strict E.164)', () => {
  it('removes spaces, dashes, brackets and dots', () => {
    expect(normalizePhoneInput('+970 59-123 4567')).toBe('+970591234567');
    expect(normalizePhoneInput('+970 (59) 123.45.67')).toBe('+970591234567');
    expect(normalizePhoneInput('\u00A0+970\u2009591234567 ')).toBe(
      '+970591234567',
    );
  });

  it('removes invisible characters: direction marks, isolates, zero-width, BOM', () => {
    expect(normalizePhoneInput('\u200E+970591234567\u200F')).toBe(
      '+970591234567',
    );
    expect(normalizePhoneInput('\u2066+970591234567\u2069')).toBe(
      '+970591234567',
    );
    expect(normalizePhoneInput('\u202B+970\u200B59\u200D1234567\u202C')).toBe(
      '+970591234567',
    );
    expect(normalizePhoneInput('\uFEFF+970591234567')).toBe('+970591234567');
  });

  it('turns Arabic-Indic and Persian digits into 0-9, and 00 into +', () => {
    expect(normalizePhoneInput('+٩٧٠٥٩١٢٣٤٥٦٧')).toBe('+970591234567');
    expect(normalizePhoneInput('+۹۷۰۵۶۱۲۳۴۵۶۷')).toBe('+970561234567');
    expect(normalizePhoneInput('00970591234567')).toBe('+970591234567');
  });

  it('never makes an invalid number valid: a local form stays local and is refused', () => {
    expect(normalizePhoneInput('0591234567')).toBe('0591234567');
    expect(E164.test(normalizePhoneInput('0591234567'))).toBe(false);
    expect(check('0591234567').errors).toContain(
      `${PHONE_INVALID_MARKER}phone`,
    );
    expect(check('12345').errors).toContain(`${PHONE_INVALID_MARKER}phone`);
    expect(check('+970abc').errors).toContain(`${PHONE_INVALID_MARKER}phone`);
  });

  it('the field: cleaned then validated; the stored value is E.164 exactly', () => {
    for (const typed of [
      '\u200F+970 59 123 4567',
      '+٩٧٠٥٩١٢٣٤٥٦٧',
      '+970 (56) 123-4567',
    ]) {
      const r = check(typed);
      expect(r.errors).toEqual([]);
      expect(E164.test(r.phone)).toBe(true);
    }
    expect(check('+970561234567').phone).toBe('+970561234567');
    expect(check('+970591234567').phone).toBe('+970591234567');
  });
});
