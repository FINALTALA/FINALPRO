import { Client } from 'pg';
import {
  DISPOSABLE_TEST_DATABASE_MARKER,
  isProtectedDatabaseName,
} from '../../src/test-support/disposable-test-marker';

/**
 * TB-13: the one way a test creates or drops a database of its own.
 *
 *  - create: always leaves the disposable-test marker on the new
 *    database (COMMENT ON DATABASE ... IS 'finalpro:disposable-test'),
 *    so every database a test makes is recognisable as one;
 *  - drop: only after reading THAT database's own comment and finding
 *    the marker - a database without it is refused, and a protected name
 *    (exactly "finalpro") is refused whatever its comment says. Never by
 *    a pattern in the name.
 *
 * `adminUrl` is the connection used to issue CREATE/DROP DATABASE - in
 * the e2e suites, the shared test database the globalSetup guard has
 * already verified. Names are restricted to [A-Za-z0-9_] (they are
 * interpolated as quoted identifiers).
 */

const NAME = /^[A-Za-z0-9_]{1,63}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `Refusing: "${name}" is not a valid test database name ([A-Za-z0-9_], up to 63 characters).`,
    );
  }
  if (isProtectedDatabaseName(name)) {
    throw new Error(
      `Refusing: "${name}" is a protected database - no test may create, use or drop it.`,
    );
  }
}

/** The URL of `name` on the same server as `adminUrl`. */
export function testDatabaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(
  adminUrl: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The comment on database `name`, or `undefined` when it does not exist. */
export async function databaseComment(
  adminUrl: string,
  name: string,
): Promise<string | null | undefined> {
  return withAdmin(adminUrl, async (c) => {
    const r = await c.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [name],
    );
    return r.rows.length === 0 ? undefined : r.rows[0].comment;
  });
}

/**
 * Drops `name` only if it carries the disposable-test marker. Returns
 * 'absent' when there is nothing to drop; throws (and drops nothing) for
 * a protected name or a database without the marker.
 */
export async function dropDisposableDatabase(
  adminUrl: string,
  name: string,
): Promise<'dropped' | 'absent'> {
  checkName(name);
  return withAdmin(adminUrl, async (c) => {
    const r = await c.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [name],
    );
    if (r.rows.length === 0) return 'absent';
    if (r.rows[0].comment !== DISPOSABLE_TEST_DATABASE_MARKER) {
      throw new Error(
        `Refusing to drop database "${name}": it does not carry the disposable-test marker, so it is not known to be a test database.`,
      );
    }
    await c.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    return 'dropped';
  });
}

/**
 * Creates `name` (from `template` when given), marked as a disposable
 * test database, and returns its URL. A leftover database of the same
 * name is dropped first - only if it carries the marker (otherwise this
 * throws and nothing is touched).
 */
export async function createDisposableDatabase(
  adminUrl: string,
  name: string,
  options: { template?: string } = {},
): Promise<string> {
  checkName(name);
  if (options.template) checkName(options.template);
  await dropDisposableDatabase(adminUrl, name);
  await withAdmin(adminUrl, async (c) => {
    await c.query(
      `CREATE DATABASE "${name}"${options.template ? ` TEMPLATE "${options.template}"` : ''}`,
    );
    await c.query(
      `COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_TEST_DATABASE_MARKER}'`,
    );
  });
  return testDatabaseUrl(adminUrl, name);
}
