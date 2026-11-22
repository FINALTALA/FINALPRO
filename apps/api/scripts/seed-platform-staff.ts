/**
 * Out-of-band platform-staff account creation (Sprint 3). There is no
 * self-service way to acquire a PlatformRole - see User.platformRole's
 * schema comment - so this is the "direct DB access" path a real
 * deployment would restrict to vetted staff, standing in for it here.
 *
 * Usage (from inside the app's Node container, apps/api as cwd):
 *   npx ts-node scripts/seed-platform-staff.ts <phone> <password> <role>
 * role is one of VERIFICATION_REVIEWER | PLATFORM_ADMIN.
 *
 * Idempotent: re-running with the same phone updates that user's role
 * and password rather than creating a duplicate.
 *
 * TB-12.4: pass "-" as the password to read it from the
 * PLATFORM_STAFF_PASSWORD environment variable instead (keeps it out of
 * the process list and shell history). The output names the account by
 * id and the last three phone digits only, and a role change writes one
 * `platform_role.granted` audit row (ids and roles - no phone).
 */
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PlatformRole, PrismaClient } from '../generated/prisma/client';

async function main() {
  const [phone, passwordArg, role] = process.argv.slice(2);
  const password =
    passwordArg === '-' ? process.env.PLATFORM_STAFF_PASSWORD : passwordArg;
  if (!phone || !password || !role) {
    console.error(
      'Usage: ts-node scripts/seed-platform-staff.ts <phone> <password> <VERIFICATION_REVIEWER|PLATFORM_ADMIN>',
    );
    process.exit(1);
  }
  if (!Object.values(PlatformRole).includes(role as PlatformRole)) {
    console.error(
      `Invalid role "${role}". Must be one of: ${Object.values(PlatformRole).join(', ')}`,
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  const passwordHash = await bcrypt.hash(password, 10);
  const before = await prisma.user.findUnique({
    where: { phone },
    select: { platformRole: true },
  });
  const user = await prisma.user.upsert({
    where: { phone },
    create: {
      phone,
      passwordHash,
      phoneVerifiedAt: new Date(),
      platformRole: role as PlatformRole,
    },
    update: {
      passwordHash,
      platformRole: role as PlatformRole,
    },
  });

  if (before?.platformRole !== role) {
    await prisma.auditLog.create({
      data: {
        actorId: null,
        correlationId: randomUUID(),
        action: 'platform_role.granted',
        entityType: 'User',
        entityId: user.id,
        beforeState: { platform_role: before?.platformRole ?? null },
        afterState: { platform_role: role },
      },
    });
  }

  console.log(
    `OK: user ${user.id} (•••${user.phone.slice(-3)}) is now ${role}` +
      (before ? '' : ' (new account)'),
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
