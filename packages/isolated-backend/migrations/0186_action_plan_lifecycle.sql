-- 0186 Actions A1: the plan's status ladder, an owner who is a client contact, and where an action came from
-- (BUILD-actions-A1-library-and-plan, R2–R7; DESIGN-actions-srs-workflows).
--
-- ## Extends, does not fork
--
-- The action/lever library and the per-client plan already exist: 0075 built them, 0078 split them into
-- `levers` (the themes), `reduction_strategies` (the library), `strategy_levers` (M:N) and `client_strategies`
-- (the plan), 0081 added `include_in_report` and the SRS alignment, 0083 the reminder log, 0085 the estimate.
-- (The brief's "0064" is v7's lever migration, not this repository's — here 0064 is site floor area.) A1 adds
-- to `client_strategies` only what the settled decisions (26 Oct) need and the model lacks.
--
-- ## 1. The status ladder (R3)
--
-- Proposed → Agreed → In progress → Complete, with Declined and On hold at the edges. The values are held here;
-- which move is legal from which state is the command's rule (`strategyTransitionAllowed`), said once in
-- @nzi/contracts so the form only offers what the command accepts.
--
-- Existing rows: `planned` becomes `agreed`. Every planned row was put on the plan by a consultant and has been
-- presented as the client's plan (in reports, in the portal) — it is agreed in everything but name, and moving it
-- back to `proposed` would silently drop it from the next report. `in_progress` and `complete` are unchanged, and
-- 0075's rule that complete means 100% stands. Reports already issued keep saying "planned": their compositions
-- are frozen JSON, and the renderer still has a label for it.
--
-- ## 2. The owner is a client contact (R4)
--
-- `owner_contact_id` references `client_contacts` **through the client**: the foreign key includes `client_id`,
-- so an owner from another client's team is refused by the database, not only by the command — the hole v7 had.
-- A unique key on `client_contacts (organisation_id, client_id, contact_id)` is added for the reference (the
-- contact id is already unique; this only lets a foreign key name the client beside it).
--
-- 0075's free-text `owner` was never a contact — "Facilities team", "Jo (FD)". It is renamed
-- `legacy_owner_text` and kept, read only where no contact has been chosen, and cleared when one is: one term,
-- one meaning, without throwing away what a consultant typed.
--
-- ## 3. Where an action came from (R6, R7)
--
-- `origin`: `plan` (a consultant built it into the plan — every existing row), `srs_gap` (written from a UK SRS
-- gap — S3's path into this same spine), or `client_proposal` (a client's custom action in the portal — A2's).
-- An `srs_gap` action names the requirement it bridges, through the framework it belongs to, as the SRS
-- alignment does (0081). Whether it came from the library is already the row's shape (`strategy_id`, or the
-- bespoke columns), so promoting a bespoke action into the library later (A2) has what it needs.
--
-- Origin is a fact about the past: set when the action is created, never changed after (a trigger holds it).

BEGIN;

-- ── 1. The ladder ───────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_strategies DROP CONSTRAINT client_strategies_status_check;
-- An UPDATE on client_strategies queues 0081's deferred alignment check for every row it touches, and Postgres refuses
-- any later ALTER of the table while such events are pending. Checked at the end of this statement instead — every
-- existing row already has its alignment — so the DDL below can follow it in the same transaction.
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE nzi_console.client_strategies SET status = 'agreed' WHERE status = 'planned';
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE nzi_console.client_strategies
  ALTER COLUMN status SET DEFAULT 'proposed',
  ADD CONSTRAINT client_strategies_status_check
    CHECK (status IN ('proposed', 'agreed', 'in_progress', 'complete', 'on_hold', 'declined'));

COMMENT ON COLUMN nzi_console.client_strategies.status IS
  'The ladder (A1, R3): proposed → agreed → in_progress → complete, with on_hold and declined. Legal moves are the command''s rule (strategyTransitionAllowed). Only agreed, in_progress and complete compose into a report.';

-- ── 2. The owner ────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_contacts
  ADD CONSTRAINT client_contacts_client_contact_key UNIQUE (organisation_id, client_id, contact_id);

ALTER TABLE nzi_console.client_strategies RENAME COLUMN owner TO legacy_owner_text;
ALTER TABLE nzi_console.client_strategies
  ADD COLUMN owner_contact_id text,
  ADD CONSTRAINT client_strategies_owner_contact_fk
    FOREIGN KEY (organisation_id, client_id, owner_contact_id)
    REFERENCES nzi_console.client_contacts (organisation_id, client_id, contact_id);
CREATE INDEX client_strategies_owner_idx ON nzi_console.client_strategies (organisation_id, owner_contact_id) WHERE owner_contact_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.client_strategies.owner_contact_id IS
  'The action''s owner (A1, R4): one of this client''s contacts — the foreign key runs through client_id, so another client''s contact cannot be named.';
COMMENT ON COLUMN nzi_console.client_strategies.legacy_owner_text IS
  'What 0075''s free-text owner held. Shown only while no contact is chosen, and cleared when one is. Never written otherwise.';

-- ── 3. The origin ───────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.client_strategies
  ADD COLUMN origin text NOT NULL DEFAULT 'plan' CHECK (origin IN ('plan', 'srs_gap', 'client_proposal')),
  ADD COLUMN origin_srs_framework_id text,
  ADD COLUMN origin_srs_requirement_id text,
  ADD CONSTRAINT client_strategies_origin_requirement_fk
    FOREIGN KEY (organisation_id, origin_srs_framework_id, origin_srs_requirement_id)
    REFERENCES nzi_console.srs_requirements (organisation_id, framework_id, requirement_id),
  -- A gap-bridging action names its gap; nothing else names one.
  ADD CONSTRAINT client_strategies_origin_gap_shape CHECK (
    (origin = 'srs_gap') = (origin_srs_requirement_id IS NOT NULL AND origin_srs_framework_id IS NOT NULL)
    AND (origin_srs_requirement_id IS NULL) = (origin_srs_framework_id IS NULL));

COMMENT ON COLUMN nzi_console.client_strategies.origin IS
  'Where the action came from (A1, R6/R7): plan (a consultant), srs_gap (bridging a UK SRS gap — S3), client_proposal (a client''s custom action — A2). Set once.';

CREATE FUNCTION nzi_console.client_strategies_origin_is_set_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.origin_srs_framework_id IS DISTINCT FROM OLD.origin_srs_framework_id
     OR NEW.origin_srs_requirement_id IS DISTINCT FROM OLD.origin_srs_requirement_id THEN
    RAISE EXCEPTION 'An action''s origin is set when it is created and never changed.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'client_strategies_origin_is_set_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_strategies_origin_is_set_once BEFORE UPDATE ON nzi_console.client_strategies
  FOR EACH ROW EXECUTE FUNCTION nzi_console.client_strategies_origin_is_set_once();

COMMIT;
