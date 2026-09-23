import { execFileSync } from 'child_process';
import { PrismaClient } from '../generated/prisma/client';
import {
  DEMO,
  VENDOR_ONE,
  OFFER_ONE_SELLER_SKU,
} from '../scripts/seed-demo.constants';
import { snapshotDemoCounts } from './helpers/seed-demo-snapshot';
import { API_ROOT, SeedTestDatabases, runSeedOn } from './helpers/seed-demo-db';

function runSeedWithRawUrl(databaseUrl: string): {
  ok: boolean;
  output: string;
} {
  try {
    const out = execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 90_000,
    });
    return { ok: true, output: out.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

/**
 * Sprint 12 round-2 safety tests for scripts/seed-demo.ts: the
 * host/database-name guard and the preflight-before-any-write conflict
 * detection. Every scenario that touches data runs against its own
 * throwaway "..._test" database; the base database in DATABASE_URL is
 * never seeded or modified.
 */
describe('Sprint 12 demo seed safety', () => {
  const dbs = new SeedTestDatabases('finalpro_seedsafety_test');
  const opened: PrismaClient[] = [];

  async function scenario(name: string) {
    const db = await dbs.clone(name);
    opened.push(db.prisma);
    expect(new URL(db.url).pathname).toContain('test');
    return db;
  }

  beforeAll(async () => {
    await dbs.setUp();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(opened.map((p) => p.$disconnect()));
    await dbs.tearDown();
  }, 120_000);

  it('rejects a remote host with a demo-looking database name before any connection or write', () => {
    const result = runSeedWithRawUrl(
      'postgresql://finalpro:pw@production.example.com:5432/finalpro_demo?schema=public',
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('production.example.com');
    expect(result.output).toContain('not a recognized local database host');
    // A real connection attempt would surface DNS/TCP errors - this must
    // be the guard's own message, raised before any PrismaClient exists.
    expect(result.output).not.toMatch(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/);
  }, 120_000);

  it('rejects a local host whose database name does not look local/demo', () => {
    const result = runSeedWithRawUrl(
      'postgresql://finalpro:pw@localhost:5432/finalpro?schema=public',
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('database name');
  }, 120_000);

  it('fails with DEMO_SEED_CONFLICT on a late conflict, leaving the conflicting row and all other demo data untouched', async () => {
    const { url, prisma } = await scenario('late_conflict');
    expect(runSeedOn(url).ok).toBe(true);

    const vendor = await prisma.vendor.findUniqueOrThrow({
      where: { slug: VENDOR_ONE.slug },
    });
    const variant = await prisma.offerVariant.findUniqueOrThrow({
      where: {
        vendorId_sellerSku: {
          vendorId: vendor.id,
          sellerSku: OFFER_ONE_SELLER_SKU,
        },
      },
    });

    // Conflict deep in the dependency chain (offer variant), so every
    // earlier preflight check passes first - proves a LATE conflict
    // still aborts before any write.
    await prisma.offerVariant.update({
      where: { id: variant.id },
      data: { basePrice: 999.99 },
    });

    const before = await snapshotDemoCounts(prisma);
    const result = runSeedOn(url);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('DEMO_SEED_CONFLICT');

    const after = await prisma.offerVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.basePrice.toNumber()).toBe(999.99);
    expect(await snapshotDemoCounts(prisma)).toEqual(before);
  }, 180_000);

  it('fails with DEMO_SEED_CONFLICT when a demo account has a different password, without modifying it or creating anything', async () => {
    const { url, prisma } = await scenario('password_conflict');
    expect(runSeedOn(url).ok).toBe(true);

    const owner = await prisma.user.findUniqueOrThrow({
      where: { phone: DEMO.owner.phone },
    });
    const foreignHash =
      '$2a$10$abcdefghijklmnopqrstuuJ8Z1p6w0e1f9C2m3n4o5p6q7r8s9t0u';
    await prisma.user.update({
      where: { id: owner.id },
      data: { passwordHash: foreignHash },
    });

    const before = await snapshotDemoCounts(prisma);
    const result = runSeedOn(url);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('DEMO_SEED_CONFLICT');
    expect(await snapshotDemoCounts(prisma)).toEqual(before);
    const still = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(still.passwordHash).toBe(foreignHash);
  }, 180_000);
});
