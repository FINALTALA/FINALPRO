-- VIA phase 3: a platform administrator's suspension of an account,
-- separate from the user's own deactivation ("deactivatedAt").
-- Additive only: three nullable columns, no existing row changes.
ALTER TABLE "users" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "suspensionReason" TEXT;
ALTER TABLE "users" ADD COLUMN "suspendedById" TEXT;

-- A suspension always has its reason and its administrator; none has neither.
ALTER TABLE "users" ADD CONSTRAINT "users_suspension_shape" CHECK (
  ("suspendedAt" IS NULL AND "suspensionReason" IS NULL AND "suspendedById" IS NULL)
  OR ("suspendedAt" IS NOT NULL AND "suspendedById" IS NOT NULL
      AND char_length(btrim("suspensionReason")) BETWEEN 5 AND 500)
);

ALTER TABLE "users" ADD CONSTRAINT "users_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
