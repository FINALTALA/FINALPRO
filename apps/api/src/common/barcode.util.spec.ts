import {
  generatePlatformProductBarcode,
  generateStoreInventoryBarcode,
} from './barcode.util';

describe('barcode.util', () => {
  // Review-round fix (RB-INV-001): an earlier version truncated to the
  // id's first 10 hex characters before claiming that was "trivially
  // guaranteed unique" - it wasn't. These two ids deliberately share
  // that exact prefix and differ only later in the string, to prove
  // the fix no longer depends on just the first 10 characters.
  const idA = '11111111-1111-1111-1111-111111111111';
  const idB = '11111111-1111-2222-3333-444444444444';

  it('does not collide for two ids sharing the same first 10 hex characters', () => {
    expect(generateStoreInventoryBarcode(idA)).not.toBe(
      generateStoreInventoryBarcode(idB),
    );
    expect(generatePlatformProductBarcode(idA)).not.toBe(
      generatePlatformProductBarcode(idB),
    );
  });

  it('derives the barcode from the FULL id (dashes stripped, uppercased), not a truncated prefix', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(generateStoreInventoryBarcode(id)).toBe(
      'SIB-AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE',
    );
    expect(generatePlatformProductBarcode(id)).toBe(
      'PPB-AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE',
    );
  });

  it('is deterministic - the same id always derives the same barcode', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    expect(generateStoreInventoryBarcode(id)).toBe(
      generateStoreInventoryBarcode(id),
    );
    expect(generatePlatformProductBarcode(id)).toBe(
      generatePlatformProductBarcode(id),
    );
  });
});
