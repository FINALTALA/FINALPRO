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
 */
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PlatformRole, PrismaClient } from '../generated/prisma/client';

async function main() {
  const [phone, password, role] = process.argv.slice(2);
  if (!phone || !password || !role) {
    console.error(
      'Usage: ts-node scripts/seed-platform-staff.ts <phone> <password> <VERIFICATION_REVIEWER|PLATFORM_ADMIN>',
    );
    process.exit(1);
  }
  if (!Object.values(PlatformRole).includes(role as PlatformRole)) {
    console.error(`Invalid role "${role}". Must be one of: ${Object.values(PlatformRole).join(', ')}`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  const passwordHash = await bcrypt.hash(password, 10);
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

  console.log(`OK: user ${user.id} (${user.phone}) is now ${role}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
