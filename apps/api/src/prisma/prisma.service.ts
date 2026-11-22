import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import {
  DISPOSABLE_TEST_DATABASE_MARKER,
  databaseNameFromUrl,
  isProtectedDatabaseName,
} from '../test-support/disposable-test-marker';

/**
 * Prisma 7 connects via a driver adapter rather than a schema-embedded
 * `url` (see prisma.config.ts and prisma/schema.prisma for the CLI-side
 * half of this). This is the runtime half, used by the app itself.
 *
 * TB-13: under NODE_ENV=test (every Jest run) the app refuses a
 * protected database (exactly "finalpro") before connecting, and a
 * database without the disposable-test marker before anything can use
 * it - a second guard behind the e2e globalSetup, for any test path
 * that does not go through it. Outside tests nothing here changes.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    if (process.env.NODE_ENV === 'test') {
      const name = databaseNameFromUrl(connectionString);
      if (isProtectedDatabaseName(name)) {
        throw new Error(
          `Refusing to start under NODE_ENV=test: DATABASE_URL points at "${name}", a protected database.`,
        );
      }
    }
    super({ adapter: new PrismaPg(connectionString) });
  }

  async onModuleInit() {
    await this.$connect();
    if (process.env.NODE_ENV === 'test') {
      const rows = await this.$queryRaw<{ comment: string | null }[]>`
        SELECT shobj_description(oid, 'pg_database') AS comment
        FROM pg_database WHERE datname = current_database()`;
      if (rows[0]?.comment !== DISPOSABLE_TEST_DATABASE_MARKER) {
        await this.$disconnect();
        throw new Error(
          'Refusing to start under NODE_ENV=test: the database is not marked as a disposable test database.',
        );
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
