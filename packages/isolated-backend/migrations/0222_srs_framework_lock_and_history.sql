-- 0222 SRS framework rework, Phase B: each framework is locked or unlocked, edited only while unlocked, and every edit and
-- every lock and unlock is stamped in an append-only history (BRIEF-srs-framework-rework, Phase B).
--
-- ## The frameworks, and where they are stored
--
-- The frameworks are the rows 0070 named standards — UK SRS S2 — Climate and UK SRS S1 — General; `standard_key` is the
-- framework's key. What 0070 named a framework version (`srs_frameworks`, active / superseded) is a **snapshot**: immutable
-- (0187's triggers), and what an assessment binds to (`srs_assessments.framework_id`). The storage is kept as it is —
-- requirement ids, the strategy alignment, SRS-gap actions and every assessment already point into it — and re-rooted on
-- the framework by the two tables below.
--
-- ## The working definition
--
-- 0187's one draft per organisation is now the **working definition**: made on the first unlock as a copy of the snapshot
-- in force, and kept from then on. Edits land there, and only on a framework that is unlocked — the trigger below holds it
-- under the command. Locking a framework makes the next snapshot (version + 1): that framework and every other locked one
-- as the working definition holds them, each framework still unlocked as its last snapshot held it. The snapshot before is
-- superseded, never changed, so an assessment made against it keeps meaning what it meant.
--
-- Pillars and the ladder are shared by every framework (an assessment reads them all on one radar), so they change only
-- while every framework is unlocked — otherwise a locked framework would read differently.
--
-- ## Existing rows
--
-- Each framework of the snapshot in force gets a lock row: locked, stamped with that snapshot's publisher and time. Where
-- an organisation has a draft open from the old "start a new version" flow, that draft is its working definition and
-- holds edits not yet in force, so its frameworks start unlocked, stamped with whoever started the draft. History is
-- seeded with what is known: a lock per framework per snapshot published, and the unlock of an open draft.

BEGIN;

-- ── Lock state: one row per framework ──────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.srs_framework_locks (
  organisation_id text NOT NULL,
  framework_key text NOT NULL,
  locked boolean NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  /* The snapshot the last lock made (or, unlocked, the one it was reopened from). */
  snapshot_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organisation_id, framework_key),
  FOREIGN KEY (organisation_id, snapshot_id) REFERENCES nzi_console.srs_frameworks (organisation_id, framework_id)
);
COMMENT ON TABLE nzi_console.srs_framework_locks IS
  'Whether each SRS framework (srs_standards.standard_key) is locked, and who last locked or unlocked it, when (0222). No row reads as locked.';

-- ── History: append-only ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.srs_framework_history (
  organisation_id text NOT NULL,
  history_id text NOT NULL,
  /* Null for the shared structure — a pillar or the ladder — which every framework reads. */
  framework_key text,
  event text NOT NULL CHECK (event IN ('locked', 'unlocked', 'requirement_added', 'requirement_edited', 'requirement_retired',
    'requirement_restored', 'pillar_added', 'pillar_renamed', 'ladder_reworded')),
  /* The requirement id, pillar key or ladder step the event is about; null for a lock or an unlock. */
  subject text,
  snapshot_id text,
  snapshot_version integer,
  before_json jsonb,
  after_json jsonb,
  actor_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  PRIMARY KEY (organisation_id, history_id),
  CONSTRAINT srs_framework_history_lock_names_framework CHECK (event NOT IN ('locked', 'unlocked') OR framework_key IS NOT NULL),
  CONSTRAINT srs_framework_history_lock_names_snapshot CHECK (event <> 'locked' OR snapshot_id IS NOT NULL)
);
CREATE INDEX srs_framework_history_framework_idx ON nzi_console.srs_framework_history (organisation_id, framework_key, at DESC);
CREATE INDEX srs_framework_history_subject_idx ON nzi_console.srs_framework_history (organisation_id, subject, at DESC);

CREATE FUNCTION nzi_console.srs_framework_history_is_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  RAISE EXCEPTION 'SRS framework history is append-only.'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_framework_history_is_append_only';
END;
$$;
CREATE TRIGGER srs_framework_history_is_append_only BEFORE UPDATE OR DELETE ON nzi_console.srs_framework_history
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_framework_history_is_append_only();

-- ── The working definition follows the locks ───────────────────────────────────────────────────────────────────

