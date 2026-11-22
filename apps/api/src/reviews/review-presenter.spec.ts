import { authorLabel, editableUntil } from './review-presenter';

describe('PD-3 authorLabel (decision 4: never a full name, phone or address)', () => {
  it('is "عميل موثّق" by default, whatever the profile name is', () => {
    expect(authorLabel('ANONYMOUS', 'سارة محمد علي')).toBe('عميل موثّق');
    expect(authorLabel('ANONYMOUS', null)).toBe('عميل موثّق');
  });

  it("FIRST_NAME_INITIAL keeps the first word and the next word's first letter only", () => {
    expect(authorLabel('FIRST_NAME_INITIAL', 'سارة محمد علي')).toBe('سارة م.');
    expect(authorLabel('FIRST_NAME_INITIAL', '  Lina   Haddad ')).toBe(
      'Lina H.',
    );
    expect(authorLabel('FIRST_NAME_INITIAL', 'سارة')).toBe('سارة');
  });

  it('falls back to the anonymous label for a phone number or e-mail typed as a name', () => {
    expect(authorLabel('FIRST_NAME_INITIAL', '+970591234567')).toBe(
      'عميل موثّق',
    );
    expect(authorLabel('FIRST_NAME_INITIAL', '0591234567 سارة')).toBe(
      'عميل موثّق',
    );
    expect(authorLabel('FIRST_NAME_INITIAL', 'sara@example.com')).toBe(
      'عميل موثّق',
    );
    expect(authorLabel('FIRST_NAME_INITIAL', '')).toBe('عميل موثّق');
  });

  it('never exposes a digit as the "initial"', () => {
    expect(authorLabel('FIRST_NAME_INITIAL', 'سارة 059')).toBe('سارة');
  });

  it('caps a very long first word', () => {
    expect([...authorLabel('FIRST_NAME_INITIAL', 'أ'.repeat(40))]).toHaveLength(
      20,
    );
  });
});

describe('PD-3 editableUntil', () => {
  it('is 30 days after creation', () => {
    const created = new Date('2026-10-01T00:00:00.000Z');
    expect(editableUntil(created).toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });
});
