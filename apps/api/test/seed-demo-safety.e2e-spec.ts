import { execFileSync } from 'child_process';
import * as path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  DEMO,
  VENDOR_ONE,
  OFFER_ONE_SELLER_SKU,
} from '../scripts/seed-demo.constants';
import { snapshotDemoCounts } from './helpers/seed-demo-snapshot';

const API_ROOT = path.resolve(__dirname, '..');

interface SeedRun {
  ok: boolean;
  output: string;
  elapsedMs: number;
}

function runSeed(env: NodeJS.ProcessEnv): SeedRun {
  const start = Date.now();
  try {
    const stdout = execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
      cwd: API_ROOT,
      env,
      stdio: 'pipe',
      timeout: 90_000,
    });
    return {
      ok: true,
      output: stdout.toString(),
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
      elapsedMs: Date.now() - start,
    };
  }
}

/**
 * Sprint 12 round-2 safety tests for scripts/seed-demo.ts: the
 * host/database-name guard and the preflight-before-any-write conflict
 * detection. Both run the real script as a subprocess.
 */
describe('Sprint 12 demo seed safety', () => {
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

  it('rejects a remote host with a demo-looking database name before any connection or write', async () => {
    const before = await snapshotDemoCounts(prisma);
    const result = runSeed({
      ...process.env,
      DATABASE_URL:
        'postgresql://finalpro:pw@production.example.com:5432/finalpro_demo?schema=public',
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('production.example.com');
    expect(result.output).toContain('not a recognized local database host');
    // A real connection attempt to a remote host would fail via DNS/TCP
    // errors (Prisma/pg error text) - this must be the guard's own
    // message, raised before any PrismaClient exists.
    expect(result.output).not.toMatch(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/);
    expect(await snapshotDemoCounts(prisma)).toEqual(before);
  }, 120_000);

  it('rejects a local host whose database name does not look local/demo', () => {
    const result = runSeed({
      ...process.env,
      DATABASE_URL:
        'postgresql://finalpro:pw@localhost:5432/finalpro?schema=public',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('database name');
  }, 120_000);

  it('fails with DEMO_SEED_CONFLICT on a late conflict, leaving the conflicting row and all other demo data untouched', async () => {
    // Make sure the full demo exists first (idempotent no-op if so).
    const first = runSeed(process.env);
    expect(first.ok).toBe(true);

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
    const originalPrice = variant.basePrice.toNumber();

    // Conflict deep in the dependency chain (offer variant), so every
    // earlier preflight check passes first - proves a LATE conflict
    // still aborts before any write.
    await prisma.offerVariant.update({
      where: { id: variant.id },
      data: { basePrice: 999.99 },
    });

    try {
      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(process.env);

      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');

      const after = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(after.basePrice.toNumber()).toBe(999.99);
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
    } finally {
      await prisma.offerVariant.update({
        where: { id: variant.id },
        data: { basePrice: originalPrice },
      });
    }
  }, 180_000);

  it('fails with DEMO_SEED_CONFLICT when a demo account has a different password, without modifying it or creating anything', async () => {
    expect(runSeed(process.env).ok).toBe(true);
    const owner = await prisma.user.findUniqueOrThrow({
      where: { phone: DEMO.owner.phone },
    });
    const originalHash = owner.passwordHash;
    const foreignHash =
      '$2a$10$abcdefghijklmnopqrstuuJ8Z1p6w0e1f9C2m3n4o5p6q7r8s9t0u';
    await prisma.user.update({
      where: { id: owner.id },
      data: { passwordHash: foreignHash },
    });
    try {
      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(process.env);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
      const still = await prisma.user.findUniqueOrThrow({
        where: { id: owner.id },
      });
      expect(still.passwordHash).toBe(foreignHash);
    } finally {
      await prisma.user.update({
        where: { id: owner.id },
        data: { passwordHash: originalHash },
      });
    }
  }, 180_000);
});
