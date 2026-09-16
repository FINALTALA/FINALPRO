-- AlterTable: every AuditLog row must carry the correlation id of the
-- request/job that produced it (Part 4, H.1). Table is empty in every
-- environment this migration has run against so far (Sprint 1,
-- pre-launch) - safe as a NOT NULL add with no default.
ALTER TABLE "audit_logs" ADD COLUMN "correlationId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "audit_logs_correlationId_idx" ON "audit_logs"("correlationId");

-- DropTable: idempotency_keys is restructured for atomic-claim
-- semantics (Part 4, H.1 fix) - the old (key)-only-primary-key shape
-- could not express the "one in-flight claim per key+scope+path" model
-- and is fully superseded, not incrementally alterable.
DROP TABLE "idempotency_keys";

-- CreateEnum
CREATE TYPE "IdempotencyKeyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestPath" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyKeyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseBody" JSONB,
    "responseCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: this unique constraint IS the atomicity mechanism the
-- interceptor relies on - two concurrent INSERTs for the same
-- (key, scope, requestPath) can only ever have one winner, enforced by
-- Postgres itself, not application-level timing.
CREATE UNIQUE INDEX "idempotency_lookup" ON "idempotency_keys"("key", "scope", "requestPath");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");
