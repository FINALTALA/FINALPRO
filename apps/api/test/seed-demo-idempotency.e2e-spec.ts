import { execFileSync } from 'child_process';
import * as path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { snapshotDemoCounts } from './helpers/seed-demo-snapshot';

const API_ROOT = path.resolve(__dirname, '..');

/**
 * Sprint 12: proves scripts/seed-demo.ts's own idempotency claim by
 * actually running the real script (not an imported function - the
 * exact command a developer would type) TWICE against a real database,
 * and asserting every demo-created row count is identical after both
 * runs.
 */
describe('Sprint 12 demo seed idempotency', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set for this test run');
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('running the seed script twice produces identical demo-data row counts - no duplication', async () => {
    const runSeed = () =>
      execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
        cwd: API_ROOT,
        env: process.env,
        stdio: 'pipe',
      });

    runSeed();
    const afterFirst = await snapshotDemoCounts(prisma);
    for (const value of Object.values(afterFirst)) {
      expect(value).toBeGreaterThan(0);
    }

    runSeed();
    const afterSecond = await snapshotDemoCounts(prisma);
    expect(afterSecond).toEqual(afterFirst);
  }, 120_000);
});
