BEGIN;

-- composed@5 (ACCEPT-composed5-checkpoint3, the migration ruling): Net Zero Commitment and Background & Organisation become
-- sections a plan may include (ACCEPT-composed5-checkpoint2, decision 3). Until now the validator allowed only
-- `included: false` for their plan keys (`narrative:net-zero-commitment`, `narrative:background`) — so a `false` stored before
-- today was never the client's choice. This turns those forced-offs ON, once, in the plans that still feed new reports; every
-- `false` written after it is a deliberate choice and is respected.
--
-- What it touches, and what it never does:
--   1. A client's active report profile holding either key off gets a NEW profile version with both on — the profile is
--      append-only (0164), so the version before stays readable, exactly as a re-save would leave it. The issuer line carries.
--   2. A report version still `validated` (not yet published) holding either key off has its plan turned on in place, with its
--      version bumped as `report.sectionPlan.update` bumps it — so a studio holding the old version is refused, not overwritten.
--   3. Never a published, superseded or withdrawn version, and never a frozen composition: `composed@1/2/3/4` reports and their
--      plans stay exactly as issued.
-- Idempotent: a second run finds nothing off.

CREATE TEMP TABLE standalone_narrative_keys(key text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO standalone_narrative_keys VALUES ('narrative:net-zero-commitment'), ('narrative:background');

-- The plan with both keys on, its order and every other entry unchanged.
CREATE FUNCTION pg_temp.standalone_on(plan jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_agg(CASE WHEN entry->>'key' IN (SELECT key FROM standalone_narrative_keys) THEN jsonb_set(entry, '{included}', 'true') ELSE entry END ORDER BY position)
  FROM jsonb_array_elements(plan) WITH ORDINALITY AS t(entry, position)
$$;
CREATE FUNCTION pg_temp.standalone_off(plan jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(plan) AS entry
                 WHERE entry->>'key' IN (SELECT key FROM standalone_narrative_keys) AND entry->'included' = 'false'::jsonb)
$$;

-- 1. Active profiles: a new version, both sections on.
INSERT INTO nzi_console.client_report_profiles (organisation_id, client_id, version, active, section_plan, issuer_line, set_by, correlation_id)
SELECT p.organisation_id, p.client_id, p.version + 1, true, pg_temp.standalone_on(p.section_plan), p.issuer_line,
       'migration:0167', 'migration:0167:standalone-narrative-on'
FROM nzi_console.client_report_profiles p
WHERE p.active
  AND p.version = (SELECT max(q.version) FROM nzi_console.client_report_profiles q WHERE (q.organisation_id, q.client_id) = (p.organisation_id, p.client_id))
  AND pg_temp.standalone_off(p.section_plan);

-- 2. Validated, unpublished versions: the plan on, the version bumped (origin stays: a profile's plan reads as that profile's).
UPDATE nzi_console.report_versions
SET section_plan = pg_temp.standalone_on(section_plan), version = version + 1
WHERE status = 'validated' AND section_plan IS NOT NULL AND pg_temp.standalone_off(section_plan);

COMMIT;
