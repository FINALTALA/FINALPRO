import { nameOrArabic, optionalName } from './optional-name';

describe('optional names (phase A+: the English name is optional)', () => {
  it('blank and whitespace-only are no name; a name is trimmed', () => {
    expect(optionalName('')).toBeNull();
    expect(optionalName('   ')).toBeNull();
    expect(optionalName('\t \n')).toBeNull();
    expect(optionalName(null)).toBeNull();
    expect(optionalName(undefined)).toBeNull();
    expect(optionalName('  Evening dress ')).toBe('Evening dress');
  });

  it('display falls back to the Arabic name, never to a blank one', () => {
    expect(nameOrArabic('', 'فستان')).toBe('فستان');
    expect(nameOrArabic('  ', 'فستان')).toBe('فستان');
    expect(nameOrArabic(null, 'فستان')).toBe('فستان');
    expect(nameOrArabic(' Dress ', 'فستان')).toBe('Dress');
  });
});
