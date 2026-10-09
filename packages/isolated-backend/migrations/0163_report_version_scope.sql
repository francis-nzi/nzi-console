BEGIN;

-- Reporting S-1 (ruled 8 Oct 2026: RULING-reporting-site-scope.md R-S1/R-S2 as updated, RULING-reporting-S.md) — a report
-- version records the scope it was validated at: the whole client, or a set of the snapshot's sites. Several published
-- reports may stand for one job, one per scope: a whole-client report and per-site reports live side by side.
--
-- The snapshot is untouched (R-S1 (A′)): a scoped figure is a filter of the frozen per-row measurements, composed per
-- version. Only `report_versions` changes. Existing rows are whole-client, which is what they always were.
--
-- "Every site" is not "whole client" (ruled): a site scope excludes organisation-level (unallocated) emissions, so the two
-- are different reports with different keys, never normalised into one.

-- The site set, canonical: sorted and distinct, so one view has one key. The command sorts as well; this is the table's own
-- guarantee.
CREATE FUNCTION nzi_console.sorted_distinct_text(items text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT coalesce(array_agg(item ORDER BY item), '{}') FROM (SELECT DISTINCT unnest(items) AS item) AS distinct_items $$;

-- The scope's key: 'whole', or 'sites:' and the sorted ids. Declared IMMUTABLE so the generated column may use it; over a
-- text[] it is.
CREATE FUNCTION nzi_console.report_scope_key(kind text, site_ids text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN kind = 'whole' THEN 'whole' ELSE 'sites:' || array_to_string(site_ids, ',') END $$;

GRANT EXECUTE ON FUNCTION nzi_console.sorted_distinct_text(text[]) TO nzi_console_app;
GRANT EXECUTE ON FUNCTION nzi_console.report_scope_key(text, text[]) TO nzi_console_app;

ALTER TABLE nzi_console.report_versions
  ADD COLUMN scope_kind text NOT NULL DEFAULT 'whole' CHECK (scope_kind IN ('whole', 'sites')),
  ADD COLUMN scope_site_ids text[],
  ADD CONSTRAINT report_versions_scope_shape CHECK (
    (scope_kind = 'whole' AND scope_site_ids IS NULL)
    OR (scope_kind = 'sites' AND cardinality(scope_site_ids) >= 1
        AND array_position(scope_site_ids, NULL) IS NULL
        AND scope_site_ids = nzi_console.sorted_distinct_text(scope_site_ids))),
  ADD COLUMN scope_key text GENERATED ALWAYS AS (nzi_console.report_scope_key(scope_kind, scope_site_ids)) STORED;

-- 0016, re-keyed on scope: the same reviewed snapshot and manifest may be validated once per scope.
DROP INDEX nzi_console.report_version_validated_snapshot_unique;
CREATE UNIQUE INDEX report_version_validated_snapshot_scope_unique
  ON nzi_console.report_versions (organisation_id, reviewed_snapshot_id, manifest_version, scope_key)
  WHERE status IN ('validated', 'published');

-- 0017, relaxed: one published report per job **per scope**. Publishing supersedes the same scope only.
DROP INDEX nzi_console.report_version_one_published_per_job;
CREATE UNIQUE INDEX report_version_one_published_per_job_scope
  ON nzi_console.report_versions (organisation_id, job_id, scope_key)
  WHERE status = 'published';

COMMIT;
