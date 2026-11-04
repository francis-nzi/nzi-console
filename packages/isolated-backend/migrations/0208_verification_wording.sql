-- 0208 NZI offers emissions verification, not assurance: stored wording says "verification" / "verified" (NZC-170).
--
-- ## Why
--
-- The console, the portal and the current report layouts now say "Verification" / "Verified" (the code is swept and `check:terminology`
-- guards it). Wording that is *stored* rather than in code does not follow a deploy, so it is rewritten here, per row, audited, exactly as
-- 0180 and 0207 did for saved email wording.
--
-- ## What it rewrites, and what it leaves
--
-- 1. **The seeded UK SRS framework**, in every organisation and every framework version, by exact string:
--    - maturity level 4's label `Assured` → `Verified`, and its definition
--      `Independently assured or externally verified, and ready to withstand scrutiny.` → `Independently verified, and ready to withstand scrutiny.`
--    - requirement S2 M13's title `GHG inventory independently assured` → `GHG inventory independently verified`, and its help text
--      `Whether the inventory has been externally verified or assured, by whom, and to what standard.` →
--      `Whether the inventory has been externally verified, by whom, and to what standard.`
--    The level's `key` (`assured`) and the requirement's `nzi_source_key` (`footprint.assurance`) are identifiers, not wording, and stay.
--    A published framework version is "never edited" (0187's row triggers). This is a wording correction, not a new version of the
--    framework, so those two triggers are lifted for the rewrite *inside this transaction* and re-enabled before it commits (asserted
--    below); nothing else about a published version changes. Every changed row is audited with its before and after.
-- 2. **The seeding function** `provision_organisation` is re-created from its own definition with the same four strings replaced, so an
--    organisation provisioned from now on starts with the new wording (it would otherwise re-introduce the old one).
-- 3. **Saved message wording** (`message_templates`: subject, body, HTML body): any standalone `assurance` / `assured` / `assure`,
--    case-aware, version bumped, `updated_by` left as it was (the v7 loader reads that as "still as imported"), audited per row.
--
-- Left alone: identifiers (tables, columns, command and permission keys, CSS), and free text people typed (knowledge entries, notes).
-- Re-running changes nothing: every step matches the old strings only.

BEGIN;

-- ── 1. The seeded SRS framework ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE nzi_console.srs_maturity_levels DISABLE TRIGGER srs_maturity_levels_follow_their_draft;
ALTER TABLE nzi_console.srs_requirements DISABLE TRIGGER srs_requirements_follow_their_draft;

WITH rewritten AS (
  UPDATE nzi_console.srs_maturity_levels l
     SET label = CASE WHEN l.label = 'Assured' THEN 'Verified' ELSE l.label END,
         definition = CASE WHEN l.definition = 'Independently assured or externally verified, and ready to withstand scrutiny.'
                           THEN 'Independently verified, and ready to withstand scrutiny.' ELSE l.definition END
    FROM nzi_console.srs_maturity_levels before
   WHERE (before.organisation_id, before.framework_id, before.level) = (l.organisation_id, l.framework_id, l.level)
     AND (l.label = 'Assured' OR l.definition = 'Independently assured or externally verified, and ready to withstand scrutiny.')
  RETURNING l.organisation_id, l.framework_id, l.level, before.label AS before_label, before.definition AS before_definition, l.label, l.definition
)
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
SELECT r.organisation_id, gen_random_uuid()::text, 'migration:0208', 'system', 'srs_framework.wording_updated', 'srs_maturity_level',
       r.framework_id || ':' || r.level, 'migration:0208',
       'NZI offers emissions verification, not assurance (NZC-170): the maturity level reads "Verified". Wording only; the level, its key and its meaning are unchanged.',
       jsonb_build_object('frameworkId', r.framework_id, 'level', r.level, 'label', r.before_label, 'definition', r.before_definition),
       jsonb_build_object('frameworkId', r.framework_id, 'level', r.level, 'label', r.label, 'definition', r.definition)
  FROM rewritten r;

WITH rewritten AS (
  UPDATE nzi_console.srs_requirements q
     SET title = CASE WHEN q.title = 'GHG inventory independently assured' THEN 'GHG inventory independently verified' ELSE q.title END,
         help_text = CASE WHEN q.help_text = 'Whether the inventory has been externally verified or assured, by whom, and to what standard.'
                          THEN 'Whether the inventory has been externally verified, by whom, and to what standard.' ELSE q.help_text END
    FROM nzi_console.srs_requirements before
   WHERE (before.organisation_id, before.framework_id, before.requirement_id) = (q.organisation_id, q.framework_id, q.requirement_id)
     AND (q.title = 'GHG inventory independently assured'
          OR q.help_text = 'Whether the inventory has been externally verified or assured, by whom, and to what standard.')
  RETURNING q.organisation_id, q.framework_id, q.requirement_id, before.title AS before_title, before.help_text AS before_help, q.title, q.help_text
)
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
SELECT r.organisation_id, gen_random_uuid()::text, 'migration:0208', 'system', 'srs_framework.wording_updated', 'srs_requirement',
       r.framework_id || ':' || r.requirement_id, 'migration:0208',
       'NZI offers emissions verification, not assurance (NZC-170): the requirement reads "verified". Wording only; its code, source and target are unchanged.',
       jsonb_build_object('frameworkId', r.framework_id, 'requirementId', r.requirement_id, 'title', r.before_title, 'helpText', r.before_help),
       jsonb_build_object('frameworkId', r.framework_id, 'requirementId', r.requirement_id, 'title', r.title, 'helpText', r.help_text)
  FROM rewritten r;

ALTER TABLE nzi_console.srs_maturity_levels ENABLE TRIGGER srs_maturity_levels_follow_their_draft;
ALTER TABLE nzi_console.srs_requirements ENABLE TRIGGER srs_requirements_follow_their_draft;

-- ── 2. The seeding function, so a new organisation starts with the new wording ────────────────────────────────────
DO $$
DECLARE
  definition text := pg_get_functiondef('nzi_console.provision_organisation(text)'::regprocedure);
  rewritten text;
BEGIN
  rewritten := replace(definition, $q$(4, 'assured', 'Assured', 'Independently assured or externally verified, and ready to withstand scrutiny.')$q$,
                                   $q$(4, 'assured', 'Verified', 'Independently verified, and ready to withstand scrutiny.')$q$);
  rewritten := replace(rewritten, $q$'GHG inventory independently assured','Whether the inventory has been externally verified or assured, by whom, and to what standard.'$q$,
                                  $q$'GHG inventory independently verified','Whether the inventory has been externally verified, by whom, and to what standard.'$q$);
  IF rewritten <> definition THEN
    EXECUTE rewritten;
  END IF;
END $$;

-- ── 3. Saved message wording ─────────────────────────────────────────────────────────────────────────────────────
-- Session-local (it vanishes with the connection): case-aware, whole words only; null stays null.
CREATE OR REPLACE FUNCTION pg_temp.verification_wording(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace($1,
    '\mAssurance\M', 'Verification', 'g'), '\massurance\M', 'verification', 'g'),
    '\mAssured\M', 'Verified', 'g'), '\massured\M', 'verified', 'g'),
    '\mAssure\M', 'Verify', 'g'), '\massure\M', 'verify', 'g')
