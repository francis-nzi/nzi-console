-- 0092 The tenant registry is not the application's to read (NZC-100).
--
-- `nzi_console.organisations` is the one table carrying an `organisation_id` that has no
-- row-level security, and it cannot sensibly have the usual one: that column is its primary key,
-- so a policy comparing it to the current tenant would leave provisioning unable to create a row
-- at all. NZC-099 found that combination — no policy, and the application role holding full DML
-- through `0002`'s blanket `GRANT … ON ALL TABLES IN SCHEMA` — and noted that the only thing
-- standing between one tenant and the list of every organisation's name was that no application
-- code queries the table.
--
-- That is a fact about the source as it stands today, not a property of the schema. This makes it
-- a property of the schema.
--
-- ## Why revoke rather than add a policy
--
-- A policy here has to admit the row being inserted before the tenant context for it can exist,
-- so it would have to be written as an exception to its own rule. The privilege is the thing that
-- is wrong: the application never reads this table — organisations "arrive by script or by hand"
-- (`0080`), and the trigger that provisions one runs as the inserting role, which is the migration
-- owner or an operator, never `nzi_console_app`. Removing an unused privilege costs nothing and
-- closes the path completely, where a policy would leave the privilege in place and hope.
--
-- ## What keeps its access
--
-- Nothing else changes. `nzi_console_worker` and `nzi_console_auth` never had privileges here.
-- Migrations, seeds and operator scripts connect as the owner and are unaffected — every test
-- fixture that inserts an organisation continues to work, because none of them is the app role.
--
-- ## If a screen ever needs the organisation's name
--
-- Grant `SELECT` back deliberately **and** give the table a confining policy at the same time —
-- the two go together, and the test in `tenantIsolationReal` now states that pairing as the rule:
-- access to this table implies a policy confining it.

BEGIN;

REVOKE SELECT, INSERT, UPDATE, DELETE ON nzi_console.organisations FROM nzi_console_app;

COMMENT ON TABLE nzi_console.organisations IS
  'The tenant registry. No row-level security: organisation_id is the primary key, so a tenant policy could not admit the row being provisioned. Protected by privilege instead — nzi_console_app holds none (0092, NZC-100). Granting access back requires a confining policy in the same change.';

COMMIT;
