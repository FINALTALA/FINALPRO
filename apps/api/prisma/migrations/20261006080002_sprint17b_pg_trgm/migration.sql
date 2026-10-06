-- Sprint 17b (FR-CAT-009): enables Postgres trigram similarity for the
-- near-duplicate warning on Category/Brand/CanonicalProduct creation -
-- see duplicate-check.util.ts. Never used anywhere that requires a
-- schema change beyond the extension itself.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
