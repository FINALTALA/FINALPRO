import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PrismaClient } from '../generated/prisma/client';
import {
  BRANCH_ONE_A_NAME,
  BRANCH_ONE_B_NAME,
  BRANCH_TWO_A_NAME,
  DEMO,
} from '../scripts/seed-demo.constants';
import { API_ROOT, SeedTestDatabases, runSeedOn } from './helpers/seed-demo-db';

// VIA Control Center phase 1: newly created demo fixtures carry
// consistent review decisions - a decided branch / warehouse evidence
// names the platform reviewer who decided it (never a store member) and
// when; a pending one has every decision field null. Also: two equal
// PLATFORM_ADMIN accounts, one of them without a CustomerProfile.

// Same derivation as scripts/seed-scenarios.ts's id(key).
const id = (key: string) => {
  const h = createHash('sha256')
    .update(`finalpro-scenarios-v1:${key}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function runScenarios(databaseUrl: string, cwd: string): string {
  // seed-scenarios writes docs/demo-scenarios.json relative to its cwd:
  // a temporary folder, never the repository's own file.
  return execFileSync(
    process.execPath,
    [
      require.resolve('ts-node/dist/bin.js'),
      '--transpile-only',
      '--project',
      path.join(API_ROOT, 'tsconfig.json'),
      path.join(API_ROOT, 'scripts/seed-scenarios.ts'),
    ],
    {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 120_000,
    },
  ).toString();
}

describe('VIA admin phase 1 - seed review fixtures (e2e)', () => {
  const dbs = new SeedTestDatabases('finalpro_seedreview_test');
  let prisma: PrismaClient;
  let url: string;
  let outDir: string;

  beforeAll(async () => {
    await dbs.setUp();
    ({ prisma, url } = await dbs.clone('run'));
    outDir = mkdtempSync(path.join(os.tmpdir(), 'seed-review-'));
    mkdirSync(path.join(outDir, 'docs'));
    const demo = runSeedOn(url);
    if (!demo.ok) throw new Error(`seed-demo failed:\n${demo.output}`);
    runScenarios(url, outDir);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dbs.tearDown();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  }, 120_000);

  it('seed-demo creates its reviewer as platform staff and names it on every branch it creates approved', async () => {
    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { phone: DEMO.reviewer.phone },
      include: { customerProfile: true, vendorUsers: true },
    });
    expect(reviewer.platformRole).toBe('VERIFICATION_REVIEWER');
    expect(reviewer.customerProfile).toBeNull();
    expect(reviewer.vendorUsers).toHaveLength(0);

    const branches = await prisma.storeBranch.findMany({
      where: {
        name: { in: [BRANCH_ONE_A_NAME, BRANCH_ONE_B_NAME, BRANCH_TWO_A_NAME] },
      },
    });
    expect(branches).toHaveLength(3);
    for (const b of branches) {
      expect(b.verificationStatus).toBe('APPROVED');
      expect(b.reviewedBy).toBe(reviewer.id);
      expect(b.reviewedAt).toBeInstanceOf(Date);
    }
  });

  it('seed-scenarios keeps its fixture ids and records review decisions consistently', async () => {
    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { phone: '+970560000005' },
      include: { vendorUsers: true },
    });
    expect(reviewer.platformRole).toBe('VERIFICATION_REVIEWER');
    expect(reviewer.vendorUsers).toHaveLength(0);

    const branch = (key: string) =>
      prisma.storeBranch.findUniqueOrThrow({ where: { id: id(key) } });

    // The ids the spec pins, unchanged.
    expect(id('verification:PENDING')).toBe(
      '3ccc5ac7-3a68-4688-a86e-5a28267077d7',
    );
    expect(id('branch:approved')).toBe('ff99db74-1843-44de-a257-681ee5681311');

    const pending = await branch('verification:PENDING');
    expect(pending.name).toBe('اختبار التحقق PENDING');
    expect(pending.verificationStatus).toBe('PENDING');
    expect(pending.reviewedBy).toBeNull();
    expect(pending.reviewedAt).toBeNull();
    expect(pending.reviewNote).toBeNull();

    for (const status of ['REJECTED', 'RESUBMISSION_REQUESTED', 'APPROVED']) {
      const b = await branch(`verification:${status}`);
      expect(b.verificationStatus).toBe(status);
      expect(b.reviewedBy).toBe(reviewer.id);
      expect(b.reviewedAt).toBeInstanceOf(Date);
      expect(b.reviewNote === null).toBe(status === 'APPROVED');
    }

    // The APPROVED store's branch passed verification.
    const approved = await branch('branch:approved');
    expect(approved.name).toBe('فرع اختبار approved');
    expect(approved.verificationStatus).toBe('APPROVED');
    expect(approved.reviewedBy).toBe(reviewer.id);
    expect(approved.evidenceSubmittedAt).toBeInstanceOf(Date);

    for (const key of ['closed-branch', 'archived-branch']) {
      const b = await branch(key);
      expect(b.verificationStatus).toBe('APPROVED');
      expect(b.reviewedBy).toBe(reviewer.id);
      expect(b.reviewedAt).toBeInstanceOf(Date);
    }
    expect((await branch('closed-branch')).name).toBe('فرع مغلق مؤقتا');
    expect((await branch('archived-branch')).name).toBe('فرع مؤرشف');

    // Not yet submitted: no evidence and no decision.
    const applied = await branch('branch:applied');
    expect(applied.verificationStatus).toBe('PENDING');
    expect(applied.evidenceSubmittedAt).toBeNull();
    expect(applied.reviewedBy).toBeNull();
  });

  it('ONLINE_ONLY is verified by warehouse evidence (no branch decision); HYBRID by both', async () => {
    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { phone: '+970560000005' },
    });
    const online = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: id('branch:online') },
    });
    expect(online.isPhysical).toBe(false);
    expect(online.reviewedBy).toBeNull();
    expect(online.evidenceSubmittedAt).toBeNull();

    const hybrid = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: id('branch:hybrid') },
    });
    expect(hybrid.isPhysical).toBe(true);
    expect(hybrid.verificationStatus).toBe('APPROVED');
    expect(hybrid.reviewedBy).toBe(reviewer.id);

    for (const key of ['online', 'hybrid']) {
      const evidence =
        await prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: id(`warehouse-evidence:${key}`) },
        });
      expect(evidence.vendorId).toBe(id(`store:${key}`));
      expect(evidence.status).toBe('APPROVED');
      expect(evidence.reviewedBy).toBe(reviewer.id);
      expect(evidence.reviewedAt).toBeInstanceOf(Date);
    }
  });

  it('two equal PLATFORM_ADMIN accounts, the second without a CustomerProfile', async () => {
    const admins = await prisma.user.findMany({
      where: { phone: { in: ['+970560000004', '+970560000009'] } },
      include: { customerProfile: true },
      orderBy: { phone: 'asc' },
    });
    expect(admins.map((a) => a.platformRole)).toEqual([
      'PLATFORM_ADMIN',
      'PLATFORM_ADMIN',
    ]);
    expect(admins[1].customerProfile).toBeNull();
    const out = JSON.parse(
      readFileSync(path.join(outDir, 'docs/demo-scenarios.json'), 'utf8'),
    );
    expect(out.accounts.map((a: { phone: string }) => a.phone)).toContain(
      '+970560000009',
    );
  });

  it('re-running both seeds adds nothing and changes no decision', async () => {
    const before = await prisma.storeBranch.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, reviewedBy: true, reviewedAt: true },
    });
    expect(runSeedOn(url).ok).toBe(true);
    runScenarios(url, outDir);
    const after = await prisma.storeBranch.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, reviewedBy: true, reviewedAt: true },
    });
    expect(after).toEqual(before);
  }, 240_000);
});
