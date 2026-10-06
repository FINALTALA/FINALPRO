-- Sprint 19: split into its own migration, deliberately BEFORE the
-- rest of this sprint's schema changes (which depend on these values,
-- e.g. the legacy-row backfill UPDATE in the next migration sets
-- status = 'DEAD_LETTER'). Postgres refuses to use a newly-added enum
-- value inside the same transaction/statement batch that added it;
-- the next migration runs as its own separate migration file (its own
-- transaction), so this split is what actually makes that usage safe
-- - not just a style preference.
ALTER TYPE "OutboxEventStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "OutboxEventStatus" ADD VALUE 'DEAD_LETTER';
