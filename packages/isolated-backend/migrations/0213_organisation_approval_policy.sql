-- 0213 The organisation's approval policy: an in-app, audited "require independent approval" setting (BRIEF-independent-approval-toggle).
--
-- NZC-022's separation of duties (a snapshot's preparer may not approve, validate or publish it) is relaxed today by one server
-- variable, REPORT_REQUIRE_INDEPENDENT_APPROVAL, which needs a dashboard edit and a deploy to change (#484, 0168). This is the
-- same switch as a setting an Admin changes in the app, with its reason, audited.
--
--   * One row per organisation, written only when someone sets the policy. **No row means "required"** (unless the server
--     variable relaxes it, which stays the backstop): the safe default is the absence of data, so nothing is provisioned,
--     no organisation needs a backfill, and an unreadable policy has nothing to be misread as.
--   * `require_independent_approval` true = a preparer may not approve or release their own work (today's rule). False = the
--     existing self-approval path opens, for a holder of the self-approval capability only (report.publish), as 0168 recorded.
--   * Versioned (`expectedVersion`; 1 on the first write), with who and when. The audit event, written by the command in the
--     same transaction, carries the old and new value and the reason.
--   * Written by `organisation.approvalPolicy.set`, gated by `admin.settings` (Admin) — no matrix change. The application
--     role holds SELECT, INSERT and UPDATE; nobody holds DELETE, so a policy is changed, never silently dropped back to default.
--
-- Forced row-level security with the tenant policy. No money, no PII (NZC-120).

CREATE TABLE nzi_console.organisation_approval_policy (
  organisation_id text PRIMARY KEY REFERENCES nzi_console.organisations(organisation_id),
  require_independent_approval boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE nzi_console.organisation_approval_policy IS
  'The organisation''s report approval policy. No row = independent approval required (the server variable REPORT_REQUIRE_INDEPENDENT_APPROVAL may relax it, as before). A row overrides the variable, in either direction.';

ALTER TABLE nzi_console.organisation_approval_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_approval_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_approval_policy
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.organisation_approval_policy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.organisation_approval_policy TO nzi_console_app;
