/** TB-12.1: the comment a disposable test database carries - set by
 * whatever creates it for testing, never on finalpro. Dependency-free
 * so the test runners' guards (Jest and Playwright) can import it too. */
export const DISPOSABLE_TEST_DATABASE_MARKER = 'finalpro:disposable-test';

/** TB-13: database names no test run may use or drop, whatever their
 * comment says - matched exactly, never by pattern. */
export const PROTECTED_DATABASE_NAMES: readonly string[] = ['finalpro'];

/** The database name in a connection string (throws if it cannot be parsed). */
export function databaseNameFromUrl(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run tests: the database URL could not be parsed, so the database cannot be verified as a disposable test database.',
    );
  }
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

export function isProtectedDatabaseName(name: string): boolean {
  return PROTECTED_DATABASE_NAMES.includes(name);
}
