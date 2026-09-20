import { Prisma } from '../../../generated/prisma/client';
import { isExpectedOfferVariantConflict } from './expected-offer-variant-conflict';

function p2002(index?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta:
      index === undefined
        ? {}
        : { driverAdapterError: { cause: { constraint: { index } } } },
  });
}

describe('isExpectedOfferVariantConflict', () => {
  it('is true for the seller_sku unique constraint', () => {
    expect(
      isExpectedOfferVariantConflict(
        p2002('offer_variants_vendorId_sellerSku_key'),
      ),
    ).toBe(true);
  });

  it('is true for the store_inventory_barcode unique constraint', () => {
    expect(
      isExpectedOfferVariantConflict(
        p2002('offer_variants_vendorId_storeInventoryBarcode_key'),
      ),
    ).toBe(true);
  });

  it('is false for a P2002 on a different constraint (e.g. ImportIdentifierRecord) - must be re-thrown, not swallowed', () => {
    expect(
      isExpectedOfferVariantConflict(
        p2002('import_identifier_records_vendor_identifier_key'),
      ),
    ).toBe(false);
  });

  it('is false for a P2002 with no readable constraint name at all - must be re-thrown, not guessed', () => {
    expect(isExpectedOfferVariantConflict(p2002())).toBe(false);
  });

  it('is false for a non-P2002 error', () => {
    expect(isExpectedOfferVariantConflict(new Error('db exploded'))).toBe(
      false,
    );
  });

  it('is false for a P2002 whose meta shape is not the expected nested driver-adapter shape', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['sellerSku'] },
      },
    );
    expect(isExpectedOfferVariantConflict(err)).toBe(false);
  });
});
