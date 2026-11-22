import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Redis from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { runBootstrap } from '../scripts/bootstrap-platform-alert-recipients';
import {
  idsSha256,
  redisLiveSessions,
  runRevoke,
  RevokeRule,
} from '../scripts/revoke-test-staff';
import { AuditLogService } from '../src/audit/audit-log.service';
import { PlatformAlertRecipientsService } from '../src/platform-alerts/platform-alert-recipients.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';

// TB-12.4: the two CLIs that put finalpro's alerts and staff roles in
// order - the explicit first alert-recipient bootstrap and the
// revocation of the e2e test accounts' platform roles (dry-run, the
// approved list only, all-or-nothing, restorable). Both write ids and
// roles to the audit trail, never a phone number.
describe('TB-12.4 staff scripts (e2e)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let dir: string;
  const created: string[] = [];
  let seq = 0;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg(process.env.DATABASE_URL!),
    });
    redis = new Redis(process.env.REDIS_URL!);
    dir = mkdtempSync(join(tmpdir(), 'tb12-4-'));
  });

  afterAll(async () => {
    await prisma.platformAlertRecipient.deleteMany({
      where: { userId: { in: created } },
    });
    await prisma.$disconnect();
    await redis.quit();
    rmSync(dir, { recursive: true, force: true });
  });

  async function user(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null,
    extra: { createdAt?: Date; deactivatedAt?: Date } = {},
  ) {
    seq += 1;
    const phone = `+97056${String((Date.now() + seq * 7919) % 1e7).padStart(7, '0')}`;
    const u = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
        ...extra,
      },
    });
    created.push(u.id);
    return u;
  }

  async function bootstrap(argv: string[]) {
    const lines: string[] = [];
    const code = await runBootstrap(argv, prisma, (l) => lines.push(l));
    return { code, out: lines.join('\n') };
  }

  const auditsFor = (entityId: string, action?: string) =>
    prisma.auditLog.findMany({
      where: { entityId, ...(action ? { action } : {}) },
      orderBy: { occurredAt: 'asc' },
    });

  describe('bootstrap-platform-alert-recipients', () => {
    it('dry-run reports and writes nothing', async () => {
      const admin = await user('PLATFORM_ADMIN');
      const { code, out } = await bootstrap(['--user', admin.id]);
      expect(code).toBe(0);
      expect(out).toContain('active PLATFORM_ADMIN');
      expect(out).toContain('ORDER_INTEGRITY: to subscribe');
      expect(out).toContain('RETURN_ESCALATION: to subscribe');
      expect(out).not.toContain(admin.phone);
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: admin.id },
        }),
      ).toBe(0);
      expect(await auditsFor(admin.id)).toHaveLength(0);
    });

    it.each([
      ['a customer', () => user(null)],
      ['a reviewer', () => user('VERIFICATION_REVIEWER')],
      [
        'a deactivated administrator',
        () => user('PLATFORM_ADMIN', { deactivatedAt: new Date() }),
      ],
    ])('refuses %s, writing nothing', async (_label, make) => {
      const target = await make();
      const actor = await user('PLATFORM_ADMIN');
      const { code } = await bootstrap([
        '--apply',
        '--user',
        target.id,
        '--actor',
        actor.id,
      ]);
      expect(code).toBe(2);
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: target.id },
        }),
      ).toBe(0);
      expect(await auditsFor(target.id)).toHaveLength(0);
    });

    it('refuses an unknown user and a non-administrator actor', async () => {
      const admin = await user('PLATFORM_ADMIN');
      expect(
        (
          await bootstrap([
            '--apply',
            '--user',
            randomUUID(),
            '--actor',
            admin.id,
          ])
        ).code,
      ).toBe(2);
      const customer = await user(null);
      expect(
        (
          await bootstrap([
            '--apply',
            '--user',
            admin.id,
            '--actor',
            customer.id,
          ])
        ).code,
      ).toBe(2);
      expect((await bootstrap(['--apply', '--user', admin.id])).code).toBe(2);
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: admin.id },
        }),
      ).toBe(0);
    });

    it('subscribes both categories with one id-only audit row each; a repeat changes nothing; the resolver then names only them', async () => {
      const admin = await user('PLATFORM_ADMIN');
      const { code, out } = await bootstrap([
        '--apply',
        '--user',
        admin.id,
        '--actor',
        admin.id,
      ]);
      expect(code).toBe(0);
      expect(out).toContain('ORDER_INTEGRITY, RETURN_ESCALATION');
      const rows = await auditsFor(admin.id, 'platform_alert_recipient.added');
      expect(rows.map((r) => r.afterState)).toEqual(
        expect.arrayContaining([
          { category: 'ORDER_INTEGRITY', recipient_user_id: admin.id },
          { category: 'RETURN_ESCALATION', recipient_user_id: admin.id },
        ]),
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.actorId).toBe(admin.id);
        expect(JSON.stringify(r)).not.toContain(admin.phone);
      }

      const again = await bootstrap([
        '--apply',
        '--user',
        admin.id,
        '--actor',
        admin.id,
      ]);
      expect(again.code).toBe(0);
      expect(again.out).toContain('nothing new');
      expect(
        await auditsFor(admin.id, 'platform_alert_recipient.added'),
      ).toHaveLength(2);

      const resolver = new PlatformAlertRecipientsService(
        prisma as never,
        new AuditLogService(prisma as never),
      );
      for (const category of [
        'ORDER_INTEGRITY',
        'RETURN_ESCALATION',
      ] as const) {
        const resolved = await prisma.$transaction((tx) =>
          resolver.resolve(tx, category),
        );
        expect(resolved.mode).toBe('SUBSCRIBED');
        expect(resolved.userIds).toContain(admin.id);
      }
      // Leave no subscription behind for the other files' fallback tests.
      await prisma.platformAlertRecipient.deleteMany({
        where: { userId: admin.id },
      });
    });
  });

  describe('revoke-test-staff', () => {
    // A rule of its own, far from any other file's data in a shared database.
    const rule: RevokeRule = {
      windows: [
        {
          label: 'test window 2001-01-01 10:00-11:00 UTC',
          from: new Date('2001-01-01T10:00:00Z'),
          to: new Date('2001-01-01T11:00:00Z'),
        },
      ],
      allowedLaterAuditIds: [],
    };
    const inWindow = () =>
      new Date(`2001-01-01T10:${String(10 + (seq % 40)).padStart(2, '0')}:00Z`);
    let live = new Set<string>();
    const lookup = async (ids: string[]) =>
      new Set(ids.filter((id) => live.has(id)));

    async function revoke(argv: string[]) {
      const lines: string[] = [];
      const code = await runRevoke(
        argv,
        prisma,
        lookup,
        (l) => lines.push(l),
        rule,
      );
      return { code, out: lines.join('\n') };
    }

    let real: { id: string; phone: string };
    let actor: { id: string };
    const s: Record<string, { id: string; phone: string }> = {};

    beforeAll(async () => {
      real = await user('PLATFORM_ADMIN'); // created now - the real administrator
      actor = real;
      s.admin = await user('PLATFORM_ADMIN', { createdAt: inWindow() });
      s.reviewer = await user('VERIFICATION_REVIEWER', {
        createdAt: inWindow(),
      });
      s.allowed = await user('PLATFORM_ADMIN', { createdAt: inWindow() });
      s.late = await user('PLATFORM_ADMIN', { createdAt: inWindow() });
      s.live = await user('VERIFICATION_REVIEWER', { createdAt: inWindow() });
      s.kept = await user('PLATFORM_ADMIN', { createdAt: inWindow() });
      s.outside = await user('PLATFORM_ADMIN', {
        createdAt: new Date('2001-01-02T10:00:00Z'),
      });
      s.customer = await user(null, { createdAt: inWindow() });
      // Same-day activity is fine; a later day's is not - unless allowed.
      const act = (actorId: string, occurredAt: Date) =>
        prisma.auditLog.create({
          data: {
            actorId,
            correlationId: randomUUID(),
            action: 'test.action',
            entityType: 'User',
            entityId: actorId,
            occurredAt,
          },
        });
      await act(s.admin.id, new Date('2001-01-01T12:00:00Z'));
      await act(s.late.id, new Date('2001-01-05T12:00:00Z'));
      const allowedRow = await act(
        s.allowed.id,
        new Date('2001-01-05T12:00:00Z'),
      );
      rule.allowedLaterAuditIds = [allowedRow.id];
      live = new Set([s.live.id]);
    });

    const roles = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(s).map(async ([k, v]) => [
            k,
            (await prisma.user.findUniqueOrThrow({ where: { id: v.id } }))
              .platformRole,
          ]),
        ),
      );
    const mine = (ids: string[]) =>
      ids.filter((id) => Object.values(s).some((v) => v.id === id));

    async function dryRun(name: string) {
      const path = join(dir, `${name}.json`);
      const res = await revoke([
        '--keep',
        real.id,
        '--keep',
        s.kept.id,
        '--out',
        path,
      ]);
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        ids_sha256: string;
        candidates: {
          user_id: string;
          reasons: string[];
          platform_role: string;
        }[];
        excluded: { user_id: string; reasons: string[] }[];
      };
      return { ...res, path, file };
    }

    it('needs the real administrator on the keep list', async () => {
      expect((await revoke([])).code).toBe(2);
    });

    it('dry-run: exactly the accounts meeting every condition, each with its reasons, nothing written, no phone', async () => {
      const before = await roles();
      const { code, out, file } = await dryRun('dry');
      expect(code).toBe(0);
      expect(out).toContain('Nothing was written to the database.');
      expect(mine(file.candidates.map((c) => c.user_id)).sort()).toEqual(
        [s.admin.id, s.reviewer.id, s.allowed.id].sort(),
      );
      const reasonsOf = (id: string) =>
        [...file.candidates, ...file.excluded]
          .find((v) => v.user_id === id)!
          .reasons.join('; ');
      expect(reasonsOf(s.admin.id)).toBe(
        'created in test window 2001-01-01 10:00-11:00 UTC; no activity after its creation day; no live session; not on the keep list',
      );
      expect(reasonsOf(s.late.id)).toBe('acted on a later day (1 audit rows)');
      expect(reasonsOf(s.live.id)).toBe('has a live session');
      expect(reasonsOf(s.kept.id)).toBe('on the keep list');
      expect(reasonsOf(s.outside.id)).toBe(
        'created outside every known e2e run window',
      );
      expect(reasonsOf(real.id)).toContain('on the keep list');
      expect(
        [...file.candidates, ...file.excluded].some(
          (v) => v.user_id === s.customer.id,
        ),
      ).toBe(false);
      expect(file.ids_sha256).toBe(
        idsSha256(file.candidates.map((c) => c.user_id)),
      );
      const raw = readFileSync(join(dir, 'dry.json'), 'utf8') + out;
      for (const v of [...Object.values(s), real])
        expect(raw).not.toContain(v.phone);
      expect(await roles()).toEqual(before);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'platform_role.revoked',
            entityId: { in: Object.values(s).map((v) => v.id) },
          },
        }),
      ).toBe(0);
    });

    it('apply refuses a list that is not the approved one, or that names a kept account', async () => {
      const before = await roles();
      const { file, path: out } = await dryRun('wrong');
      const bad = await revoke([
        '--apply',
        '--ids-file',
        out,
        '--expect-sha256',
        '0'.repeat(64),
        '--actor',
        actor.id,
        '--keep',
        real.id,
      ]);
      expect(bad.code).toBe(2);
      expect(bad.out).toContain('not the approved list');
      const kept = await revoke([
        '--apply',
        '--ids-file',
        out,
        '--expect-sha256',
        file.ids_sha256,
        '--actor',
        actor.id,
        '--keep',
        real.id,
        '--keep',
        file.candidates[0].user_id,
      ]);
      expect(kept.code).toBe(2);
      expect(
        (
          await revoke([
            '--apply',
            '--ids-file',
            out,
            '--expect-sha256',
            file.ids_sha256,
            '--actor',
            actor.id,
          ])
        ).code,
      ).toBe(2);
      expect(await roles()).toEqual(before);
    });

    it('apply is all-or-nothing: one listed account that stopped qualifying (a new session) rolls everything back', async () => {
      const before = await roles();
      const { file, path: out } = await dryRun('stale');
      live.add(s.reviewer.id);
      try {
        const res = await revoke([
          '--apply',
          '--ids-file',
          out,
          '--expect-sha256',
          file.ids_sha256,
          '--actor',
          actor.id,
          '--keep',
          real.id,
          '--keep',
          s.kept.id,
        ]);
        expect(res.code).toBe(1);
        expect(res.out).toContain(`${s.reviewer.id} (has a live session)`);
        expect(res.out).toContain('Nothing was written');
      } finally {
        live.delete(s.reviewer.id);
      }
      expect(await roles()).toEqual(before);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'platform_role.revoked',
            entityId: { in: Object.values(s).map((v) => v.id) },
          },
        }),
      ).toBe(0);
    });

    it('apply revokes exactly the approved list with one id-only audit row each; restore puts every role back', async () => {
      const { file, path: out } = await dryRun('apply');
      const ids = file.candidates.map((c) => c.user_id);
      const res = await revoke([
        '--apply',
        '--ids-file',
        out,
        '--expect-sha256',
        file.ids_sha256,
        '--actor',
        actor.id,
        '--keep',
        real.id,
        '--keep',
        s.kept.id,
      ]);
      expect(res.code).toBe(0);
      const correlation = /correlation ([0-9a-f-]{36})/.exec(res.out)![1];

      expect(await roles()).toEqual({
        admin: null,
        reviewer: null,
        allowed: null,
        late: 'PLATFORM_ADMIN',
        live: 'VERIFICATION_REVIEWER',
        kept: 'PLATFORM_ADMIN',
        outside: 'PLATFORM_ADMIN',
        customer: null,
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: real.id } }))
          .platformRole,
      ).toBe('PLATFORM_ADMIN');
      const audits = await prisma.auditLog.findMany({
        where: { action: 'platform_role.revoked', correlationId: correlation },
      });
      expect(audits).toHaveLength(ids.length);
      const reviewerRow = audits.find((a) => a.entityId === s.reviewer.id)!;
      expect(reviewerRow).toMatchObject({
        actorId: actor.id,
        entityType: 'User',
        beforeState: { platform_role: 'VERIFICATION_REVIEWER' },
        afterState: { platform_role: null },
      });
      for (const a of audits) expect(JSON.stringify(a)).not.toMatch(/\+970/);

      // Running the same approved list again changes nothing: they no longer qualify.
      const again = await revoke([
        '--apply',
        '--ids-file',
        out,
        '--expect-sha256',
        file.ids_sha256,
        '--actor',
        actor.id,
        '--keep',
        real.id,
      ]);
      expect(again.code).toBe(1);

      const restored = await revoke([
        '--restore',
        '--correlation',
        correlation,
        '--actor',
        actor.id,
      ]);
      expect(restored.code).toBe(0);
      expect(restored.out).toContain(
        `Restored ${ids.length} account(s); 0 already held a role`,
      );
      expect((await roles()).admin).toBe('PLATFORM_ADMIN');
      expect((await roles()).reviewer).toBe('VERIFICATION_REVIEWER');
      expect((await roles()).allowed).toBe('PLATFORM_ADMIN');
      expect(
        await prisma.auditLog.count({
          where: { action: 'platform_role.restored', entityId: { in: ids } },
        }),
      ).toBe(ids.length);
      const twice = await revoke([
        '--restore',
        '--correlation',
        correlation,
        '--actor',
        actor.id,
      ]);
      expect(twice.out).toContain(
        `Restored 0 account(s); ${ids.length} already held a role`,
      );
    });

    it('the live-session lookup reads Redis: a session that still exists counts, an expired one does not', async () => {
      const id = randomUUID();
      const token = `tb12-${randomUUID()}`;
      const lookupLive = redisLiveSessions(redis);
      await redis.sadd(`user_sessions:${id}`, token);
      await redis.set(`session:${token}`, '{}', 'EX', 60);
      try {
        expect([...(await lookupLive([id, randomUUID()]))]).toEqual([id]);
        await redis.del(`session:${token}`);
        expect((await lookupLive([id])).size).toBe(0);
      } finally {
        await redis.del(`user_sessions:${id}`, `session:${token}`);
      }
    });
  });

  // The last-administrator guard counts active administrators across the
  // whole database, and the shared test database always holds others -
  // so this runs on a database of its own. The actor is never on the
  // list, so the guard is only reached when the actor stops being an
  // active administrator between the pre-check and the transaction (a
  // concurrent deactivation); that is the case simulated here.
  describe('revoke-test-staff: the last active PLATFORM_ADMIN', () => {
    const dbName = `finalpro_tb124lastadmin_test_${process.pid}`;
    let db: PrismaClient;
    const rule: RevokeRule = {
      windows: [
        {
          label: 'test window 2001-01-01 10:00-11:00 UTC',
          from: new Date('2001-01-01T10:00:00Z'),
          to: new Date('2001-01-01T11:00:00Z'),
        },
      ],
      allowedLaterAuditIds: [],
    };
    const noSessions = () => Promise.resolve(new Set<string>());

    // Node runs the Prisma CLI directly (no npx), so this works on
    // Windows as well as in CI.
    beforeAll(async () => {
      // TB-13: created marked as a disposable test database.
      const url = await createDisposableDatabase(
        process.env.DATABASE_URL!,
        dbName,
      );
      execFileSync(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          'prisma7.config.ts',
        ],
        {
          cwd: API_ROOT,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
          timeout: 120_000,
        },
      );
      db = new PrismaClient({ adapter: new PrismaPg(url) });
    }, 180_000);

    afterAll(async () => {
      await db?.$disconnect();
      // TB-13: dropped only after its own marker is checked.
      await dropDisposableDatabase(process.env.DATABASE_URL!, dbName);
    }, 120_000);

    it('apply refuses the whole list when it would leave no active PLATFORM_ADMIN - no role change, no audit row', async () => {
      let n = 0;
      const mk = (
        platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER',
        createdAt?: Date,
      ) =>
        db.user.create({
          data: {
            phone: `+97059${String(1000000 + (n += 1))}`,
            passwordHash: 'x',
            phoneVerifiedAt: new Date(),
            platformRole,
            ...(createdAt ? { createdAt } : {}),
          },
        });
      const actor = await mk('PLATFORM_ADMIN'); // the only one kept
      const listed = [
        await mk('PLATFORM_ADMIN', new Date('2001-01-01T10:10:00Z')),
        await mk('PLATFORM_ADMIN', new Date('2001-01-01T10:20:00Z')),
        await mk('VERIFICATION_REVIEWER', new Date('2001-01-01T10:30:00Z')),
      ];
      const run = async (client: PrismaClient, argv: string[]) => {
        const lines: string[] = [];
        const code = await runRevoke(
          argv,
          client,
          noSessions,
          (l) => lines.push(l),
          rule,
        );
        return { code, out: lines.join('\n') };
      };

      const out = join(dir, 'last-admin.json');
      const dry = await run(db, ['--keep', actor.id, '--out', out]);
      expect(dry.code).toBe(0);
      const file = JSON.parse(readFileSync(out, 'utf8')) as {
        ids_sha256: string;
        candidates: { user_id: string }[];
      };
      expect(file.candidates.map((c) => c.user_id).sort()).toEqual(
        listed.map((u) => u.id).sort(),
      );
      const applyArgv = [
        '--apply',
        '--ids-file',
        out,
        '--expect-sha256',
        file.ids_sha256,
        '--actor',
        actor.id,
        '--keep',
        actor.id,
      ];

      // The actor passes the pre-check, then is deactivated by someone
      // else before the transaction starts.
      const racing = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === '$transaction') {
            return async (...args: unknown[]) => {
              await db.user.update({
                where: { id: actor.id },
                data: { deactivatedAt: new Date() },
              });
              return (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const auditsBefore = await db.auditLog.count();
      const refused = await run(racing, applyArgv);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain(
        'this would leave no active PLATFORM_ADMIN',
      );
      expect(refused.out).toContain('Nothing was written');
      const roleOf = async (id: string) =>
        (await db.user.findUniqueOrThrow({ where: { id } })).platformRole;
      expect(await Promise.all(listed.map((u) => roleOf(u.id)))).toEqual([
        'PLATFORM_ADMIN',
        'PLATFORM_ADMIN',
        'VERIFICATION_REVIEWER',
      ]);
      expect(await db.auditLog.count()).toBe(auditsBefore);

      // Control: with the actor active again the same approved list
      // applies - the refusal above came from the guard alone.
      await db.user.update({
        where: { id: actor.id },
        data: { deactivatedAt: null },
      });
      const applied = await run(db, applyArgv);
      expect(applied.code).toBe(0);
      expect(await Promise.all(listed.map((u) => roleOf(u.id)))).toEqual([
        null,
        null,
        null,
      ]);
      expect(
        await db.auditLog.count({ where: { action: 'platform_role.revoked' } }),
      ).toBe(listed.length);
    });
  });
});
