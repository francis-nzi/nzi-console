-- 0122 Scope rows the CRM quick-add stored with its option key as the factor id get the factor's own id
-- (NZC-162).
--
-- ## What was stored
--
-- The capture form keyed each factor option `<source>:<dataset or client factor>|<factor>` and, until #291, sent
-- that key as the factor id. So a quick-add entry with a picked factor was stored as `dataset:<d>|<f>` (or
-- `client:<c>|<f>`): a value no factor has. The unit check found nothing and stood aside, and calculation refused
-- it — the entry existed and could never be counted. #291 stops new ones; this repairs the ones already there.
--
-- ## Only where the key agrees with the row it sits on
--
--   * `dataset:<d>|<f>` becomes `<f>` when `<d>` is the row's own `dataset_id` **and** that dataset carries `<f>`.
--   * `client:<c>|<f>` becomes `<f>` when `<c>` is the row's own `client_factor_id`.
--
-- Anything else key-shaped — a dataset part that is not the row's, a factor its dataset does not carry, a client
-- part that is not the row's — is **refused before anything changes**, with the count. Guessing which of two
-- disagreeing identities was meant would be choosing a factor for somebody, which is the thing this track exists
-- to stop. The migration stops and says what to establish.
--
-- ## It calculates nothing
--
-- These rows were never calculated, because calculation refused them. Rewriting the id makes them calculable; it
-- does not calculate them, so no reported number moves when this runs. Each repaired row's version is bumped, and
-- its provenance records the value it replaced and that this migration replaced it.
--
-- ## One tenant at a time, because row-level security is forced
--
-- `job_scope_rows` has FORCE ROW LEVEL SECURITY with a policy on `app.organisation_id`. A migration that read it
-- with no tenant set would see nothing unless the migrating role happens to bypass policies — which it does on CI
-- and on Supabase, and which 0104 already found is not something to rely on. So this sets each organisation's
-- context in turn, and at the end re-counts: if a key-shaped row is left anywhere, it has not done what it says,
-- and it stops rather than report success.

BEGIN;

DO $$
DECLARE
  org text;
  refused integer := 0;
  repaired integer := 0;
  remaining integer := 0;
  n integer;
BEGIN
  -- First pass: count what cannot be repaired, in every tenant, before changing anything.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT count(*) INTO n
      FROM nzi_console.job_scope_rows r
     WHERE r.organisation_id = org
       AND r.factor_id ~ '^(dataset|client):[^|]*\|'
       AND NOT (
         (r.factor_id LIKE 'dataset:%'
           AND split_part(substr(r.factor_id, 9), '|', 1) = r.dataset_id
           AND EXISTS (SELECT 1 FROM nzi_console.emission_factors f
                        WHERE f.organisation_id = r.organisation_id AND f.dataset_id = r.dataset_id
                          AND f.factor_id = substr(r.factor_id, strpos(r.factor_id, '|') + 1)))
         OR
         (r.factor_id LIKE 'client:%'
           AND split_part(substr(r.factor_id, 8), '|', 1) = r.client_factor_id));
    refused := refused + n;
  END LOOP;

  IF refused > 0 THEN
    RAISE EXCEPTION '0122: % scope row(s) hold a factor id shaped like the capture form''s option key that does not agree with the row it sits on (a dataset other than the row''s, a factor its dataset does not carry, or a client factor other than the row''s). Nothing has been changed. Establish which factor each was meant to be before repairing them.', refused;
  END IF;

  -- Second pass: repair, tenant by tenant.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    UPDATE nzi_console.job_scope_rows r
       SET factor_id = substr(r.factor_id, strpos(r.factor_id, '|') + 1),
           version = r.version + 1,
           updated_at = now(),
           provenance_json = r.provenance_json || jsonb_build_object('factorIdRepair',
             jsonb_build_object('by', 'migration:0122', 'was', r.factor_id))
     WHERE r.organisation_id = org
       AND r.factor_id ~ '^(dataset|client):[^|]*\|';
    GET DIAGNOSTICS n = ROW_COUNT;
    repaired := repaired + n;
  END LOOP;

  -- And prove it: nothing key-shaped is left in any tenant.
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    SELECT count(*) INTO n FROM nzi_console.job_scope_rows
     WHERE organisation_id = org AND factor_id ~ '^(dataset|client):[^|]*\|';
    remaining := remaining + n;
  END LOOP;
  IF remaining > 0 THEN
    RAISE EXCEPTION '0122 repaired % row(s) but % key-shaped factor id(s) remain; it has not done what it says.', repaired, remaining;
  END IF;

  RAISE NOTICE '0122 repaired % scope row(s) stored with the capture form''s option key.', repaired;
END $$;

COMMIT;
