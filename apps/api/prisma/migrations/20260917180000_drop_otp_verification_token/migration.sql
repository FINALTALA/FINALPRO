-- Sprint 2 review round 4: drop otp_codes.verificationToken. Storing a
-- bearer-equivalent credential in a permanently-retained, backed-up,
-- WAL-logged Postgres table was a real exposure the reviewer flagged -
-- the actual token now only ever exists in Redis, naturally bounded by
-- its own 15-minute TTL, never durably persisted anywhere. See
-- PhoneVerificationService's recovery-index methods and otp_codes'
-- consumedByKey doc comment in schema.prisma.
--
-- As with every prior migration here, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in the earlier migrations. Left alone again.

-- AlterTable
ALTER TABLE "otp_codes" DROP COLUMN "verificationToken";
