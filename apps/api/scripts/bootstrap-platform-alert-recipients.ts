/**
 * TB-12.4: the explicit bootstrap of a platform-alert recipient - the
 * first subscription, made before the API runs with the recipient
 * resolver, so there is never a window in which an alert falls back to
 * every active administrator. It subscribes one administrator, by
 * user id only, through the same PlatformAlertRecipientsService.add the
 * API uses: the target is locked and must be an active PLATFORM_ADMIN,
 * a repeat changes nothing, and each real change writes one audit row
 * ({category, recipient_user_id}, the actor) - never a phone number.
 *
 * Usage (apps/api as cwd, after `nest build`):
 *   Dry-run (default - writes nothing):
 *     node dist/scripts/bootstrap-platform-alert-recipients.js \
 *       --user <uuid> [--category ORDER_INTEGRITY ...]
 *   Apply (one transaction, all-or-nothing):
 *     node dist/scripts/bootstrap-platform-alert-recipients.js --apply \
 *       --user <uuid> --actor <platform-admin user id> [--category ...]
 * Without --category, every category is subscribed.
 *
 * Local databases only (scripts/local-db-guard.ts); a database whose
 * name does not look local (e.g. finalpro) also needs
 * LOCAL_DEMO_DATABASE=<that name>. Back the database up before --apply.
 */
import { randomUUID } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PlatformAlertCategory,
  PrismaClient,
} from '../generated/prisma/client';
import { AuditLogService } from '../src/audit/audit-log.service';
import { PlatformAlertRecipientsService } from '../src/platform-alerts/platform-alert-recipients.service';
import { requireLocalDatabase } from './local-db-guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = Object.values(PlatformAlertCategory);

export interface BootstrapArgs {
  apply: boolean;
  user: string | null;
  actor: string | null;
  categories: PlatformAlertCategory[];
}

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  const args: BootstrapArgs = {
    apply: false,
    user: null,
    actor: null,
    categories: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--user' || arg === '--actor') {
      const value = argv[++i];
      if (!value || !UUID.test(value)) {
        throw new Error(`${arg} needs a full UUID (got "${value ?? ''}")`);
      }
      if (arg === '--user') args.user = value.toLowerCase();
      else args.actor = value.toLowerCase();
    } else if (arg === '--category') {
      const value = argv[++i] as PlatformAlertCategory;
      if (!CATEGORIES.includes(value)) {
        throw new Error(
          `--category must be one of ${CATEGORIES.join(', ')} (got "${value ?? ''}")`,
        );
      }
      if (!args.categories.includes(value)) args.categories.push(value);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  if (!args.user) throw new Error('--user <uuid> is required');
  if (args.apply && !args.actor) {
    throw new Error('--apply needs --actor <platform admin user id>');
  }
  if (args.categories.length === 0) args.categories = [...CATEGORIES];
  return args;
}

const isActiveAdmin = (
  u: { platformRole: string | null; deactivatedAt: Date | null } | null,
) => u?.platformRole === 'PLATFORM_ADMIN' && u.deactivatedAt === null;

/** The whole CLI, minus process wiring - returns the exit code. */
export async function runBootstrap(
  argv: string[],
  prisma: PrismaClient,
  print: (line: string) => void,
): Promise<number> {
  let args: BootstrapArgs;
  try {
    args = parseBootstrapArgs(argv);
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return 2;
  }
  const recipients = new PlatformAlertRecipientsService(
    prisma as never,
    new AuditLogService(prisma as never),
  );
  const userId = args.user!;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true, deactivatedAt: true },
  });
  const existing = await prisma.platformAlertRecipient.findMany({
    where: { userId },
    select: { category: true },
  });
  const have = new Set(existing.map((r) => r.category));
  print(
    `User ${userId}: ${user ? (isActiveAdmin(user) ? 'active PLATFORM_ADMIN' : 'NOT an active PLATFORM_ADMIN') : 'NOT FOUND'}`,
  );
  for (const category of args.categories) {
    print(
      `  ${category}: ${have.has(category) ? 'already subscribed' : 'to subscribe'}`,
    );
  }
  if (!isActiveAdmin(user)) {
    print(
      'Error: --user must be an active PLATFORM_ADMIN. Nothing was written.',
    );
    return 2;
  }
  if (!args.apply) {
    print('Dry-run: nothing was written.');
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
  const added: PlatformAlertCategory[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      for (const category of args.categories) {
        const res = await recipients.add(
          tx,
          category,
          userId,
          args.actor!,
          correlationId,
        );
        if (res.added) added.push(category);
      }
    });
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    print('Nothing was written (the whole run was rolled back).');
    return 1;
  }
  print(
    `Subscribed ${userId} to ${added.length ? added.join(', ') : 'nothing new'} (correlation ${correlationId}).`,
  );
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
    process.exitCode = await runBootstrap(
      process.argv.slice(2),
      prisma,
      (line) => console.log(line),
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
