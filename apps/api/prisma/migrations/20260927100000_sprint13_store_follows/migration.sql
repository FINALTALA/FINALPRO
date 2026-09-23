-- Sprint 13 (RB-STOREF-003): additive table for "stores a customer follows".
-- No existing table is altered.

-- CreateTable
CREATE TABLE "store_follows" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_follows_vendorId_idx" ON "store_follows"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "store_follows_userId_vendorId_key" ON "store_follows"("userId", "vendorId");

-- AddForeignKey
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_follows" ADD CONSTRAINT "store_follows_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
