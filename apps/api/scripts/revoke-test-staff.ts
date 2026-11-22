/**
 * TB-12.4: takes the platform role away from the e2e test accounts the
 * suites once wrote into the development database (finalpro has 1,084
 * such PLATFORM_ADMIN / VERIFICATION_REVIEWER accounts and no other
 * staff). Only the role: the account, its audit trail, memberships and
 * sessions are left as they are - the role guard reads the role on
 * every request, so the revocation takes effect at once - and
 * --restore puts it back from the audit rows.
 *
 * An account qualifies only when EVERY condition holds (no single one
 * is a test signal on its own - +97056/+97059 are real Palestinian
 * mobile prefixes):
 *   1. it holds a platform role;
 *   2. it was created inside one of the known e2e run windows below;
 *   3. it has acted (audit_logs.actorId) on no day after the day it was
 *      created, apart from the audit rows explicitly allowed below;
 *   4. it has no live session;
 *   5. it is not on the keep list (--keep).
 *
 * Usage (apps/api as cwd, after `nest build`):
 *   Dry-run (default - writes nothing to the database):
 *     node dist/scripts/revoke-test-staff.js --keep <uuid> [--keep ...] --out <file.json>
 *   Apply (exactly the approved dry-run list, one transaction):
 *     node dist/scripts/revoke-test-staff.js --apply --ids-file <file.json> \
 *       --expect-sha256 <ids_sha256 from the dry-run> --actor <admin id> --keep <uuid> ...
 *   Restore (undo one apply, or part of it):
 *     node dist/scripts/revoke-test-staff.js --restore --correlation <uuid> \
 *       --actor <admin id> [--id <uuid> ...]
 * Nothing here notifies anyone. Audit rows carry ids and roles only.
 *
 * Local databases only (scripts/local-db-guard.ts); a database whose
 * name does not look local (e.g. finalpro) also needs
 * LOCAL_DEMO_DATABASE=<that name>. Back the database up before --apply.
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import Redis from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { AuditLogService } from '../src/audit/audit-log.service';
import { requireLocalDatabase } from './local-db-guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ROLE_REVOKED_ACTION = 'platform_role.revoked';
export const ROLE_RESTORED_ACTION = 'platform_role.restored';

export interface RunWindow {
  label: string;
  from: Date;
  to: Date;
}

/** The two e2e runs that wrote every staff account finalpro has (UTC;
 * users.createdAt is stored as UTC): 755 accounts on 2026-09-28 between
 * 19:38 and 19:47, 329 on 2026-10-03 between 17:45 and 17:49. */
export const E2E_RUN_WINDOWS: RunWindow[] = [
  {
    label: 'e2e run 2026-09-28 19:00-20:00 UTC',
    from: new Date('2026-09-28T19:00:00Z'),
    to: new Date('2026-09-28T20:00:00Z'),
  },
  {
    label: 'e2e run 2026-10-03 17:00-18:00 UTC',
    from: new Date('2026-10-03T17:00:00Z'),
    to: new Date('2026-10-03T18:00:00Z'),
  },
];

/** Later audit rows that do not count as activity: TB-9.4's repair of
 * order 55c962ed, run by the developer as 37d74a06. */
export const ALLOWED_LATER_AUDIT_IDS = ['0465162b-f0fe-41ba-9ef9-1c2a38b62155'];

export interface RevokeRule {
  windows: RunWindow[];
  allowedLaterAuditIds: string[];
}
const DEFAULT_RULE: RevokeRule = {
  windows: E2E_RUN_WINDOWS,
  allowedLaterAuditIds: ALLOWED_LATER_AUDIT_IDS,
};

/** Which of these users have at least one session that has not expired. */
export type LiveSessionLookup = (userIds: string[]) => Promise<Set<string>>;

export function redisLiveSessions(redis: Redis): LiveSessionLookup {
  return async (userIds) => {
    const live = new Set<string>();
    for (const userId of userIds) {
      const tokens = await redis.smembers(`user_sessions:${userId}`);
      if (tokens.length === 0) continue;
      const exists = await redis.exists(...tokens.map((t) => `session:${t}`));
      if (exists > 0) live.add(userId);
    }
    return live;
  };
}

