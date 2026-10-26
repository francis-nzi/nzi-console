-- 0187 SRS S1: the framework managed as versions in the console, an assessment dated on completion, and the
-- gap→action link held (BUILD-srs-S1-framework-and-assessment, R1, R3, R7; DESIGN-actions-srs-workflows).
--
-- ## Extends 0070, does not fork it
--
-- 0070 already holds the versioned framework (standards · pillars · requirements · weights · the 0–4 five-step
-- ladder), assessments stamped with their framework version, the per-requirement maturity, evidence, owner, due,
-- source (entered | auto from NZI data) and `linked_action_id`, the sector and benchmark "Future" slots, and the
-- reassessment trend. (The brief's "0065" is v7's SRS migration; here it is 0070.) Three things were missing.
--
-- ## 1. Dated on completion (R3)
--
-- `assessed_on` was typed in when an assessment was started, so a half-finished assessment carried an "assessed"
-- date. Now: `started_on` is when it was opened; `assessed_on` is set when it is completed — and completing is
-- refused until every requirement is addressed (the command's rule). The database holds the shape: a complete
-- assessment has its assessed date, a draft has none.
--
-- Existing rows: `started_on` takes the date they carry. A draft's date moves to `started_on` and its `assessed_on`
-- clears — it was never assessed. A complete assessment keeps its date: it is the date the consultant recorded for
-- it, and rewriting it to the click of "complete" would change what reports already issued say.
--
-- ## 2. The gap→action link (R7)
--
-- `linked_action_id` has carried an action's id since 0070 with no foreign key ("the lever tables arrive in their own
-- migration"). It now references `client_strategies` — the Actions spine (A1) — so S3's bridging action is a real
-- one. NOT VALID: anything written before is left as it was rather than refused at deploy; every write from here on
-- is checked. The command also checks the action is this client's and still on the plan.
--
-- ## 3. A new framework version, made in the console (R1)
--
-- 0070 published versions by migration only. Now an Admin starts a **draft** version (a copy of the one in force,
-- version + 1), edits it — requirement wording, help, weight, target, active; the ladder's wording — and publishes
-- it, which supersedes the one before. A **published version never changes**: the triggers below refuse an edit to
-- any row of a framework that is not a draft, so an assessment always means what it meant. One draft at a time.
-- Nothing is deleted; a requirement is retired by `active = false` in the next version. The five steps themselves
-- (0–4) are fixed (R5): only their names and definitions are wording.

BEGIN;

-- ── 1. Dated on completion ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.srs_assessments ADD COLUMN started_on date;
UPDATE nzi_console.srs_assessments SET started_on = assessed_on;
ALTER TABLE nzi_console.srs_assessments ALTER COLUMN started_on SET NOT NULL;
ALTER TABLE nzi_console.srs_assessments ALTER COLUMN assessed_on DROP NOT NULL;
UPDATE nzi_console.srs_assessments SET assessed_on = NULL WHERE status = 'draft';
ALTER TABLE nzi_console.srs_assessments
  ADD CONSTRAINT srs_assessments_assessed_when_complete CHECK ((status = 'complete') = (assessed_on IS NOT NULL));

DROP INDEX nzi_console.srs_assessments_client_idx;
CREATE INDEX srs_assessments_client_idx ON nzi_console.srs_assessments (organisation_id, client_id, coalesce(assessed_on, started_on) DESC, assessment_id DESC);
-- One assessment in progress per client — the command said so; now the database does too.
CREATE UNIQUE INDEX srs_assessments_one_draft ON nzi_console.srs_assessments (organisation_id, client_id) WHERE status = 'draft';

COMMENT ON COLUMN nzi_console.srs_assessments.started_on IS 'When the assessment was opened (S1, R3).';
COMMENT ON COLUMN nzi_console.srs_assessments.assessed_on IS 'When it was completed — every requirement addressed (S1, R3). Null while in progress: an assessment is not "assessed" until it is complete.';

-- ── 2. The gap→action link ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.srs_assessment_items
  ADD CONSTRAINT srs_assessment_items_linked_action_fk
    FOREIGN KEY (organisation_id, linked_action_id) REFERENCES nzi_console.client_strategies (organisation_id, client_strategy_id) NOT VALID;

-- ── 3. Framework versions made in the console ──────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX srs_frameworks_one_draft ON nzi_console.srs_frameworks (organisation_id) WHERE status = 'draft';

-- What a draft's editor may change. Published rows are held by the triggers below, not by these grants alone.
GRANT UPDATE (status, label, notes, effective_from, published_by, published_at) ON nzi_console.srs_frameworks TO nzi_console_app;
GRANT UPDATE (title, help_text, weight, target_maturity, active, ordering) ON nzi_console.srs_requirements TO nzi_console_app;
GRANT UPDATE (label, definition) ON nzi_console.srs_maturity_levels TO nzi_console_app;

-- A framework's status moves one way: draft → active → superseded. Its wording changes only while it is a draft.
CREATE FUNCTION nzi_console.srs_frameworks_published_is_fixed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'draft' AND NEW.status = 'active') OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'An SRS framework moves draft → active → superseded, never back (% → %).', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_frameworks_published_is_fixed';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.label IS DISTINCT FROM OLD.label OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'A published SRS framework version is never edited; start a new version.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_frameworks_published_is_fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER srs_frameworks_published_is_fixed BEFORE UPDATE ON nzi_console.srs_frameworks
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_frameworks_published_is_fixed();

-- A requirement or a ladder step may change only while its framework is a draft — the same rule for both tables.
CREATE FUNCTION nzi_console.srs_framework_rows_follow_their_draft() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  framework_status text;
BEGIN
  SELECT status INTO framework_status FROM nzi_console.srs_frameworks
   WHERE organisation_id = NEW.organisation_id AND framework_id = NEW.framework_id;
  IF framework_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'A published SRS framework version is never edited; start a new version.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_framework_rows_follow_their_draft';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER srs_requirements_follow_their_draft BEFORE UPDATE ON nzi_console.srs_requirements
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_framework_rows_follow_their_draft();
CREATE TRIGGER srs_maturity_levels_follow_their_draft BEFORE UPDATE ON nzi_console.srs_maturity_levels
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_framework_rows_follow_their_draft();

COMMIT;
