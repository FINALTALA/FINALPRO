-- Sprint 2 review fix round 2: sessionVersion (fail-closed session
-- invalidation on password reset, independent of Redis availability)
-- and otp_codes.verificationToken (lets a retry recover an already-
-- issued token if the idempotency-completion bookkeeping write fails
-- after the OTP itself was already consumed).
--
-- As with the two prior migrations, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in 20260917090000's migration.sql. Left alone
-- again for the same reason: application code only ever references
-- the Prisma Client-level name (set via schema.prisma's `name:`
-- argument), never the physical SQL index name.

-- AlterTable
ALTER TABLE "otp_codes" ADD COLUMN     "verificationToken" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;
