import { Prisma } from '../../generated/prisma/client';
import { ReturnsService, generateReturnCode } from './returns.service';

// IX-P1 (2026-11-23): the drop-off code comes from crypto, keeps its
// 6-digit format, and a collision with another OPEN code of the store
// (partial unique index returns_active_code_key) is retried with a new code.

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('generateReturnCode (IX-P1)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never uses Math.random and always gives exactly 6 digits', () => {
    const random = jest.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used for a return code');
    });
    const codes = Array.from({ length: 5000 }, () => generateReturnCode());
    expect(random).not.toHaveBeenCalled();
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    // a uniform draw over 1,000,000 values: 5000 draws are almost all distinct
    expect(new Set(codes).size).toBeGreaterThan(4950);
    // leading zeros are kept (the format is a 6-character string)
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
  });
});

describe('createCodeWithRetry (IX-P1)', () => {
  type Updated = { id: string; code: string };
  function fakeTx(failures: number) {
    const codes: string[] = [];
    const statements: string[] = [];
    const tx = {
      $executeRaw: jest.fn((parts: TemplateStringsArray) => {
        statements.push(parts.join('?'));
        return Promise.resolve(0);
      }),
      return: {
        update: jest.fn(
          (args: { data: { code: string } }): Promise<Updated> => {
            codes.push(args.data.code);
            if (codes.length <= failures)
              return Promise.reject(uniqueViolation());
            return Promise.resolve({ id: 'r1', code: args.data.code });
          },
        ),
      },
    };
    return { tx, codes, statements };
  }
  const service = Object.create(ReturnsService.prototype) as {
    createCodeWithRetry: (
      tx: unknown,
      returnId: string,
      validityDays: number,
    ) => Promise<Updated>;
  };

  it('a collision with an open code is retried with a NEW code inside a savepoint', async () => {
    const { tx, codes, statements } = fakeTx(2);
    const out = await service.createCodeWithRetry(tx, 'r1', 7);
    expect(codes).toHaveLength(3);
    expect(out.code).toBe(codes[2]);
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(
      statements.filter((x) => x.includes('ROLLBACK TO SAVEPOINT')),
    ).toHaveLength(2);
    expect(
      statements.filter((x) => x.includes('RELEASE SAVEPOINT')),
    ).toHaveLength(1);
  });

  it('gives up (throws) after the maximum attempts - never saves a duplicate', async () => {
    const { tx, codes } = fakeTx(1000);
    await expect(
      service.createCodeWithRetry(tx, 'r1', 7),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(codes).toHaveLength(10);
  });
});
