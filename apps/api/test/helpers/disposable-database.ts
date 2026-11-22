/**
 * TB-12.1: no test run may ever write into a real database again.
 * finalpro (the local development database) holds e2e residue from the
 * days the suites ran against it - 1,084 test platform-staff accounts,
 * test stores and the Sprint 19 fixture TB-9 had to repair - because
 * apps/api/.env points DATABASE_URL at finalpro and the Playwright
 * helpers defaulted to its servers.
 *
 * A database is fit for a test run only when BOTH hold:
 *  - its name is not a protected one (finalpro); and
 *  - it carries the disposable-test marker, a database comment set by
 *    whatever created it for testing:
 *      COMMENT ON DATABASE <name> IS 'finalpro:disposable-test';
 * The marker cannot be on finalpro by accident - someone would have to
 * set it there on purpose.
 *
 * Shared by the Jest e2e globalSetup (test/guard-disposable-database.ts)
 * and the Playwright global setup (apps/web/e2e/global-setup.ts).
 */
import {
  DISPOSABLE_TEST_DATABASE_MARKER,
  PROTECTED_DATABASE_NAMES as PROTECTED_NAMES,
  databaseNameFromUrl,
} from '../../src/test-support/disposable-test-marker';

export const DISPOSABLE_DATABASE_MARKER = DISPOSABLE_TEST_DATABASE_MARKER;

/** Database names no test run may use, whatever their comment says (TB-13: one list, in src/test-support). */
export const PROTECTED_DATABASE_NAMES: readonly string[] = PROTECTED_NAMES;

export function databaseNameOf(connectionString: string): string {
  return databaseNameFromUrl(connectionString);
}

/** The SQL that reads the current database's comment (null if none). */
export const DATABASE_COMMENT_SQL =
  "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = current_database()";

/**
 * Throws unless the database is a marked, non-protected test database.
 * `readComment` runs DATABASE_COMMENT_SQL on a connection to it - each
 * caller passes its own client (pg for Jest, Prisma for Playwright).
 */
export async function assertDisposableDatabase(
  connectionString: string | undefined,
  variableName: string,
  readComment: () => Promise<string | null>,
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      `Refusing to run tests: ${variableName} is not set. Point it explicitly at a disposable test database (see apps/web/e2e/README.md).`,
    );
  }
  const name = databaseNameOf(connectionString);
  if (PROTECTED_DATABASE_NAMES.includes(name)) {
    throw new Error(
      `Refusing to run tests: ${variableName} points at "${name}", a protected database. Tests must run on a disposable test database.`,
    );
  }
  const comment = await readComment();
  if (comment !== DISPOSABLE_DATABASE_MARKER) {
    throw new Error(
      `Refusing to run tests: database "${name}" is not marked as a disposable test database. ` +
        `If it really is one, mark it with: COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_DATABASE_MARKER}';`,
    );
  }
}

/** The SQL that reads the current database's name and oid - what the
 * API's test-support identity reports for its own connection. */
export const DATABASE_IDENTITY_SQL =
  'SELECT datname AS name, oid::int AS oid FROM pg_database WHERE datname = current_database()';

/** What GET /test-support/database-identity answers on a test server. */
export interface ApiDatabaseIdentity {
  database: string;
  database_oid: number;
  disposable_test: boolean;
}

/**
 * Throws unless the API is connected to exactly the database the test
 * run seeds directly: same name and same oid (the oid tells apart two
 * databases of the same name in different Postgres servers, as far as
 * one cluster's oids allow), marked, and not a protected one. `identity`
 * is the API's answer, or null when it has no test-support route (a
 * server not started as a test server - finalpro's development API, for
 * one).
 */
export function assertApiUsesSameDatabase(
  identity: ApiDatabaseIdentity | null,
  expected: { name: string; oid: number },
  apiBaseUrl: string,
): void {
  if (!identity) {
    throw new Error(
      `Refusing to run tests: the API at ${apiBaseUrl} does not report its database (no test-support route) - start it as a test server with E2E_TEST_SUPPORT=1, connected to the test database.`,
    );
  }
  if (PROTECTED_DATABASE_NAMES.includes(identity.database)) {
    throw new Error(
      `Refusing to run tests: the API at ${apiBaseUrl} is connected to "${identity.database}", a protected database.`,
    );
  }
  if (!identity.disposable_test) {
    throw new Error(
      `Refusing to run tests: the API at ${apiBaseUrl} is connected to "${identity.database}", which is not marked as a disposable test database.`,
    );
  }
  if (
    identity.database !== expected.name ||
    identity.database_oid !== expected.oid
  ) {
    throw new Error(
      `Refusing to run tests: the API at ${apiBaseUrl} is connected to "${identity.database}" (oid ${identity.database_oid}), not to the test database "${expected.name}" (oid ${expected.oid}) the run seeds directly.`,
    );
  }
}
