-- 0228 The import workbench, Phase 2: a person's resolution of each flagged row, kept as the in-system crosswalk
-- (BRIEF-v7-import-workbench-phase2; RULING-v7-import-pair-carry).
--
-- ## Why
--
-- Phase 1 (0226) shows each imported job's rows against the previous system's records now. Phase 2 lets a person resolve the
-- rows that need one — map a new or needs-mapping row to a category and factor, confirm a withdrawn row goes off, carry a linked
-- pair that moved — and keeps those decisions against the job, so Phase 3's ingest has them to read. A decision is keyed on the
-- row's import identity (organisation, job, source system, record id), not on the summary it was made against: upload a fresh
-- summary of the same job and the decisions still apply, which is the point of an in-system crosswalk.
--
-- ## What it adds
--
--   - `v7_import_decisions`: one row per decision. The kind and its payload (map: category code, dataset id, factor id; carry:
--     the option and the pair group), the row as it stood when decided (status, scope, factor code — a decision applies only
--     while the row still stands so), the summary it was made against, a reason, who and when. Ids, codes and enums only: no
--     label, name, quantity or figure has a column to land in, and each shape is a CHECK.
--   - The linked-pair carry (RULING-v7-import-pair-carry): a `carry` kind with a closed `carry_option` of A only — carry both,
--     unlinked — written for every member of a pair group, against that group.
--   - One current decision per row and slot (a partial unique index): its resolution (map or withdraw) and, in a pair, its
--     carry. A new decision supersedes the current one in its slot, and a clear supersedes it with none: `superseded_at` /
--     `superseded_by` are set, once, and the decision itself never changes. The app may UPDATE those two columns only, and a
--     trigger refuses any other change or a second supersede. DELETE is revoked: the trail is kept.
--   - Summary format /2, additively on 0226's store: each row of a pair names its pair group (the shared T&D row's id) and
--     whether the group's T&D quantity equals its parents' in the extract — an id and a boolean, no figure. A session records its
--     format; one stored before this is /1, and its pairs wait on a fresh /2 summary.
--
-- Nothing here touches a job's rows: Phase 2 records decisions; Phase 3 consumes them.

BEGIN;

ALTER TABLE nzi_console.v7_import_sessions
  ADD COLUMN summary_format text NOT NULL DEFAULT 'nzi.import-summary/1' CHECK (summary_format IN ('nzi.import-summary/1', 'nzi.import-summary/2'));
ALTER TABLE nzi_console.v7_import_rows
  ADD COLUMN pair_group text CHECK (pair_group ~ '^v7-(row|source)-[0-9A-Za-z_-]{1,80}$'),
  ADD COLUMN pair_quantity_consistent boolean,
  ADD CONSTRAINT v7_import_rows_pair_group CHECK ((pair_group IS NULL) = (pair_quantity_consistent IS NULL));
-- From /2 a paired row names its group. A /1 row stored before this has none, so the check is not validated against them.
ALTER TABLE nzi_console.v7_import_rows
  ADD CONSTRAINT v7_import_rows_paired_has_group CHECK ((pair_ref IS NULL) = (pair_group IS NULL)) NOT VALID;