-- In the working definition (the draft), a requirement changes only while its framework is unlocked; a pillar or a ladder
-- step only while every framework is. A published snapshot is already held by 0187's triggers.
CREATE FUNCTION nzi_console.srs_working_rows_follow_their_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nzi_console.srs_frameworks
                  WHERE organisation_id = NEW.organisation_id AND framework_id = NEW.framework_id AND status = 'draft') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'srs_requirements' THEN
    IF NOT EXISTS (SELECT 1 FROM nzi_console.srs_framework_locks
                    WHERE organisation_id = NEW.organisation_id AND framework_key = NEW.standard_key AND NOT locked) THEN
      RAISE EXCEPTION 'SRS framework % is locked; unlock it to edit it.', NEW.standard_key
        USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_working_rows_follow_their_lock';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM nzi_console.srs_standards s
                  LEFT JOIN nzi_console.srs_framework_locks l ON (l.organisation_id, l.framework_key) = (s.organisation_id, s.standard_key)
                 WHERE s.organisation_id = NEW.organisation_id AND s.framework_id = NEW.framework_id AND coalesce(l.locked, true)) THEN
    RAISE EXCEPTION 'Pillars and the ladder are shared by every SRS framework; unlock them all to change one.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'srs_working_rows_follow_their_lock';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER srs_requirements_follow_their_lock BEFORE UPDATE ON nzi_console.srs_requirements
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_working_rows_follow_their_lock();
CREATE TRIGGER srs_pillars_follow_their_lock BEFORE UPDATE ON nzi_console.srs_pillars
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_working_rows_follow_their_lock();
CREATE TRIGGER srs_maturity_levels_follow_their_lock BEFORE UPDATE ON nzi_console.srs_maturity_levels
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_working_rows_follow_their_lock();
-- A pillar is renamed in the working definition only; a published snapshot's pillars are held as its other rows are.
CREATE TRIGGER srs_pillars_follow_their_draft BEFORE UPDATE ON nzi_console.srs_pillars
  FOR EACH ROW EXECUTE FUNCTION nzi_console.srs_framework_rows_follow_their_draft();

-- ── Tenancy and grants ─────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.srs_framework_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_framework_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_framework_locks
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.srs_framework_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.srs_framework_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.srs_framework_history
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT ON nzi_console.srs_framework_locks TO nzi_console_app;
GRANT UPDATE (locked, changed_by, changed_at, snapshot_id, version) ON nzi_console.srs_framework_locks TO nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.srs_framework_history TO nzi_console_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nzi_console.srs_framework_history FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;
REVOKE DELETE, TRUNCATE ON nzi_console.srs_framework_locks FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;
-- Renaming a pillar in the working definition; the working definition's number moves on past each snapshot locked.
GRANT UPDATE (label, description, ordering) ON nzi_console.srs_pillars TO nzi_console_app;
GRANT UPDATE (version) ON nzi_console.srs_frameworks TO nzi_console_app;

-- ── Existing rows ──────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO nzi_console.srs_framework_locks (organisation_id, framework_key, locked, changed_by, changed_at, snapshot_id)
SELECT s.organisation_id, s.standard_key, d.framework_id IS NULL,
       coalesce(d.published_by, a.published_by), coalesce(d.published_at, a.published_at), a.framework_id
  FROM nzi_console.srs_frameworks a
  JOIN nzi_console.srs_standards s ON (s.organisation_id, s.framework_id) = (a.organisation_id, a.framework_id)
  LEFT JOIN nzi_console.srs_frameworks d ON d.organisation_id = a.organisation_id AND d.status = 'draft'
 WHERE a.status = 'active';

INSERT INTO nzi_console.srs_framework_history (organisation_id, history_id, framework_key, event, snapshot_id, snapshot_version, after_json, actor_id, at)
SELECT f.organisation_id, gen_random_uuid()::text, s.standard_key, 'locked', f.framework_id, f.version,
       jsonb_build_object('seededBy', 'migration:0222', 'status', f.status), f.published_by, f.published_at
  FROM nzi_console.srs_frameworks f
  JOIN nzi_console.srs_standards s ON (s.organisation_id, s.framework_id) = (f.organisation_id, f.framework_id)
 WHERE f.status <> 'draft';

INSERT INTO nzi_console.srs_framework_history (organisation_id, history_id, framework_key, event, snapshot_id, snapshot_version, after_json, actor_id, at)
SELECT l.organisation_id, gen_random_uuid()::text, l.framework_key, 'unlocked', l.snapshot_id, a.version,
       jsonb_build_object('seededBy', 'migration:0222', 'from', 'an open draft version'), l.changed_by, l.changed_at
  FROM nzi_console.srs_framework_locks l
  JOIN nzi_console.srs_frameworks a ON (a.organisation_id, a.framework_id) = (l.organisation_id, l.snapshot_id)
 WHERE NOT l.locked;

COMMIT;
