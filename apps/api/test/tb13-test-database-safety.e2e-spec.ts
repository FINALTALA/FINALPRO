import { Client } from 'pg';
import { PrismaService } from './../src/prisma/prisma.service';
import { DISPOSABLE_TEST_DATABASE_MARKER } from './../src/test-support/disposable-test-marker';
import {
  createDisposableDatabase,
  databaseComment,
  dropDisposableDatabase,
  testDatabaseUrl,
} from './helpers/test-databases';

// TB-13: every database a test creates is marked; a database is dropped
// only after its own marker is read - "finalpro" (exact name) and any
// unmarked database are refused, never decided by a name pattern; and
// the app itself refuses an unmarked or protected database under
// NODE_ENV=test before anything can write to it.
describe('TB-13 test database safety (e2e)', () => {
  const adminUrl = process.env.DATABASE_URL!;
  const name = (label: string) => `finalpro_tb13_${label}_test_${process.pid}`;

  async function sql(query: string) {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(query);
    } finally {
      await c.end();
    }
  }

  it('createDisposableDatabase leaves the marker; dropDisposableDatabase removes it; dropping again is "absent"', async () => {
    const db = name('create');
    const url = await createDisposableDatabase(adminUrl, db);
    expect(url).toBe(testDatabaseUrl(adminUrl, db));
    expect(await databaseComment(adminUrl, db)).toBe(
      DISPOSABLE_TEST_DATABASE_MARKER,
    );
    expect(await dropDisposableDatabase(adminUrl, db)).toBe('dropped');
    expect(await databaseComment(adminUrl, db)).toBeUndefined();
    expect(await dropDisposableDatabase(adminUrl, db)).toBe('absent');
  });

  it('a database without the marker is never dropped - even with a test-looking name - and create refuses to replace it', async () => {
    const db = name('unmarked');
    await sql(`CREATE DATABASE "${db}"`);
    try {
      await expect(dropDisposableDatabase(adminUrl, db)).rejects.toThrow(
        /does not carry the disposable-test marker/,
      );
      await expect(createDisposableDatabase(adminUrl, db)).rejects.toThrow(
        /does not carry the disposable-test marker/,
      );
      expect(await databaseComment(adminUrl, db)).toBeNull(); // still there, untouched
    } finally {
      // This test's own database: marked here only so the helper may remove it.
      await sql(
        `COMMENT ON DATABASE "${db}" IS '${DISPOSABLE_TEST_DATABASE_MARKER}'`,
      );
      await dropDisposableDatabase(adminUrl, db);
    }
  });

  it('"finalpro" is refused by name before any connection, by create and by drop; a template of that name too', async () => {
    // An unreachable admin URL: a connection attempt would fail differently.
    const unreachable = 'postgresql://u:p@203.0.113.1:5432/x';
    await expect(
      dropDisposableDatabase(unreachable, 'finalpro'),
    ).rejects.toThrow(/protected database/);
    await expect(
      createDisposableDatabase(unreachable, 'finalpro'),
    ).rejects.toThrow(/protected database/);
    await expect(
      createDisposableDatabase(unreachable, name('t'), {
        template: 'finalpro',
      }),
    ).rejects.toThrow(/protected database/);
    await expect(
      dropDisposableDatabase(unreachable, 'bad"name'),
    ).rejects.toThrow(/not a valid test database name/);
  });

  it('the app refuses an unmarked database under NODE_ENV=test before it can be used, and accepts a marked one', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const unmarked = name('appunmarked');
    const marked = name('appmarked');
    await sql(`CREATE DATABASE "${unmarked}"`);
    await createDisposableDatabase(adminUrl, marked);
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = testDatabaseUrl(adminUrl, unmarked);
      const refused = new PrismaService();
      await expect(refused.onModuleInit()).rejects.toThrow(
        /not marked as a disposable test database/,
      );

      process.env.DATABASE_URL = testDatabaseUrl(adminUrl, marked);
      const accepted = new PrismaService();
      await expect(accepted.onModuleInit()).resolves.toBeUndefined();
      await accepted.$disconnect();

      process.env.DATABASE_URL = testDatabaseUrl(adminUrl, 'finalpro');
      expect(() => new PrismaService()).toThrow(/protected database/);
    } finally {
      process.env.DATABASE_URL = saved;
      await sql(
        `COMMENT ON DATABASE "${unmarked}" IS '${DISPOSABLE_TEST_DATABASE_MARKER}'`,
      );
      await dropDisposableDatabase(adminUrl, unmarked);
      await dropDisposableDatabase(adminUrl, marked);
    }
  });
});
