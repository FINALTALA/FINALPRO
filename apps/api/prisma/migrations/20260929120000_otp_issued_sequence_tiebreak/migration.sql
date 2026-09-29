-- OTP checkCode() tie-break fix (Sprint 17 clean-room review, item 5
-- follow-up): otp_codes.createdAt is TIMESTAMP(3) - millisecond
-- resolution - and checkCode() picked the "latest" unconsumed row for
-- a (phone, purpose) pair by `ORDER BY "createdAt" DESC` alone. Two
-- rows tying at the same millisecond (real, fast, concurrent traffic
-- reaches this) had no guaranteed "latest wins" outcome - which of the
-- two rows was actually issued more recently was undefined. This adds
-- a DB-generated, monotonically increasing tie-break, independent of
-- wall-clock time.

-- ============================================================
-- 1. issuedSequence: a plain Postgres sequence-backed column, not
--    GENERATED ALWAYS AS IDENTITY - a strict IDENTITY column refuses
--    any explicit INSERT value, which this migration's own backfill
--    (and, separately, this fix's own e2e test, which must construct
--    two rows with an identical createdAt but a controlled sequence
--    order) both need to be able to do.
-- ============================================================

CREATE SEQUENCE "otp_codes_issuedsequence_seq" AS INTEGER;

ALTER TABLE "otp_codes" ADD COLUMN "issuedSequence" INTEGER NOT NULL DEFAULT nextval('otp_codes_issuedsequence_seq');

ALTER SEQUENCE "otp_codes_issuedsequence_seq" OWNED BY "otp_codes"."issuedSequence";

-- ============================================================
-- 2. Explicit, honest handling of pre-existing unconsumed rows
--    (never silently assumed safe): backfilling issuedSequence onto
--    rows that already existed necessarily assigns them SOME value,
--    but Postgres does not document (and this migration does not
--    rely on) that value reflecting each row's true original issuance
--    order relative to another pre-existing row it happens to tie
--    with on createdAt - claiming otherwise would be dishonest. OTP
--    codes are short-lived (5 minutes, OtpService.CODE_TTL_MS) and
--    security-sensitive, so every pre-existing row that was never
--    consumed is force-expired here instead: checkCode()'s own
--    `expiresAt < now()` check then correctly refuses it regardless
--    of whatever issuedSequence value the backfill above gave it,
--    making the backfill-order ambiguity moot rather than papered
--    over. A genuine, already-expired-in-reality row is unaffected in
--    substance (it could never have passed the expiry check either
--    way); a row that happened to still be technically unexpired at
--    migration time now correctly requires the holder to request a
--    fresh one - a trivial, expected UX cost for an OTP, not a
--    security regression.
UPDATE "otp_codes" SET "expiresAt" = TIMESTAMP '1970-01-01 00:00:00' WHERE "consumedAt" IS NULL;

-- ============================================================
-- 3. Index matching checkCode()'s exact query shape (WHERE phone,
--    purpose, consumedAt IS NULL; ORDER BY createdAt DESC, then
--    issuedSequence DESC as the tie-break) - replaces the old, now-
--    redundant (phone, purpose) index, which every query already
--    covered by this wider one used.
-- ============================================================

DROP INDEX IF EXISTS "otp_codes_phone_purpose_idx";

CREATE INDEX "otp_codes_phone_purpose_consumedAt_createdAt_issuedSequence_idx" ON "otp_codes"("phone", "purpose", "consumedAt", "createdAt", "issuedSequence");
