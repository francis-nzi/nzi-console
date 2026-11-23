-- The plans of one job's three heavy reads from the import's view set, on the previous system's own database
-- (BRIEF-v7-import-batch-hardening §1). For Francis, to confirm on V7 what the local bench shows.
--
--   psql "<that project's postgres URL>" -v job_id=<a V7 job_id> -f packages/isolated-backend/v7-source/v7_import_explain.sql
--
-- Plain EXPLAIN: the queries are PLANNED, not run — it costs the source nothing, safe on Micro at any hour. Before the indexes and
-- the view change, look for "Seq Scan on factor_lookup" under SubPlan (one per allow-list test) and the `own` lookup's
-- "Filter: ((db_id)::text = ...)" on factor_lookup_pkey. After: one allow-list build per query, and the v7_import_* indexes.
--
-- To MEASURE (EXPLAIN ANALYZE runs the query once — the expensive read, before the fix): only on sized-up compute, off-peak,
-- and only by swapping EXPLAIN for EXPLAIN (ANALYZE, BUFFERS) below by hand.

\set ON_ERROR_STOP on
SET statement_timeout = '60s';
\echo '### scope_rows'
EXPLAIN SELECT * FROM v7_import.scope_rows WHERE job_id = :job_id ORDER BY row_id;
\echo '### emission_sources'
EXPLAIN SELECT * FROM v7_import.emission_sources WHERE job_id = :job_id ORDER BY source_id;
\echo '### factor_labels (the label comparison)'
EXPLAIN SELECT label FROM v7_import.factor_labels WHERE label = ANY(ARRAY['Scope 1', 'Natural gas']::text[]);
