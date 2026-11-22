-- TB-12.2: who receives each category of platform alert. Additive only -
-- a new enum and a new table; no existing value, row or column changes.
-- Runs after 20261102120000_tb9_order_integrity_alert.

-- CreateEnum
CREATE TYPE "PlatformAlertCategory" AS ENUM ('ORDER_INTEGRITY', 'RETURN_ESCALATION');

-- CreateTable
CREATE TABLE "platform_alert_recipients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "PlatformAlertCategory" NOT NULL,
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_alert_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_alert_recipients_category_idx" ON "platform_alert_recipients"("category");

-- CreateIndex
CREATE UNIQUE INDEX "platform_alert_recipients_userId_category_key" ON "platform_alert_recipients"("userId", "category");

-- AddForeignKey
ALTER TABLE "platform_alert_recipients" ADD CONSTRAINT "platform_alert_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_alert_recipients" ADD CONSTRAINT "platform_alert_recipients_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