CREATE TABLE nzi_console.v7_import_decisions (
  organisation_id text NOT NULL,
  decision_id text NOT NULL CHECK (decision_id ~ '^v7-decision-[0-9a-f-]{36}$'),
  job_id text NOT NULL,
  source_system text NOT NULL CHECK (source_system = 'nzi-pro-v7'),
  legacy_db_id text NOT NULL CHECK (legacy_db_id ~ '^(source:)?[0-9A-Za-z_-]{1,64}$'),
  kind text NOT NULL CHECK (kind IN ('map', 'withdraw', 'carry')),
  category_code text CHECK (category_code ~ '^[0-9](\.[0-9A-Za-z-]{1,60})?$'),
  dataset_id text CHECK (dataset_id ~ '^[0-9A-Za-z][0-9A-Za-z_.:+@/-]{0,199}$'),
  factor_id text CHECK (factor_id ~ '^[0-9A-Za-z][0-9A-Za-z_.:+@/-]{0,199}$'),
  -- carry: the ruled option (A only) and the pair group it was made for.
  carry_option text CHECK (carry_option = 'A'),
  for_pair_group text CHECK (for_pair_group ~ '^v7-(row|source)-[0-9A-Za-z_-]{1,80}$'),
  -- The row as it stood when decided.
  for_status text NOT NULL CHECK (for_status IN ('matched', 'changed', 'needs-mapping', 'new', 'withdrawn', 'linked-pair-changed')),
  for_scope text NOT NULL CHECK (for_scope IN ('1', '2', '3')),
  for_code text CHECK (for_code ~ '^[0-9A-Za-z_.:-]{1,64}$'),
  session_id text NOT NULL,
  supersedes_decision_id text,
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  superseded_at timestamptz,
  superseded_by text,
  PRIMARY KEY (organisation_id, decision_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, session_id) REFERENCES nzi_console.v7_import_sessions(organisation_id, session_id),
  FOREIGN KEY (organisation_id, supersedes_decision_id) REFERENCES nzi_console.v7_import_decisions(organisation_id, decision_id),
  -- A map names its category and factor; a withdrawal names none; a carry names its option and group. A map or withdrawal is
  -- for the row's own status (a pair member's is the one it has outside the pair, recorded as such).
  CONSTRAINT v7_import_decisions_payload CHECK (CASE kind
    WHEN 'map' THEN category_code IS NOT NULL AND dataset_id IS NOT NULL AND factor_id IS NOT NULL AND carry_option IS NULL AND for_pair_group IS NULL
                    AND for_status IN ('new', 'needs-mapping') AND split_part(category_code, '.', 1) = for_scope
    WHEN 'withdraw' THEN category_code IS NULL AND dataset_id IS NULL AND factor_id IS NULL AND carry_option IS NULL AND for_pair_group IS NULL
                    AND for_status = 'withdrawn'
    ELSE category_code IS NULL AND dataset_id IS NULL AND factor_id IS NULL AND carry_option IS NOT NULL AND for_pair_group IS NOT NULL END),
  CONSTRAINT v7_import_decisions_superseded CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);

-- One current decision per row of a job and slot: its resolution (map or withdraw), and its carry.
CREATE UNIQUE INDEX v7_import_decisions_current ON nzi_console.v7_import_decisions (organisation_id, job_id, source_system, legacy_db_id, (kind = 'carry'))
  WHERE superseded_at IS NULL;

COMMENT ON TABLE nzi_console.v7_import_decisions IS
  'The import workbench''s in-system crosswalk (0228): a person''s resolution of one imported row, or its pair''s carry, keyed on its import identity, so it survives a fresh summary. Ids, codes and enums only. Superseded, never edited or deleted.';

-- A decision never changes; it is superseded once. Only superseded_at / superseded_by may be set, and only from null.
CREATE FUNCTION nzi_console.v7_import_decisions_supersede_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'v7_import_decisions: decision % is already superseded', OLD.decision_id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RAISE EXCEPTION 'v7_import_decisions: a decision is superseded, never edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER v7_import_decisions_supersede_only BEFORE UPDATE ON nzi_console.v7_import_decisions
  FOR EACH ROW EXECUTE FUNCTION nzi_console.v7_import_decisions_supersede_only();

ALTER TABLE nzi_console.v7_import_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.v7_import_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.v7_import_decisions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Read, written, superseded. Never deleted.
GRANT SELECT, INSERT ON nzi_console.v7_import_decisions TO nzi_console_app;
GRANT UPDATE (superseded_at, superseded_by) ON nzi_console.v7_import_decisions TO nzi_console_app;
REVOKE DELETE, TRUNCATE ON nzi_console.v7_import_decisions FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
