-- Read-supporting indexes for the import's view set, in the previous system's own database (BRIEF-v7-import-batch-hardening §1).
--
-- NOT a console migration. Apply it to the previous system's Supabase project as its owner (postgres), off-peak:
--
--   psql "<that project's postgres URL>" -v ON_ERROR_STOP=1 -f packages/isolated-backend/v7-source/v7_import_source_indexes.sql
--
-- It changes no data and no definition: only indexes, each built CONCURRENTLY (no write lock on the table while it builds) and
-- IF NOT EXISTS (safe to re-run). CONCURRENTLY cannot run inside a transaction, so this file has no BEGIN; psql runs each
-- statement on its own. If one is interrupted it can leave an INVALID index: the check at the end lists any, to drop and re-run.
--
-- What each serves (v7_import_views.sql; `EXPLAIN (ANALYZE, BUFFERS)` before/after in _handoff/STAGED-v7-import-batch-hardening.md).
-- None of these lookups is served by an index V7 already has. V7's own on factor_lookup are the primary key on db_id,
-- (dataset_id, year, scope, original_id), (dataset_id, TRIM(original_id)) and the trigram GINs (sql_migrations 0043, 0051, 0059):
--   * scope_rows / emission_sources, `own`: f.db_id::text = r.factor_db_id::text. The cast keeps the primary key out of use, so
--     each row walked the key in order — up to the whole table, per row. An index on the cast expression makes it one lookup.
--   * scope_rows, `ref2`: fl.original_id = trim(r.original_id) with no dataset. Every V7 index on original_id leads with
--     dataset_id, so each row scanned a whole index. An index on original_id alone serves it.
--   * scope_rows, `ref1`: fl.dataset_id = r.dataset_id AND fl.original_id = <the notes token>. V7's 4-column index puts year and
--     scope between the two, so it reads the dataset's whole range; (dataset_id, original_id) goes straight to the rows.

SET statement_timeout = 0;     -- an index build on ~270k rows outlasts a short session cap; this session only
SET lock_timeout = '10s';      -- never queue behind live traffic for long: fail, and re-run off-peak

CREATE INDEX CONCURRENTLY IF NOT EXISTS v7_import_factor_lookup_db_id_text_idx ON public.factor_lookup ((db_id::text));
CREATE INDEX CONCURRENTLY IF NOT EXISTS v7_import_factor_lookup_original_id_idx ON public.factor_lookup (original_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS v7_import_factor_lookup_dataset_original_idx ON public.factor_lookup (dataset_id, original_id);
ANALYZE public.factor_lookup;

-- The check: every index this file makes is valid (an interrupted CONCURRENTLY build leaves one INVALID — drop it, re-run).
SELECT c.relname AS index, i.indisvalid AS valid
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('v7_import_factor_lookup_db_id_text_idx', 'v7_import_factor_lookup_original_id_idx', 'v7_import_factor_lookup_dataset_original_idx')
 ORDER BY 1;
