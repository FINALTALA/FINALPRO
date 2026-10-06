-- Sprint 17b: new enum types, split into their own migration, same
-- reason as Sprint 19's own enum-value migration split - ALTER TYPE
-- ... ADD VALUE cannot be used in the same transaction/batch that adds
-- it when applied via a raw multi-statement pg.Client (as this
-- project's own migration-level e2e tests do) - Postgres rejects it as
-- "unsafe use of new value". CREATE TYPE itself has no such
-- restriction, but MERGED is split out here preemptively for the same
-- test-safety reason.
CREATE TYPE "ProductType" AS ENUM ('PHYSICAL', 'BUNDLE', 'SERVICE');

CREATE TYPE "MatchCandidateSource" AS ENUM ('NON_EXACT_SCORE', 'EXACT_IDENTIFIER');

ALTER TYPE "CanonicalProductStatus" ADD VALUE 'MERGED';
