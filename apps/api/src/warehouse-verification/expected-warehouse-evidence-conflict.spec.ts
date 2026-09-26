import { Prisma } from '../../generated/prisma/client';
import { isExpectedWarehouseEvidencePendingConflict } from './expected-warehouse-evidence-conflict';

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

describe('isExpectedWarehouseEvidencePendingConflict', () => {
  it('is true for the partial pending-evidence unique index', () => {
    expect(
      isExpectedWarehouseEvidencePendingConflict(
        p2002('warehouse_verification_evidence_vendor_pending_key'),
      ),
    ).toBe(true);
  });

  it('is false for a P2002 on a different constraint name - must be re-thrown, not swallowed', () => {
    expect(
      isExpectedWarehouseEvidencePendingConflict(
        p2002('staff_invites_vendor_phone_pending_key'),
      ),
    ).toBe(false);
  });

  it('is false for a P2002 with no readable constraint name at all - must be re-thrown, not guessed', () => {
    expect(isExpectedWarehouseEvidencePendingConflict(p2002())).toBe(false);
  });

  it('is false for a non-P2002 error', () => {
    expect(
      isExpectedWarehouseEvidencePendingConflict(new Error('db exploded')),
    ).toBe(false);
  });

  it('is false for a P2002 whose meta shape is not the expected nested driver-adapter shape', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['vendorId'] },
      },
    );
    expect(isExpectedWarehouseEvidencePendingConflict(err)).toBe(false);
  });
});
