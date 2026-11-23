-- «نوافذ التوصيل v1» (additive only).
-- 1) A weekly window can be PAUSED instead of deleted (a window with any
--    order history can never be deleted): it stops being offered, its
--    history stays, the owner can resume it. The reason is kept with it.
ALTER TABLE "delivery_windows"
  ADD COLUMN "pausedAt" TIMESTAMPTZ(3),
  ADD COLUMN "pausedReason" TEXT;

ALTER TABLE "delivery_windows"
  ADD CONSTRAINT "delivery_windows_paused_reason_check"
  CHECK ("pausedAt" IS NULL OR "pausedReason" IS NOT NULL);

-- A paused window no longer holds its time range: the way to change a
-- used window's day/time is to pause it and create a new one, which may
-- overlap the paused one. Non-overlap stays guaranteed between ACTIVE
-- (not paused) windows; resuming re-checks it (same constraint).
ALTER TABLE "delivery_windows" DROP CONSTRAINT "delivery_windows_no_overlap";
ALTER TABLE "delivery_windows" ADD CONSTRAINT "delivery_windows_no_overlap"
  EXCLUDE USING gist (
    "branchId" WITH =,
    "dayOfWeek" WITH =,
    int4range("startMinute", "endMinute") WITH &&
  ) WHERE ("pausedAt" IS NULL);

-- 2) One date of one window can stop NEW bookings (existing orders stay),
--    with a mandatory reason. Closed and booking-stopped are exclusive,
--    and a booking stop never carries a capacity override.
ALTER TABLE "delivery_window_exceptions"
  ADD COLUMN "bookingStopped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reason" TEXT;

ALTER TABLE "delivery_window_exceptions"
  ADD CONSTRAINT "delivery_window_exceptions_kind_check"
  CHECK (
    NOT ("isClosed" AND "bookingStopped")
    AND (NOT "bookingStopped" OR "capacityOverride" IS NULL)
  );
