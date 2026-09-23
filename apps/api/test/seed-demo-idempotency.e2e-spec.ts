import { PrismaClient } from '../generated/prisma/client';
import { snapshotDemoCounts } from './helpers/seed-demo-snapshot';
import { SeedTestDatabases, runSeedOn } from './helpers/seed-demo-db';

/**
 * Sprint 12: proves scripts/seed-demo.ts's own idempotency claim by
 * actually running the real script (the exact command a developer would
 * type) TWICE and asserting every demo-created row count is identical.
 * Runs against a throwaway "..._test" database - never against the base
 * database in DATABASE_URL, which the seed's guard rightly refuses.
 */
describe('Sprint 12 demo seed idempotency', () => {
  const dbs = new SeedTestDatabases('finalpro_seedidem_test');
  let prisma: PrismaClient;
  let url: string;

  beforeAll(async () => {
    await dbs.setUp();
    ({ prisma, url } = await dbs.clone('run'));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dbs.tearDown();
  });

  it('runs against a database whose name contains "test"', () => {
    expect(new URL(url).pathname).toContain('test');
  });

  it('running the seed script twice produces identical demo-data row counts - no duplication', async () => {
    const first = runSeedOn(url);
    expect(first.ok).toBe(true);
    const afterFirst = await snapshotDemoCounts(prisma);
    for (const value of Object.values(afterFirst)) {
      expect(value).toBeGreaterThan(0);
    }

    const second = runSeedOn(url);
    expect(second.ok).toBe(true);
    const afterSecond = await snapshotDemoCounts(prisma);
    expect(afterSecond).toEqual(afterFirst);
  }, 120_000);
});
