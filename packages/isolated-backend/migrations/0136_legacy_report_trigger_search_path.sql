-- 0136 Pin the search_path on 0135's legacy-report trigger function (fix-forward).
--
-- ## Why
--
-- Every function in the schema pins `SET search_path = nzi_console, pg_temp`, so an object planted earlier on a
-- caller's path can never be resolved in its place. 0135's `refuse_legacy_report_version_change()` merged without
-- it. It is not exploitable — the body resolves nothing through the path (`to_jsonb`, `RAISE`, the NEW/OLD
-- records) and it is not SECURITY DEFINER — but it is the one function that breaks the rule, and 0135 is frozen,
-- so the correction is its own migration.
--
-- ## What it changes
--
-- The function is replaced with an identical body plus the pinned search_path, matching 0133's
-- `refuse_migrated_scope_row_change()`. The triggers that call it are unchanged: they bind to the function by
-- identity, which CREATE OR REPLACE preserves.

BEGIN;

CREATE OR REPLACE FUNCTION nzi_console.refuse_legacy_report_version_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = nzi_console, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy report versions are records of account and are never deleted (%)', OLD.legacy_report_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The one reserved change: destroying the content key, with who and when. Everything else stays as imported.
  IF OLD.content_key_wrapped IS NOT NULL AND NEW.content_key_wrapped IS NULL
     AND (to_jsonb(NEW) - ARRAY['content_key_wrapped','content_key_shredded_at','content_key_shredded_by'])
       = (to_jsonb(OLD) - ARRAY['content_key_wrapped','content_key_shredded_at','content_key_shredded_by']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legacy report versions are immutable records of account (%)', OLD.legacy_report_id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMIT;
