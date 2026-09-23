import { execFileSync } from 'child_process';
import * as path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

export const API_ROOT = path.resolve(__dirname, '..', '..');

export function urlForDb(dbName: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * The seed's own guard only accepts local-looking database names, and
 * the base CI/dev database (e.g. "finalpro") is deliberately not one of
 * them. Every seed subprocess therefore runs against a throwaway
 * database whose name contains "test"; this makes that acceptance
 * explicit instead of accidental.
 */
export function runSeedOn(databaseUrl: string): {
  ok: boolean;
  output: string;
} {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.includes('test')) {
    throw new Error(`refusing to seed non-test database "${dbName}"`);
  }
  try {
    const out = execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 90_000,
    });
    return { ok: true, output: out.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

/**
 * Creates (and migrates) a template database, then clones per-scenario
 * databases from it. All names are prefixed per suite so suites running
 * in parallel workers never collide. The database in DATABASE_URL is
 * only used as the admin connection for CREATE/DROP DATABASE - it is
 * never seeded or modified.
 */
export class SeedTestDatabases {
  private admin!: PrismaClient;
  private readonly baseDb: string;
  private readonly created: string[] = [];

  constructor(private readonly prefix: string) {
    if (!prefix.includes('test')) {
      throw new Error('temporary database prefix must contain "test"');
    }
    this.baseDb = `${prefix}_base`;
  }

  async setUp(): Promise<void> {
    this.admin = new PrismaClient({
      adapter: new PrismaPg(process.env.DATABASE_URL as string),
    });
    await this.admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${this.baseDb}"`,
    );
    await this.admin.$executeRawUnsafe(`CREATE DATABASE "${this.baseDb}"`);
    execFileSync(
      'npx',
      ['prisma', 'migrate', 'deploy', '--config', 'prisma7.config.ts'],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: urlForDb(this.baseDb) },
        stdio: 'pipe',
        timeout: 120_000,
      },
    );
  }

  async clone(name: string): Promise<{ url: string; prisma: PrismaClient }> {
    const dbName = `${this.prefix}_${name}`;
    await this.admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await this.admin.$executeRawUnsafe(
      `CREATE DATABASE "${dbName}" TEMPLATE "${this.baseDb}"`,
    );
    this.created.push(dbName);
    const url = urlForDb(dbName);
    return { url, prisma: new PrismaClient({ adapter: new PrismaPg(url) }) };
  }

  /** Call only after every scenario PrismaClient has been disconnected. */
  async tearDown(): Promise<void> {
    for (const db of [...this.created, this.baseDb]) {
      await this.admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}"`);
    }
    await this.admin.$disconnect();
  }
}
