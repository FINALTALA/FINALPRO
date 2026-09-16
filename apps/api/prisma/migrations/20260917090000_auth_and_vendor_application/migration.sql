-- Sprint 2 (EPIC-AUTH, BL-VEND-001): identity, customer address capture,
-- OTP, and vendor application. Generated via `prisma migrate diff`
-- against the live dev database, then reviewed by hand before applying
-- (`prisma migrate dev` still refuses to run non-interactively in this
-- environment - see prior migrations' notes).
--
-- One line the generated diff produced was deliberately dropped: it
-- proposed renaming the existing `idempotency_lookup` unique index to
-- Prisma's default naming convention. That's a pre-existing, purely
-- cosmetic mismatch between the physical SQL index name (set by the
-- Sprint 1 hand-written migration) and Prisma's auto-generated naming
-- convention (since schema.prisma's `@@unique(..., name: "idempotency_lookup")`
-- only pins the Prisma Client-level field name, not the SQL name,
-- absent an explicit `map:`). It doesn't affect correctness - the
-- interceptor only ever references the Prisma Client-level name - and
-- renaming it here would be an unexplained, unrelated change riding
-- along in an auth/vendor migration. Left alone.
--
-- The `users` table had zero rows when this ran (confirmed directly),
-- so the new NOT NULL columns below (phone, passwordHash) are safe to
-- add without a default or a data backfill.

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP', 'PASSWORD_RESET', 'PHONE_CHANGE');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('APPLIED', 'UNDER_REVIEW', 'REJECTED', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VendorUserRole" AS ENUM ('OWNER');

-- CreateEnum
CREATE TYPE "BranchVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email" TEXT,
ADD COLUMN     "languagePref" TEXT NOT NULL DEFAULT 'ar',
ADD COLUMN     "passwordHash" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT NOT NULL,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "landmarkNote" TEXT,
    "phoneNumber1" TEXT NOT NULL,
    "phoneNumber2" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "status" "VendorStatus" NOT NULL DEFAULT 'APPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_users" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "role" "VendorUserRole" NOT NULL DEFAULT 'OWNER',

    CONSTRAINT "vendor_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_branches" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPhysical" BOOLEAN NOT NULL DEFAULT true,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "verificationPhotoUrl" TEXT,
    "verificationStatus" "BranchVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_userId_key" ON "customer_profiles"("userId");

-- CreateIndex
CREATE INDEX "addresses_customerId_idx" ON "addresses"("customerId");

-- CreateIndex
CREATE INDEX "otp_codes_phone_purpose_idx" ON "otp_codes"("phone", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_userId_vendorId_key" ON "vendor_users"("userId", "vendorId");

-- CreateIndex
CREATE INDEX "store_branches_vendorId_idx" ON "store_branches"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
