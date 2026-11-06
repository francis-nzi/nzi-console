-- 0214 Reporting client-review loop, S1: the stored lifecycle and the dual lock
-- (RULING-reporting-client-review-state-model D1, D2, D5, D6, D7; BRIEF-EPIC-reporting-client-review-loop S1; governed).
--
-- ## What this adds
--
-- 1. `report_versions.status` gains `in_client_review` and `client_approved`. `published` stays the final status (D5): every
--    consumer of it, the 0017/0163 one-published-per-scope index and J000663 are untouched. A version that completed the loop is
--    marked by `final_approved_at` / `final_approved_by`; one published directly (`report.publish`) carries neither.
-- 2. The loop's own timestamps and actors: sent to review, client approved (one granted portal user's approval is enough, D1;
--    the other approvals stay as records in `portal_report_approvals`), final approved.
-- 3. Round identity: `revision` (1 for a first round) and `supersedes_report_version_id` (the round a reopen came from). A reopen
--    is always a NEW row; the earlier round is never edited.
-- 4. Two unique indexes, both additive:
--      - one open round per snapshot, manifest and scope — the 0016/0163 index's sibling for the in-flight statuses. 0016 itself is
--        left exactly as it is: it keeps `validated` and `published` apart, so a new round (in_client_review) may coexist with the
--        published version it was reopened from, which stays the client's live report until the new round is finally approved.
--      - one open round per job and scope, so a job-data unlock (D7) can never leave two live loops on one scope.
--
-- ## What it does not change
--
-- No existing row changes. No `locked` value (D5). `report_compositions` is untouched: it stays immutable, one row per version,
-- written at final approval exactly as `report.publish` writes it (D6) — nothing is composed-and-stored during review.
--
-- ## Table grants
--
-- `report_versions` is granted whole-table to nzi_console_app (0002), so the new columns need no GRANT. There is no column-level
-- UPDATE grant on this table, so no relaxed-write grant gap of the 0168 kind.

ALTER TABLE nzi_console.report_versions DROP CONSTRAINT IF EXISTS report_versions_status_check;
ALTER TABLE nzi_console.report_versions ADD CONSTRAINT report_versions_status_check
  CHECK (status IN ('draft', 'validated', 'in_client_review', 'client_approved', 'published', 'superseded'));

ALTER TABLE nzi_console.report_versions
  ADD COLUMN sent_to_review_at timestamptz,
  ADD COLUMN sent_to_review_by text,
  ADD COLUMN client_approved_at timestamptz,
  ADD COLUMN client_approved_by text,
  ADD COLUMN final_approved_at timestamptz,
  ADD COLUMN final_approved_by text,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN supersedes_report_version_id text,
  ADD CONSTRAINT report_versions_sent_pair CHECK ((sent_to_review_at IS NULL) = (sent_to_review_by IS NULL)),
  ADD CONSTRAINT report_versions_client_approved_pair CHECK ((client_approved_at IS NULL) = (client_approved_by IS NULL)),
  ADD CONSTRAINT report_versions_final_approved_pair CHECK ((final_approved_at IS NULL) = (final_approved_by IS NULL)),
  -- The dual lock, in the schema: a version that is client-approved, or final, was sent to review first; a final version was
  -- client-approved first; and only a published (or since-superseded) version can be final.
  ADD CONSTRAINT report_versions_loop_order CHECK (
    (client_approved_at IS NULL OR sent_to_review_at IS NOT NULL)
    AND (final_approved_at IS NULL OR (client_approved_at IS NOT NULL AND status IN ('published', 'superseded')))
    AND (status NOT IN ('in_client_review', 'client_approved') OR sent_to_review_at IS NOT NULL)
    AND (status <> 'client_approved' OR client_approved_at IS NOT NULL)),
  ADD CONSTRAINT report_versions_supersedes_fk FOREIGN KEY (organisation_id, supersedes_report_version_id)
    REFERENCES nzi_console.report_versions (organisation_id, report_version_id);

CREATE UNIQUE INDEX report_version_open_round_snapshot_scope_unique
  ON nzi_console.report_versions (organisation_id, reviewed_snapshot_id, manifest_version, scope_key)
  WHERE status IN ('validated', 'in_client_review', 'client_approved');

CREATE UNIQUE INDEX report_version_one_open_round_per_job_scope
  ON nzi_console.report_versions (organisation_id, job_id, scope_key)
  WHERE status IN ('in_client_review', 'client_approved');

COMMENT ON COLUMN nzi_console.report_versions.final_approved_at IS
  'Set when a version completed the client-review loop (report.finalApprove). NULL on a version published directly (report.publish). The portal PDF-only gate (S8) keys on this, so existing published reports keep their current view.';
COMMENT ON COLUMN nzi_console.report_versions.supersedes_report_version_id IS
  'The round this one was reopened from (report.reopen). The earlier round is never edited; it is superseded when this one is finally approved (or at once, when it was itself still open).';