$f$;

WITH rewritten AS (
  UPDATE nzi_console.message_templates t
     SET subject = pg_temp.verification_wording(t.subject),
         body = pg_temp.verification_wording(t.body),
         html_body = pg_temp.verification_wording(t.html_body),
         version = t.version + 1,
         updated_at = now()
    FROM nzi_console.message_templates before
   WHERE (before.organisation_id, before.template_key) = (t.organisation_id, t.template_key)
     AND (t.subject ~ '\m[Aa]ssur(ance|ed|e)\M' OR t.body ~ '\m[Aa]ssur(ance|ed|e)\M' OR coalesce(t.html_body, '') ~ '\m[Aa]ssur(ance|ed|e)\M')
  RETURNING t.organisation_id, t.template_key, t.version,
            before.subject AS before_subject, before.body AS before_body, before.html_body AS before_html, before.active AS active,
            t.subject, t.body, t.html_body
)
INSERT INTO nzi_console.audit_events
  (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
SELECT r.organisation_id, gen_random_uuid()::text, 'migration:0208', 'system', 'message_template.updated', 'message_template',
       r.template_key, 'migration:0208',
       'NZI offers emissions verification, not assurance (NZC-170): assurance → verification, assured → verified, assure → verify. Wording otherwise unchanged.',
       jsonb_build_object('templateKey', r.template_key, 'subject', r.before_subject, 'body', r.before_body, 'html', r.before_html, 'active', r.active),
       jsonb_build_object('templateKey', r.template_key, 'subject', r.subject, 'body', r.body, 'html', r.html_body, 'active', r.active, 'version', r.version)
  FROM rewritten r;

-- ── Asserted afterwards ─────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM nzi_console.srs_maturity_levels WHERE label = 'Assured' OR definition = 'Independently assured or externally verified, and ready to withstand scrutiny.') THEN
    RAISE EXCEPTION '0208: a maturity level still reads "Assured" after the rewrite.';
  END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.srs_requirements WHERE title = 'GHG inventory independently assured'
              OR help_text = 'Whether the inventory has been externally verified or assured, by whom, and to what standard.') THEN
    RAISE EXCEPTION '0208: a requirement still reads "assured" after the rewrite.';
  END IF;
  IF EXISTS (SELECT 1 FROM nzi_console.message_templates
              WHERE subject ~ '\m[Aa]ssur(ance|ed|e)\M' OR body ~ '\m[Aa]ssur(ance|ed|e)\M' OR coalesce(html_body, '') ~ '\m[Aa]ssur(ance|ed|e)\M') THEN
    RAISE EXCEPTION '0208: saved wording still says assurance / assured after the rewrite.';
  END IF;
  IF pg_get_functiondef('nzi_console.provision_organisation(text)'::regprocedure) LIKE '%GHG inventory independently assured%'
     OR pg_get_functiondef('nzi_console.provision_organisation(text)'::regprocedure) LIKE '%Independently assured or externally verified%' THEN
    RAISE EXCEPTION '0208: provision_organisation still seeds the old wording.';
  END IF;
  -- The immutability triggers are back on: only a wording correction in this transaction ever lifted them.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('srs_maturity_levels_follow_their_draft', 'srs_requirements_follow_their_draft') AND tgenabled <> 'O')
     OR (SELECT count(*) FROM pg_trigger WHERE tgname IN ('srs_maturity_levels_follow_their_draft', 'srs_requirements_follow_their_draft')) <> 2 THEN
    RAISE EXCEPTION '0208: a published-framework trigger is not enabled.';
  END IF;
END $$;

COMMIT;
