/**
 * Shared local-database guard for the out-of-band demo scripts
 * (seed-demo.ts, seed-demo-assets.ts). Extracted unchanged from
 * seed-demo.ts so both scripts enforce exactly the same host + database
 * name rules.
 */
/**
 * Hosts this script is ever allowed to run against. Deliberately a
 * short, exact allowlist (not a substring/regex check like the
 * database-name check below) - a hostname has no "looks local" middle
 * ground the way a database name does, so there is nothing to
 * pattern-match. "postgres" is this project's own Docker Compose
 * service name (finalyearproject-postgres-1, reachable as "postgres"
 * from any container on the finalyearproject_default network); the
 * others are loopback in every form Node's URL parser produces
 * (IPv4, and IPv6 both bracketed - as the WHATWG URL parser actually
 * returns it - and unbracketed, checked defensively).
 */
const ALLOWED_DATABASE_HOSTS = new Set([
  'postgres',
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Refuses to run against anything that isn't unambiguously a local
 * database - checked BEFORE constructing a PrismaClient or opening any
 * connection, so a misconfigured DATABASE_URL fails immediately and
 * loudly rather than after a real (even if ultimately rejected)
 * network attempt.
 *
 * Round-2 review fix (Codex): the previous version only ever inspected
 * the database NAME (via a naive string split), so
 * "postgresql://user:pass@production.example.com/finalpro_demo" was
 * wrongly accepted - a demo-looking name on a real remote host. Both
 * the HOST and the database name, parsed via the standard URL API, now
 * separately have to pass before this function returns.
 */
export function requireLocalDatabase(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      `Refusing to run: DATABASE_URL ("${connectionString}") could not be ` +
        'parsed as a URL, so its host cannot be verified as local.',
    );
  }

  if (!ALLOWED_DATABASE_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL's host ("${url.hostname}") is not a ` +
        `recognized local database host (allowed: ${[...ALLOWED_DATABASE_HOSTS].join(', ')}). ` +
        'This script seeds clearly-fake demo accounts and data and must ' +
        'never run against a remote or production database.',
    );
  }

  const dbName = url.pathname.replace(/^\//, '');
  // "clean(room)" alongside test/dev/demo/local - this project's own
  // clean-room verification databases (e.g. finalpro_cleanroom_12) are
  // exactly as disposable/local as a "test" or "dev" one.
  const looksLocal = /test|dev|demo|local|clean/i.test(dbName);
  if (!looksLocal) {
    throw new Error(
      `Refusing to run: DATABASE_URL's database name ("${dbName}") does not ` +
        'look like a local/dev/test/demo/clean-room database. This script ' +
        'seeds clearly-fake demo accounts and data and must never run ' +
        'against a real deployment. Point DATABASE_URL at a local database ' +
        'to proceed.',
    );
  }
}
