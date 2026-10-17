-- 0168 A reviewed snapshot may carry an explicit self-approval (FINDING-self-approval-db-constraint, ruled 17 Oct 2026).
--
-- #484 relaxed NZC-022's separation of duties in the command layer, behind REPORT_REQUIRE_INDEPENDENT_APPROVAL and for holders
-- of report.publish only. 0066's CHECK `reviewed_crp_snapshots_independent_approval` still forbade approved_by = created_by
-- outright, so a self-approval the command allowed was refused by Postgres. A CHECK cannot read the server's flag, so the row
-- carries the fact instead: `self_approved`, written by `report.snapshot.approve` in the same UPDATE that sets approved_by.
--
--   1. `self_approved boolean NOT NULL DEFAULT false`. Every existing row is false — none has approved_by = created_by (0066
--      forbade it), so nothing is rewritten.
--   2. The 0066 CHECK, same name, now admits approver = preparer only on a row marked self-approved:
--        approved_by IS NULL OR approved_by <> created_by OR self_approved
--      So the database still backstops the normal path. Reinstating full separation of duties is the flag back to true: the
--      command refuses new self-approvals, and rows already marked stay valid — no re-adding a constraint they would violate.
--   3. A second CHECK keeps the marker truthful: a row is self_approved only when it is approved and approved by its preparer.
--      A non-preparer's approval can never be recorded as a self-approval, and an unapproved row cannot carry one.
--   4. The app role may set it: 0066 grants UPDATE on the approval columns only, so self_approved is granted beside them.
--
-- Forced RLS and tenant_isolation are unchanged. No money, no PII (NZC-120). The runner wraps this in its transaction.

ALTER TABLE nzi_console.reviewed_crp_snapshots
  ADD COLUMN self_approved boolean NOT NULL DEFAULT false;

ALTER TABLE nzi_console.reviewed_crp_snapshots
  DROP CONSTRAINT reviewed_crp_snapshots_independent_approval,
  ADD CONSTRAINT reviewed_crp_snapshots_independent_approval
    CHECK (approved_by IS NULL OR approved_by <> created_by OR self_approved),
  ADD CONSTRAINT reviewed_crp_snapshots_self_approval_is_preparer
    CHECK (NOT self_approved OR (approved_by IS NOT NULL AND approved_by = created_by));

COMMENT ON COLUMN nzi_console.reviewed_crp_snapshots.self_approved IS
  'True when the snapshot''s preparer approved it under the relaxed NZC-022 (REPORT_REQUIRE_INDEPENDENT_APPROVAL=false; holders of report.publish). Set by report.snapshot.approve with approved_by; never otherwise.';

GRANT UPDATE (self_approved) ON nzi_console.reviewed_crp_snapshots TO nzi_console_app;
