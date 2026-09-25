-- 0127 The real operating organisation: Net Zero International (REFERENCE_DATA_DESIGN §4, "Organisation").
--
-- ## Why
--
-- The v7 reference data is loaded into the organisation that owns the jobs. Until now every organisation in the console
-- has been a demonstration or test tenant (`demo-nzi-console` on staging). The import targets the real one, so it has
-- to exist first — created here, as a governed and reviewed change, because there is no organisation-admin screen and
-- an organisation typed in by hand is exactly the unreviewed row the provisioning trigger (0082) was written to catch.
--
-- ## What it does
--
-- Inserts `net-zero-international` / "Net Zero International". The provisioning trigger (0082) gives it the current
-- reference set — SRS framework, levers, strategy library — as it does any new organisation. Idempotent: if the row is
-- already there (created by hand ahead of this), nothing changes and nothing is provisioned twice.
--
-- ## What it does not do
--
-- Grant anybody access. Staff memberships in the new organisation are a separate, deliberate step; until then it holds
-- reference data and no one can sign in to it. Nothing moves out of the demonstration organisation.

BEGIN;

INSERT INTO nzi_console.organisations (organisation_id, name)
VALUES ('net-zero-international', 'Net Zero International')
ON CONFLICT (organisation_id) DO NOTHING;

COMMIT;
