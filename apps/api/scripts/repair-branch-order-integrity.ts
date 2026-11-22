/**
 * TB-9: the explicit, narrow repair for a stale test-fixture branch
 * order - a PICKUP order sitting in DELIVERED (a state the order state
 * machine never produces) with no items and no status-change history.
 * See BranchOrderIntegrityService.repairFixtureOrder for what it writes
 * (status -> COMPLETED and one data-minimal audit row; no notification,
 * no review invitation).
 *
 * Usage (apps/api as cwd, after `nest build`):
 *   Dry-run (default - writes nothing):
 *     node dist/scripts/repair-branch-order-integrity.js [--id <uuid> ...]
 *   Apply (explicit ids only, one transaction, all-or-nothing):
 *     node dist/scripts/repair-branch-order-integrity.js --apply \
 *       --actor <platform-admin user id> --id <uuid> [--id <uuid> ...]
 *
 * Local databases only (scripts/local-db-guard.ts); a database whose
 * name does not look local (e.g. finalpro) also needs
 * LOCAL_DEMO_DATABASE=<that name>. Back the database up before --apply.
 */
import { randomUUID } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { AuditLogService } from '../src/audit/audit-log.service';
import {
  BranchOrderIntegrityService,
  FixtureRepairCheck,
} from '../src/orders/branch-order-integrity.service';
import { requireLocalDatabase } from './local-db-guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RepairArgs {
  apply: boolean;
  actor: string | null;
  ids: string[];
}

export function parseRepairArgs(argv: string[]): RepairArgs {
  const args: RepairArgs = { apply: false, actor: null, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--actor' || arg === '--id') {
      const value = argv[++i];
      if (!value || !UUID.test(value)) {
        throw new Error(`${arg} needs a full UUID (got "${value ?? ''}")`);
      }
      if (arg === '--actor') args.actor = value;
      else if (!args.ids.includes(value)) args.ids.push(value);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  if (args.apply && args.ids.length === 0) {
    throw new Error('--apply needs at least one explicit --id');
  }
  if (args.apply && !args.actor) {
    throw new Error('--apply needs --actor <platform admin user id>');
  }
  return args;
}

function describe(check: FixtureRepairCheck): string {
  if (!check.found) return `${check.id}  NOT FOUND`;
  return [
    check.id,
    `${check.fulfilmentMethod}/${check.status}`,
    `deliveredAt=${check.deliveredAt?.toISOString() ?? 'null'}`,
    `items=${check.itemCount}`,
    `statusChangeAudits=${check.statusChangeAuditCount}`,
    check.eligible ? 'ELIGIBLE' : `NOT ELIGIBLE (${check.blockers.join('; ')})`,
  ].join('  ');
}

/** The whole CLI, minus process wiring - returns the exit code. */
export async function runRepair(
  argv: string[],
  prisma: PrismaClient,
  print: (line: string) => void,
): Promise<number> {
  let args: RepairArgs;
  try {
    args = parseRepairArgs(argv);
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return 2;
  }
  // The repair never notifies anyone, so it needs no outbox and no
  // alert-recipient resolver.
  const integrity = new BranchOrderIntegrityService(
    prisma as never,
    new AuditLogService(prisma as never),
    null as never,
    null as never,
  );

  if (!args.apply) {
    const checks = args.ids.length
      ? await Promise.all(
          args.ids.map((id) => integrity.checkFixtureRepair(prisma, id)),
        )
      : await integrity.fixtureRepairCandidates(prisma);
    print(
      args.ids.length
        ? `Dry-run: ${checks.length} requested id(s)`
        : `Dry-run: ${checks.length} PICKUP order(s) in DELIVERED`,
    );
    for (const check of checks) print(`  ${describe(check)}`);
    print(
      `Eligible: ${checks.filter((c) => c.eligible).length}. Nothing was written.`,
    );
    return 0;
  }

  const actor = await prisma.user.findUnique({
    where: { id: args.actor! },
    select: { platformRole: true },
  });
  if (actor?.platformRole !== 'PLATFORM_ADMIN') {
    print('Error: --actor must be a PLATFORM_ADMIN user');
    return 2;
  }
  const correlationId = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      for (const id of args.ids) {
        await integrity.repairFixtureOrder(tx, id, args.actor!, correlationId);
      }
    });
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    print('Nothing was written (the whole run was rolled back).');
    return 1;
  }
  print(
    `Repaired ${args.ids.length} order(s) to COMPLETED (correlation ${correlationId}):`,
  );
  for (const id of args.ids) {
    const after = await integrity.checkFixtureRepair(prisma, id);
    print(`  ${id}  now ${after.fulfilmentMethod}/${after.status}`);
  }
  return 0;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  requireLocalDatabase(connectionString);
  const prisma = new PrismaClient({
    adapter: new PrismaPg(connectionString),
  });
  try {
    process.exitCode = await runRepair(process.argv.slice(2), prisma, (line) =>
      console.log(line),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
