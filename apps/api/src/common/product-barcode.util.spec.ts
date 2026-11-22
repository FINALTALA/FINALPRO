import {
  generatedProductBarcode,
  gs1CheckDigit,
  legacyVariantBarcode,
  normalizeBarcode,
  printableBarcode,
} from './barcode.util';

describe('product barcodes (barcode.util)', () => {
  it('accepts a real EAN-13 and rejects it with one digit changed', () => {
    expect(normalizeBarcode('4006381333931')).toEqual({
      ok: true,
      code: '4006381333931',
      format: 'EAN13',
    });
    expect(normalizeBarcode('4006381333932')).toEqual({
      ok: false,
      problem: 'BARCODE_CHECK_DIGIT',
    });
  });

  it('stores a UPC-A as its 13-digit EAN form, so both scanner forms are one code', () => {
    expect(normalizeBarcode('036000291452')).toEqual({
      ok: true,
      code: '0036000291452',
      format: 'UPCA',
    });
    expect(normalizeBarcode('0036000291452')).toEqual({
      ok: true,
      code: '0036000291452',
      format: 'EAN13',
    });
    expect(normalizeBarcode('036000291453')).toEqual({
      ok: false,
      problem: 'BARCODE_CHECK_DIGIT',
    });
    expect(printableBarcode('0036000291452', 'UPCA')).toBe('036000291452');
  });

  it('accepts a real EAN-8 and rejects a wrong check digit', () => {
    expect(normalizeBarcode('96385074')).toEqual({
      ok: true,
      code: '96385074',
      format: 'EAN8',
    });
    expect(normalizeBarcode('96385075')).toEqual({
      ok: false,
      problem: 'BARCODE_CHECK_DIGIT',
    });
  });

  it('treats other 4-32 character codes as Code 128 (spaces dropped, upper-cased)', () => {
    expect(normalizeBarcode(' ab-12 34 ')).toEqual({
      ok: true,
      code: 'AB-1234',
      format: 'CODE128',
    });
    expect(normalizeBarcode('123456')).toEqual({
      ok: true,
      code: '123456',
      format: 'CODE128',
    });
    expect(normalizeBarcode('abc')).toEqual({
      ok: false,
      problem: 'BARCODE_INVALID',
    });
    expect(normalizeBarcode('A'.repeat(33))).toEqual({
      ok: false,
      problem: 'BARCODE_INVALID',
    });
    expect(normalizeBarcode('قطن-1234')).toEqual({
      ok: false,
      problem: 'BARCODE_INVALID',
    });
    expect(normalizeBarcode('   ')).toEqual({
      ok: false,
      problem: 'BARCODE_REQUIRED',
    });
    expect(normalizeBarcode(undefined)).toEqual({
      ok: false,
      problem: 'BARCODE_REQUIRED',
    });
  });

  it('never takes the platform internal codes as a product barcode', () => {
    expect(normalizeBarcode('SIB-1234')).toEqual({
      ok: false,
      problem: 'BARCODE_RESERVED',
    });
    expect(normalizeBarcode('ppb-ABCD')).toEqual({
      ok: false,
      problem: 'BARCODE_RESERVED',
    });
  });

  it('recognises a legacy SIB code only in its full shape', () => {
    const sib = `SIB-${'A1'.repeat(16)}`;
    expect(legacyVariantBarcode(sib.toLowerCase())).toBe(sib);
    expect(legacyVariantBarcode('SIB-1234')).toBeNull();
    expect(legacyVariantBarcode('4006381333931')).toBeNull();
  });

  it('generates in-store EAN-13 codes in the restricted range "29", each with a valid check digit', () => {
    expect(generatedProductBarcode(1)).toBe('2900000000018');
    const big = generatedProductBarcode(9_876_543_210);
    expect(big).toMatch(/^29\d{11}$/);
    for (const code of [
      generatedProductBarcode(1),
      generatedProductBarcode(42),
      big,
    ]) {
      expect(normalizeBarcode(code)).toEqual({
        ok: true,
        code,
        format: 'EAN13',
      });
      expect(gs1CheckDigit(code.slice(0, 12))).toBe(Number(code[12]));
    }
    expect(() => generatedProductBarcode(0)).toThrow(RangeError);
    expect(() => generatedProductBarcode(10_000_000_000)).toThrow(RangeError);
  });
});
