import {
  formatCoordinate,
  normalisePhone,
  validateAddress,
  AddressFormValues,
} from '../../web/src/lib/address';
import {
  SANDBOX_TEST_CARDS,
  cardTokenFor,
  declineMessage,
  formatCardNumber,
  formatExpiry,
} from '../../web/src/lib/sandbox-card';
import {
  CartLineState,
  canSelect,
  checkoutBlock,
  lineMessage,
  lineState,
} from '../../web/src/lib/cart';
import {
  formatDelta,
  hasChanges,
  parsePriceChange,
} from '../../web/src/lib/price-change';

const validAddress: AddressFormValues = {
  label: 'البيت',
  lat: '31.9038',
  lng: '35.2034',
  landmark: 'بجانب الدوار',
  phone1: '0591234567',
  phone2: '',
  zone: 'WEST_BANK',
};

describe('Sprint 14 - address entry helpers', () => {
  it('builds the API body from manual lat/lng, landmark, phone and zone', () => {
    const result = validateAddress(validAddress);
    expect(result).toEqual({
      ok: true,
      body: {
        label: 'البيت',
        lat: 31.9038,
        lng: 35.2034,
        landmark_note: 'بجانب الدوار',
        phone_number_1: '+970591234567',
        zone: 'WEST_BANK',
      },
    });
  });

  it('normalises local phone formats to +970', () => {
    expect(normalisePhone('059 123 4567')).toBe('+970591234567');
    expect(normalisePhone('00970591234567')).toBe('+970591234567');
    expect(normalisePhone('+970561234567')).toBe('+970561234567');
  });

  it('rejects out-of-range or missing coordinates, a bad phone and a missing zone', () => {
    const bad = validateAddress({
      ...validAddress,
      lat: '91',
      lng: '',
      phone1: '123',
      zone: '',
    });
    expect(bad.ok).toBe(false);
    const errors = (bad as { ok: false; errors: Record<string, string> })
      .errors;
    expect(Object.keys(errors).sort()).toEqual(
      ['lat', 'lng', 'phone1', 'zone'].sort(),
    );
    expect(validateAddress({ ...validAddress, lat: 'abc' }).ok).toBe(false);
    expect(validateAddress({ ...validAddress, phone2: '99' }).ok).toBe(false);
  });

  it('formats a geolocation reading for the form fields only (no saving happens here)', () => {
    expect(formatCoordinate(31.90380123456)).toBe('31.903801');
  });
});

describe('Sprint 14 - sandbox card helpers', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('maps only the documented test cards to sandbox tokens', () => {
    for (const card of SANDBOX_TEST_CARDS) {
      const result = cardTokenFor(
        { number: card.number, expiry: '12/30', cvc: '123' },
        now,
      );
      expect(result).toEqual({ ok: true, token: card.token });
    }
  });

  it('refuses any other card number and returns no token (a real card is never accepted)', () => {
    const result = cardTokenFor(
      { number: '5555 5555 5555 4444', expiry: '12/30', cvc: '123' },
      now,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('5555');
  });

  it('validates expiry and cvc', () => {
    const number = SANDBOX_TEST_CARDS[0].number;
    expect(cardTokenFor({ number, expiry: '01/20', cvc: '123' }, now).ok).toBe(
      false,
    );
    expect(cardTokenFor({ number, expiry: '13/30', cvc: '123' }, now).ok).toBe(
      false,
    );
    expect(cardTokenFor({ number, expiry: '1230', cvc: '123' }, now).ok).toBe(
      false,
    );
    expect(cardTokenFor({ number, expiry: '12/30', cvc: '12' }, now).ok).toBe(
      false,
    );
    expect(
      cardTokenFor({ number: '4242', expiry: '12/30', cvc: '123' }, now).ok,
    ).toBe(false);
    // Valid through the end of the expiry month.
    expect(cardTokenFor({ number, expiry: '06/26', cvc: '123' }, now).ok).toBe(
      true,
    );
  });

  it('formats card number and expiry as the customer types', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('42a4')).toBe('424');
    expect(formatExpiry('1230')).toBe('12/30');
  });

  it('explains a decline in plain Arabic and says the hold still stands', () => {
    expect(declineMessage('insufficient_funds')).toContain('الرصيد غير كافٍ');
    expect(declineMessage('card_declined')).toContain('الحجز ما زال قائماً');
    expect(declineMessage(undefined)).toContain('رُفضت');
  });
});

describe('Sprint 14 - cart line state', () => {
  const base: CartLineState = {
    id: 'l1',
    quantity: 1,
    availability: 'available',
    max_quantity: 10,
    purchasable: true,
  };

  it('classifies ok, sold out, unavailable and over-maximum lines', () => {
    expect(lineState(base)).toBe('ok');
    expect(
      lineState({ ...base, availability: 'sold_out', max_quantity: 0 }),
    ).toBe('sold_out');
    expect(lineState({ ...base, purchasable: false, max_quantity: 0 })).toBe(
      'unavailable',
    );
    expect(lineState({ ...base, quantity: 5, max_quantity: 2 })).toBe(
      'exceeds_max',
    );
  });

  it('shows the maximum for an over-quantity line and a low-stock hint', () => {
    expect(lineMessage({ ...base, quantity: 5, max_quantity: 2 })).toContain(
      '2',
    );
    expect(
      lineMessage({ ...base, availability: 'low_stock', max_quantity: 2 }),
    ).toContain('2');
    expect(lineMessage(base)).toBeNull();
  });

  it('only fully valid lines can be selected, and checkout is blocked until the selection is adjusted', () => {
    const ok = base;
    const soldOut = {
      ...base,
      id: 'l2',
      availability: 'sold_out' as const,
      max_quantity: 0,
    };
    expect(canSelect(ok)).toBe(true);
    expect(canSelect(soldOut)).toBe(false);
    expect(checkoutBlock([ok, soldOut], new Set(['l1']))).toBeNull();
    expect(checkoutBlock([ok, soldOut], new Set(['l1', 'l2']))).toBe(
      'SELECTION_NEEDS_ADJUSTMENT',
    );
    expect(checkoutBlock([ok, soldOut], new Set())).toBe('NOTHING_SELECTED');
  });
});

describe('Sprint 14 - price change diff', () => {
  it('parses the structured CHECKOUT_PRICE_CHANGED details', () => {
    const summary = parsePriceChange([
      {
        type: 'price_change',
        offer_variant_id: 'v1',
        old_price: 20,
        new_price: 99,
      },
      {
        type: 'delivery_fee_change',
        delivery_window_id: 'w1',
        old_fee: 15,
        new_fee: null,
      },
      { type: 'something_else' },
      'noise',
    ]);
    expect(summary.prices).toEqual([
      { offerVariantId: 'v1', oldPrice: 20, newPrice: 99 },
    ]);
    expect(summary.fees).toEqual([
      { deliveryWindowId: 'w1', oldFee: 15, newFee: null },
    ]);
    expect(hasChanges(summary)).toBe(true);
    expect(hasChanges(parsePriceChange([]))).toBe(false);
  });

  it('shows the direction of a change', () => {
    expect(formatDelta(20, 99)).toBe('+79 ₪');
    expect(formatDelta(50, 45.5)).toBe('-4.5 ₪');
  });
});
