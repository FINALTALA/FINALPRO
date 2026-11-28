-- VIA phase 6 extension: the Women, Men and Kids pages join the Content Studio.
-- Additive only: three new values of the page-key enum (no table, row or
-- existing value changes).
ALTER TYPE "ContentPageKey" ADD VALUE IF NOT EXISTS 'WOMEN';
ALTER TYPE "ContentPageKey" ADD VALUE IF NOT EXISTS 'MEN';
ALTER TYPE "ContentPageKey" ADD VALUE IF NOT EXISTS 'KIDS';
