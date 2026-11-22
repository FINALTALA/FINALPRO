import { Client } from 'pg';
import {
  assertDisposableDatabase,
  DATABASE_COMMENT_SQL,
} from './helpers/disposable-database';

// TB-12.1: the e2e suite's globalSetup - runs once before any e2e spec
// file and stops the whole run unless DATABASE_URL is a marked,
// non-protected test database (see helpers/disposable-database.ts).
// apps/api/.env points at finalpro, so a run that forgets to override
// DATABASE_URL now fails here instead of writing into it.
export default async function guardDisposableDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  await assertDisposableDatabase(connectionString, 'DATABASE_URL', async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const res = await client.query<{ comment: string | null }>(
        DATABASE_COMMENT_SQL,
      );
      return res.rows[0]?.comment ?? null;
    } finally {
      await client.end();
    }
  });
}
