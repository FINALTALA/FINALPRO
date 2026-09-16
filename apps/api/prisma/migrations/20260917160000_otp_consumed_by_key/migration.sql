-- Sprint 2 review fix round 2 (correction found during its own
-- verification): scope OTP token recovery to the exact Idempotency-Key
-- that consumed it, not just a matching code - see otp_codes.consumedByKey's
-- doc comment in schema.prisma for why (a concurrent request that lost
-- the atomic consume() race could otherwise recover the winner's token).
--
-- As with every prior migration here, the generated diff also proposed
-- renaming the pre-existing `idempotency_lookup` index to Prisma's
-- default naming convention - the same pure-cosmetic, unrelated
-- mismatch documented in the earlier migrations. Left alone again.

-- AlterTable
ALTER TABLE "otp_codes" ADD COLUMN     "consumedByKey" TEXT;
