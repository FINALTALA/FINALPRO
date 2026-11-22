import { PrismaService } from './prisma.service';

// TB-13: under NODE_ENV=test the app refuses a protected database before
// it ever connects (the marker check, which needs a database, is covered
// by test/tb13-test-database-safety.e2e-spec.ts).
describe('PrismaService test-environment guard (TB-13)', () => {
  const saved = { url: process.env.DATABASE_URL, env: process.env.NODE_ENV };
  afterEach(() => {
    process.env.DATABASE_URL = saved.url;
    process.env.NODE_ENV = saved.env;
  });

  it('refuses "finalpro" (exact name) under NODE_ENV=test, before connecting', () => {
    process.env.NODE_ENV = 'test';
    // An unreachable host: a connection attempt would fail differently.
    process.env.DATABASE_URL = 'postgresql://u:p@203.0.113.1:5432/finalpro';
    expect(() => new PrismaService()).toThrow(/protected database/);
  });

  it('does not refuse other names in its constructor (they are checked for the marker at init)', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      'postgresql://u:p@203.0.113.1:5432/finalpro_some_test';
    expect(() => new PrismaService()).not.toThrow();
  });

  it('changes nothing outside tests', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://u:p@203.0.113.1:5432/finalpro';
    expect(() => new PrismaService()).not.toThrow();
  });
});
