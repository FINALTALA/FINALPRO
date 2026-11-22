import { Controller, Get, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DISPOSABLE_TEST_DATABASE_MARKER } from './disposable-test-marker';

/** Test-support routes exist only for a test server: started with
 * E2E_TEST_SUPPORT=1, and never when NODE_ENV is production. Read per
 * request, so nothing is decided at build or import time. */
export function isTestSupportEnabled(): boolean {
  return (
    process.env.E2E_TEST_SUPPORT === '1' &&
    process.env.NODE_ENV !== 'production'
  );
}

/**
 * TB-12.1: lets the Playwright global setup confirm, before it writes
 * anything, that the API it is about to drive is connected to the same
 * marked test database it seeds directly (PW_DATABASE_URL) - not to
 * finalpro or another database. Answers only which database this
 * process is connected to and whether that database carries the
 * disposable-test marker: no host, user, credentials or data.
 * Everywhere test support is off (production included), it is a 404 -
 * indistinguishable from a route that does not exist.
 */
@Controller('test-support')
export class TestSupportController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('database-identity')
  async databaseIdentity() {
    if (!isTestSupportEnabled()) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
      });
    }
    const rows = await this.prisma.$queryRaw<
      { name: string; oid: number; comment: string | null }[]
    >`SELECT datname AS name, oid::int AS oid, shobj_description(oid, 'pg_database') AS comment
      FROM pg_database WHERE datname = current_database()`;
    const db = rows[0];
    return {
      database: db.name,
      database_oid: db.oid,
      disposable_test: db.comment === DISPOSABLE_TEST_DATABASE_MARKER,
    };
  }
}
