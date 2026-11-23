-- «ساعات العمل والإغلاقات v1» (additive): a day may have several working
-- periods (e.g. 09:00-14:00 and 16:00-21:00). The one-period-per-day unique
-- index goes; periods of the same branch and day may never overlap
-- (touching is fine: [open, close) ranges). The existing CHECK stays
-- (0 <= open < close <= 1440: no period crosses midnight; 24:00 only as an end).
DROP INDEX IF EXISTS "branch_operating_hours_vendorId_branchId_dayOfWeek_key";

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "branch_operating_hours" ADD CONSTRAINT "branch_operating_hours_no_overlap"
  EXCLUDE USING gist (
    "branchId" WITH =,
    "dayOfWeek" WITH =,
    int4range("openMinute", "closeMinute") WITH &&
  );
