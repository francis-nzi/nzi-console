-- 0217 Per-report-version edit history (client-review loop S3; BRIEF-reporting-S3-edit-history).
--
-- Every content edit to a report version - who, which section, before -> after, when - kept as an append-only trail keyed by the
-- REPORT VERSION. It underpins the audit trail and S7's rollback.
--
-- ## Why a new table
--
-- `report_section_versions` (0051) is the wrong home: it is keyed by job + section and is the history of the job's WORKING
-- section, shared by every report version of the job. It cannot say what changed in one version, and a reopened round (a new
-- version of the same job) would be indistinguishable. `audit_events` records the lifecycle ACTIONS (send, approve, final-approve,
-- reopen) and each command's own event, but is not a queryable per-section edit trail. Those stay where they are; this table
-- holds content edits only and duplicates none of them.
--
-- ## Shape
--
--   * `seq` orders a version's edits (1, 2, 3 ...); (version, seq) is unique, so two writers cannot take the same place. The
--     writer holds the version row's lock (FOR UPDATE), so it cannot race in practice; the constraint is the backstop.
--   * `principal` admits `staff | portal`, `action` admits `edit | amend | restore`, and `batch_id` groups a multi-section save.
--     S3 writes only staff `amend` rows, one batch each. The portal "Update" (S4) and rollback's `restore` (S7) are admitted by the
--     schema and built by those stages.
--   * `before_html` / `after_html` are the section's narrative body, which is TOKENISED (B2-4, 0169): every figure is a token key,
--     never a numeral, and money is refused at write (NZC-120). No figure is stored here. It is free prose, as the issued report is.
--   * Append-only as audit_events is: forced row-level security with the tenant policy, and the application role holds SELECT and
--     INSERT - never UPDATE or DELETE. History is never rewritten.

CREATE TABLE nzi_console.report_version_edits (
  organisation_id text NOT NULL,
  edit_id text NOT NULL,
  report_version_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  actor_id text NOT NULL CHECK (actor_id <> ''),
  principal text NOT NULL CHECK (principal IN ('staff', 'portal')),
  section_key text NOT NULL CHECK (section_key <> ''),
  action text NOT NULL CHECK (action IN ('edit', 'amend', 'restore')),
  before_html text NOT NULL,
  after_html text NOT NULL,
  batch_id text NOT NULL CHECK (batch_id <> ''),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, edit_id),
  UNIQUE (organisation_id, report_version_id, seq),
  FOREIGN KEY (organisation_id, report_version_id) REFERENCES nzi_console.report_versions (organisation_id, report_version_id)
);

CREATE INDEX report_version_edits_by_batch ON nzi_console.report_version_edits (organisation_id, report_version_id, batch_id);

ALTER TABLE nzi_console.report_version_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.report_version_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.report_version_edits
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.report_version_edits FROM PUBLIC;
-- 0002 granted every table to the application role; this one is narrowed to append-only.
REVOKE ALL ON nzi_console.report_version_edits FROM nzi_console_app;
GRANT SELECT, INSERT ON nzi_console.report_version_edits TO nzi_console_app;

COMMENT ON TABLE nzi_console.report_version_edits IS
  'Append-only content-edit history of one report version (who, section, before -> after, when). Lifecycle actions stay in audit_events. The app role cannot UPDATE or DELETE.';