export interface StaffVerdict {
  user_id: string;
  platform_role: string;
  created_at: string;
  qualifies: boolean;
  /** Why it qualifies (every condition), or why it does not. */
  reasons: string[];
  vendor_memberships: number;
}

/** Applies the rule to every account holding a platform role. */
export async function evaluateStaff(
  db: Prisma.TransactionClient | PrismaClient,
  liveSessions: LiveSessionLookup,
  keep: Set<string>,
  rule: RevokeRule = DEFAULT_RULE,
): Promise<StaffVerdict[]> {
  const staff = await db.user.findMany({
    where: { platformRole: { not: null } },
    select: {
      id: true,
      platformRole: true,
      createdAt: true,
      _count: { select: { vendorUsers: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const later = await db.$queryRaw<{ actorId: string; n: number }[]>`
    SELECT a."actorId", count(*)::int AS n
    FROM audit_logs a JOIN users u ON u.id = a."actorId"
    WHERE u."platformRole" IS NOT NULL
      AND a."occurredAt"::date > u."createdAt"::date
      AND NOT (a.id = ANY(${rule.allowedLaterAuditIds}::text[]))
    GROUP BY a."actorId"`;
  const laterBy = new Map(later.map((r) => [r.actorId, r.n]));
  const live = await liveSessions(staff.map((s) => s.id));

  return staff.map((s) => {
    const window = rule.windows.find(
      (w) => s.createdAt >= w.from && s.createdAt < w.to,
    );
    const blockers: string[] = [];
    if (!window) blockers.push('created outside every known e2e run window');
    const laterCount = laterBy.get(s.id) ?? 0;
    if (laterCount > 0) {
      blockers.push(`acted on a later day (${laterCount} audit rows)`);
    }
    if (live.has(s.id)) blockers.push('has a live session');
    if (keep.has(s.id)) blockers.push('on the keep list');
    return {
      user_id: s.id,
      platform_role: s.platformRole!,
      created_at: s.createdAt.toISOString(),
      qualifies: blockers.length === 0,
      reasons:
        blockers.length > 0
          ? blockers
          : [
              `created in ${window!.label}`,
              'no activity after its creation day',
              'no live session',
              'not on the keep list',
            ],
      vendor_memberships: s._count.vendorUsers,
    };
  });
}

/** The fingerprint the approval is bound to: the sorted candidate ids. */
export function idsSha256(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

type Mode = 'dry-run' | 'apply' | 'restore';
interface RevokeArgs {
  mode: Mode;
  keep: string[];
  out: string | null;
  idsFile: string | null;
  expectSha256: string | null;
  actor: string | null;
  correlation: string | null;
  ids: string[];
}

export function parseRevokeArgs(argv: string[]): RevokeArgs {
  const args: RevokeArgs = {
    mode: 'dry-run',
    keep: [],
    out: null,
    idsFile: null,
    expectSha256: null,
    actor: null,
    correlation: null,
    ids: [],
  };
  const uuid = (flag: string, value: string | undefined) => {
    if (!value || !UUID.test(value)) {
      throw new Error(`${flag} needs a full UUID (got "${value ?? ''}")`);
    }
    return value.toLowerCase();
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--restore') {
      if (args.mode !== 'dry-run')
        throw new Error('Use only one of --apply / --restore');
      args.mode = arg === '--apply' ? 'apply' : 'restore';
    } else if (arg === '--keep') {
      const v = uuid(arg, argv[++i]);
      if (!args.keep.includes(v)) args.keep.push(v);
    } else if (arg === '--id') {
      const v = uuid(arg, argv[++i]);
      if (!args.ids.includes(v)) args.ids.push(v);
    } else if (arg === '--actor') {
      args.actor = uuid(arg, argv[++i]);
    } else if (arg === '--correlation') {
      args.correlation = uuid(arg, argv[++i]);
    } else if (
      arg === '--out' ||
      arg === '--ids-file' ||
      arg === '--expect-sha256'
    ) {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} needs a value`);
      if (arg === '--out') args.out = v;
      else if (arg === '--ids-file') args.idsFile = v;
      else args.expectSha256 = v.toLowerCase();
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  if (args.mode === 'apply') {
    if (!args.idsFile || !args.expectSha256 || !args.actor) {
      throw new Error('--apply needs --ids-file, --expect-sha256 and --actor');
    }
    if (args.keep.length === 0) {
      throw new Error(
        '--apply needs at least one --keep (the real administrator)',
      );
    }
  }
  if (args.mode === 'restore' && (!args.correlation || !args.actor)) {
    throw new Error('--restore needs --correlation and --actor');
  }
  if (args.mode === 'dry-run' && args.keep.length === 0) {
    throw new Error('--keep <real administrator id> is required');
  }
  return args;
}

const isActiveAdmin = (
  u: { platformRole: string | null; deactivatedAt: Date | null } | null,
) => u?.platformRole === 'PLATFORM_ADMIN' && u.deactivatedAt === null;

/** The whole CLI, minus process wiring - returns the exit code. */
export async function runRevoke(
  argv: string[],
  prisma: PrismaClient,
  liveSessions: LiveSessionLookup,
  print: (line: string) => void,
  rule: RevokeRule = DEFAULT_RULE,
): Promise<number> {
  let args: RevokeArgs;
  try {
    args = parseRevokeArgs(argv);
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return 2;
  }
  const keep = new Set(args.keep);
  const audit = new AuditLogService(prisma as never);

  if (args.mode === 'dry-run') {
    const verdicts = await evaluateStaff(prisma, liveSessions, keep, rule);
    const candidates = verdicts.filter((v) => v.qualifies);
    const excluded = verdicts.filter((v) => !v.qualifies);
    const ids = candidates.map((c) => c.user_id);
    const sha = idsSha256(ids);
    const byRole = (list: StaffVerdict[], role: string) =>
      list.filter((v) => v.platform_role === role).length;
    const keptNotStaff = args.keep.filter(
      (id) => !verdicts.some((v) => v.user_id === id),
    );
    print(
      `Dry-run over ${verdicts.length} account(s) holding a platform role:`,
    );
    print(
      `  qualify: ${candidates.length} (PLATFORM_ADMIN ${byRole(candidates, 'PLATFORM_ADMIN')}, VERIFICATION_REVIEWER ${byRole(candidates, 'VERIFICATION_REVIEWER')})`,
    );
    print(`  excluded: ${excluded.length}`);
    for (const v of excluded) {
      print(`    ${v.user_id}  ${v.platform_role}  ${v.reasons.join('; ')}`);
    }
    for (const id of keptNotStaff) {
      print(`    (keep ${id}: holds no platform role)`);
    }
    print(`  ids_sha256: ${sha}`);
    if (args.out) {
      writeFileSync(
        args.out,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            rule: {
              windows: rule.windows.map((w) => ({
                label: w.label,
                from: w.from.toISOString(),
                to: w.to.toISOString(),
              })),
              allowed_later_audit_ids: rule.allowedLaterAuditIds,
              keep: args.keep,
            },
            ids_sha256: sha,
            candidates,
            excluded,
          },
          null,
          2,
        ),
      );
      print(`  full list written to ${args.out}`);
    }
    print('Nothing was written to the database.');
    return 0;
  }

  const actor = await prisma.user.findUnique({
    where: { id: args.actor! },
    select: { platformRole: true, deactivatedAt: true },
  });
  if (!isActiveAdmin(actor)) {
    print(
      'Error: --actor must be an active PLATFORM_ADMIN. Nothing was written.',
    );
    return 2;
  }
  const correlationId = randomUUID();

  if (args.mode === 'apply') {
    let ids: string[];
    try {
      const file = JSON.parse(readFileSync(args.idsFile!, 'utf8')) as {
        candidates: { user_id: string }[];
      };
      ids = file.candidates.map((c) => c.user_id.toLowerCase());
    } catch (err) {
      print(`Error: cannot read --ids-file: ${(err as Error).message}`);
      return 2;
    }
    if (ids.length === 0 || ids.some((id) => !UUID.test(id))) {
      print(
        'Error: --ids-file holds no valid candidate ids. Nothing was written.',
      );
      return 2;
    }
    if (idsSha256(ids) !== args.expectSha256) {
      print(
        'Error: the ids file does not match --expect-sha256 (not the approved list). Nothing was written.',
      );
      return 2;
    }
    if (ids.includes(args.actor!) || ids.some((id) => keep.has(id))) {
      print(
        'Error: the list includes the actor or a kept account. Nothing was written.',
      );
      return 2;
    }
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
          const verdicts = new Map(
            (await evaluateStaff(tx, liveSessions, keep, rule)).map((v) => [
              v.user_id,
              v,
            ]),
          );
          const failing = ids.filter((id) => !verdicts.get(id)?.qualifies);
          if (failing.length > 0) {
            throw new Error(
              `${failing.length} listed account(s) no longer qualify: ${failing
                .slice(0, 20)
                .map(
                  (id) =>
                    `${id} (${verdicts.get(id)?.reasons.join('; ') ?? 'holds no platform role'})`,
                )
                .join(', ')}`,
            );
          }
          const remainingAdmins = await tx.user.count({
            where: {
              platformRole: 'PLATFORM_ADMIN',
              deactivatedAt: null,
              id: { notIn: ids },
            },
          });
          if (remainingAdmins === 0) {
            throw new Error('this would leave no active PLATFORM_ADMIN');
          }
          for (const id of ids) {
            const before = verdicts.get(id)!.platform_role;
            await tx.user.update({
              where: { id },
              data: { platformRole: null },
            });
            await audit.record(
              {
                actorId: args.actor!,
                correlationId,
                action: ROLE_REVOKED_ACTION,
                entityType: 'User',
                entityId: id,
                beforeState: { platform_role: before },
                afterState: { platform_role: null },
              },
              tx,
            );
          }
        },
        { timeout: 120_000 },
      );
    } catch (err) {
      print(`Error: ${(err as Error).message}`);
      print('Nothing was written (the whole run was rolled back).');
      return 1;
    }
    print(
      `Revoked the platform role of ${ids.length} account(s) (correlation ${correlationId}).`,
    );
    print(`Undo: --restore --correlation ${correlationId} --actor <admin id>`);
    return 0;
  }

  // --restore: put back the role each revocation of that run recorded,
  // for accounts that still hold none (one granted since is left alone).
  const revoked = await prisma.auditLog.findMany({
    where: {
      action: ROLE_REVOKED_ACTION,
      correlationId: args.correlation!,
      ...(args.ids.length ? { entityId: { in: args.ids } } : {}),
    },
    select: { entityId: true, beforeState: true },
  });
  if (revoked.length === 0) {
    print(
      'Error: no revocation found for that correlation (and ids). Nothing was written.',
    );
    return 2;
  }
  let restored = 0;
  let skipped = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const row of revoked) {
          const role = (row.beforeState as { platform_role?: string } | null)
            ?.platform_role;
          if (role !== 'PLATFORM_ADMIN' && role !== 'VERIFICATION_REVIEWER') {
            throw new Error(
              `revocation of ${row.entityId} holds no restorable role`,
            );
          }
          const changed = await tx.user.updateMany({
            where: { id: row.entityId, platformRole: null },
            data: { platformRole: role },
          });
          if (changed.count === 0) {
            skipped += 1;
            continue;
          }
          restored += 1;
          await audit.record(
            {
              actorId: args.actor!,
              correlationId,
              action: ROLE_RESTORED_ACTION,
              entityType: 'User',
              entityId: row.entityId,
              beforeState: { platform_role: null },
              afterState: { platform_role: role },
            },
            tx,
          );
        }
      },
      { timeout: 120_000 },
    );
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    print('Nothing was written (the whole run was rolled back).');
    return 1;
  }
  print(
    `Restored ${restored} account(s); ${skipped} already held a role (correlation ${correlationId}).`,
  );
  return 0;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  requireLocalDatabase(connectionString);
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl)
    throw new Error(
      'REDIS_URL is not set (live sessions are part of the rule)',
    );
  const prisma = new PrismaClient({
    adapter: new PrismaPg(connectionString),
  });
  const redis = new Redis(redisUrl);
  try {
    process.exitCode = await runRevoke(
      process.argv.slice(2),
      prisma,
      redisLiveSessions(redis),
      (line) => console.log(line),
    );
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
