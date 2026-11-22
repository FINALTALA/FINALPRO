import {
  assertApiUsesSameDatabase,
  assertDisposableDatabase,
  databaseNameOf,
  DISPOSABLE_DATABASE_MARKER,
} from './helpers/disposable-database';

// TB-12.1: the rule both test runners' guards apply (Jest's globalSetup
// and Playwright's global setup). Pure - no database is touched here;
// the runners themselves are proven against real databases separately.
describe('TB-12.1 disposable test database guard', () => {
  const url = (name: string) =>
    `postgresql://u:p@127.0.0.1:5433/${name}?schema=public`;
  const marked = jest.fn(async () => DISPOSABLE_DATABASE_MARKER);

  beforeEach(() => marked.mockClear());

  it('reads the database name from the URL', () => {
    expect(databaseNameOf(url('pwcheck'))).toBe('pwcheck');
    expect(databaseNameOf(url('finalpro'))).toBe('finalpro');
    expect(() => databaseNameOf('not a url')).toThrow(/could not be parsed/);
  });

  it('refuses a missing URL', async () => {
    await expect(
      assertDisposableDatabase(undefined, 'DATABASE_URL', marked),
    ).rejects.toThrow(/DATABASE_URL is not set/);
    expect(marked).not.toHaveBeenCalled();
  });

  it('refuses finalpro by name - even if someone marked it - without ever connecting to it', async () => {
    await expect(
      assertDisposableDatabase(url('finalpro'), 'DATABASE_URL', marked),
    ).rejects.toThrow(/"finalpro", a protected database/);
    expect(marked).not.toHaveBeenCalled();
  });

  it.each([
    ['no comment', null],
    ['another comment', 'dev data - keep'],
    ['a near miss', `${DISPOSABLE_DATABASE_MARKER} `],
  ])('refuses a database with %s', async (_label, comment) => {
    await expect(
      assertDisposableDatabase(
        url('scratch'),
        'PW_DATABASE_URL',
        async () => comment,
      ),
    ).rejects.toThrow(/"scratch" is not marked as a disposable test database/);
  });

  it('accepts a marked test database', async () => {
    await expect(
      assertDisposableDatabase(url('pwcheck'), 'PW_DATABASE_URL', marked),
    ).resolves.toBeUndefined();
    expect(marked).toHaveBeenCalledTimes(1);
  });

  // The Playwright guard's second half: the API must be connected to
  // the very database the run seeds directly.
  describe('API connected to the same database', () => {
    const api = 'http://localhost:3002/api/v1';
    const expected = { name: 'pwcheck', oid: 41_000 };
    const identity = (over: Record<string, unknown> = {}) => ({
      database: 'pwcheck',
      database_oid: 41_000,
      disposable_test: true,
      ...over,
    });

    it('accepts the same marked database', () => {
      expect(() =>
        assertApiUsesSameDatabase(identity(), expected, api),
      ).not.toThrow();
    });

    it.each([
      [
        'an API with no test-support route',
        null,
        /does not report its database/,
      ],
      [
        'an API connected to finalpro',
        identity({ database: 'finalpro', disposable_test: false }),
        /connected to "finalpro", a protected database/,
      ],
      [
        'an API connected to finalpro even if it claims the marker',
        identity({ database: 'finalpro', disposable_test: true }),
        /a protected database/,
      ],
      [
        'an API connected to an unmarked database',
        identity({ database: 'scratch', disposable_test: false }),
        /"scratch", which is not marked/,
      ],
      [
        'an API connected to another marked test database',
        identity({ database: 'othercheck', database_oid: 42_000 }),
        /connected to "othercheck" \(oid 42000\), not to the test database "pwcheck"/,
      ],
      [
        'a same-named database that is not the same one (oid differs)',
        identity({ database_oid: 99_999 }),
        /not to the test database "pwcheck" \(oid 41000\)/,
      ],
    ])('refuses %s', (_label, answer, message) => {
      expect(() =>
        assertApiUsesSameDatabase(
          answer as Parameters<typeof assertApiUsesSameDatabase>[0],
          expected,
          api,
        ),
      ).toThrow(message);
    });
  });
});
