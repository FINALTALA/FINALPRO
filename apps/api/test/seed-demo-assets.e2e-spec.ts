import { execFileSync } from 'child_process';
import { PrismaClient } from '../generated/prisma/client';
import {
  OFFER_ONE_SELLER_SKU,
  VENDOR_ONE,
  VENDOR_TWO,
} from '../scripts/seed-demo.constants';
import { API_ROOT, SeedTestDatabases, runSeedOn } from './helpers/seed-demo-db';

function runAssets(databaseUrl: string): { ok: boolean; output: string } {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.includes('test')) {
    throw new Error(`refusing to run against non-test database "${dbName}"`);
  }
  try {
    const out = execFileSync(
      'npx',
      ['ts-node', '--transpile-only', 'scripts/seed-demo-assets.ts'],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
        timeout: 90_000,
      },
    );
    return { ok: true, output: out.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

describe('Sprint 13 demo assets script', () => {
  const dbs = new SeedTestDatabases('finalpro_seedassets_test');
  const opened: PrismaClient[] = [];

  beforeAll(async () => {
    await dbs.setUp();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(opened.map((p) => p.$disconnect()));
    await dbs.tearDown();
  }, 120_000);

  it('attaches logos, covers, bios and a product image to the demo stores, only where empty, and is a no-op on re-run', async () => {
    const { url, prisma } = await dbs.clone('fill');
    opened.push(prisma);
    expect(runSeedOn(url).ok).toBe(true);

    // A value the owner already set must never be overwritten.
    await prisma.vendor.update({
      where: { slug: VENDOR_TWO.slug },
      data: { logoUrl: '/owner-own-logo.png' },
    });

    const first = runAssets(url);
    expect(first.ok).toBe(true);

    const one = await prisma.vendor.findUniqueOrThrow({
      where: { slug: VENDOR_ONE.slug },
    });
    expect(one.logoUrl).toBe('/demo-assets/store-fashion-house-logo.svg');
    expect(one.coverImageUrl).toBe(
      '/demo-assets/store-fashion-house-cover.svg',
    );
    expect(one.bio).toBeTruthy();

    const two = await prisma.vendor.findUniqueOrThrow({
      where: { slug: VENDOR_TWO.slug },
    });
    expect(two.logoUrl).toBe('/owner-own-logo.png');
    expect(two.coverImageUrl).toBe('/demo-assets/store-style-corner-cover.svg');

    const variant = await prisma.offerVariant.findUniqueOrThrow({
      where: {
        vendorId_sellerSku: {
          vendorId: one.id,
          sellerSku: OFFER_ONE_SELLER_SKU,
        },
      },
      include: { media: true },
    });
    expect(variant.media).toHaveLength(1);
    expect(variant.media[0].kind).toBe('PRIMARY');

    const mediaBefore = await prisma.offerVariantMedia.count();
    const second = runAssets(url);
    expect(second.ok).toBe(true);
    expect(second.output).toContain('untouched');
    expect(await prisma.offerVariantMedia.count()).toBe(mediaBefore);
    const twoAfter = await prisma.vendor.findUniqueOrThrow({
      where: { slug: VENDOR_TWO.slug },
    });
    expect(twoAfter.logoUrl).toBe('/owner-own-logo.png');
  }, 180_000);

  it('skips cleanly when the demo has not been seeded, and refuses a non-local host', async () => {
    const { url, prisma } = await dbs.clone('empty');
    opened.push(prisma);
    const res = runAssets(url);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('run scripts/seed-demo.ts first');
    expect(await prisma.vendor.count()).toBe(0);

    let refused = false;
    try {
      execFileSync(
        'npx',
        ['ts-node', '--transpile-only', 'scripts/seed-demo-assets.ts'],
        {
          cwd: API_ROOT,
          env: {
            ...process.env,
            DATABASE_URL:
              'postgresql://finalpro:pw@production.example.com:5432/finalpro_demo',
          },
          stdio: 'pipe',
          timeout: 90_000,
        },
      );
    } catch (err) {
      refused = true;
      expect(
        ((err as { stderr?: Buffer }).stderr ?? Buffer.from('')).toString(),
      ).toContain('not a recognized local database host');
    }
    expect(refused).toBe(true);
  }, 180_000);
});
