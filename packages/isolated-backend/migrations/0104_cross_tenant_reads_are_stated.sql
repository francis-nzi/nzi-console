-- 0104 The two deliberate cross-tenant reads say so in a policy, instead of relying on an owner who
-- bypasses policies (NZC-123).
--
-- ## What was actually holding them up
--
-- `open_subject_reviews` (the DPO review queue) and `verify_training_certificate` (a stranger checking
-- a certificate) both read across tenants on purpose. Both read tables with `FORCE ROW LEVEL SECURITY`,
-- and FORCE applies to a table's owner — so a `SECURITY DEFINER` function, which runs as *its* owner,
-- cannot cross a tenant boundary unless that owner holds `BYPASSRLS`.
--
-- It does, everywhere they have ever run: `postgres` on the CI image, and `postgres` on Supabase, where
-- the provider sets `rolbypassrls`. So these functions have worked for a reason no migration granted, no
-- document stated, and no test could fail on (NZC-122). Row-level security was not confining them; it
-- was switched off underneath them.
--
-- ## Stated rather than bypassed
--
-- A role that owns nothing else and bypasses nothing:
--
--   * `nzi_console_definer` — NOLOGIN, NOSUPERUSER, **NOBYPASSRLS**. It is subject to every policy.
--   * The two functions are re-owned to it, so inside them `current_user` is that role.
--   * Each table they read gains a policy naming that role, and only that role.
--
-- The permission to cross a tenant boundary is now a line of SQL that can be read, reviewed, and
-- revoked, rather than an attribute of whoever happened to run the migrations. Nothing here needs
-- `BYPASSRLS` at all: the role that owns these two functions is `NOBYPASSRLS` by its own definition, in
-- every environment, so the policies below are what lets them cross and not a property of the account
-- that applied this file.
--
-- ## Why this is narrow, and where the narrowness actually lives
--
-- The role owns two functions and nothing else. That is the boundary: any future function owned by it
-- would inherit these cross-tenant reads, so a test asserts the ownership list, and adding to it is a
-- deliberate act rather than a side effect.
--
-- The policies say what the functions select where saying it is cheap. The review queue's is limited to
-- open reviews, which is precisely what the function returns; its members table is limited to members of
-- an open review. The five training tables get an unrestricted read for this role, because a stranger
-- holding a verify code reaches exactly one certificate and its joins, and correlating each join back to
-- a certificate in a policy would cost more than it confines. The contract there is the function's
-- `RETURNS TABLE`, which is the existing ruling and is unchanged.
--
-- ## The role has to be granted table privileges now
--
-- It is no longer the tables' owner, so ownership no longer implies access. `GRANT SELECT` appears for
-- each table it reads, which is another thing that used to be implicit and is now written down.

BEGIN;

-- ── A role that bypasses nothing ─────────────────────────────────────────────────────
--
-- Created here when the migration runs with enough privilege, and expected to exist already when it
-- does not — the same shape the runtime roles use. It needs no attribute beyond existing: every
-- permission it has is granted below.
DO $$ BEGIN
  CREATE ROLE nzi_console_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN insufficient_privilege THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nzi_console_definer') THEN RAISE; END IF;
END $$;

-- Handing a function to a new owner requires being able to SET ROLE to it — that is, membership.
--
-- Granted only when it is missing, because granting a role requires ADMIN OPTION on it and the role
-- may have been created by somebody else. A superuser is implicitly a member of everything, so on
-- Supabase this does nothing and the ALTERs below simply work. Where the platform has already made
-- this role and granted it, this does nothing either. Where neither is true, the GRANT runs — and if
-- that is refused, the migration says so rather than failing later on an ALTER that looks unrelated.
DO $$ BEGIN
  IF NOT pg_has_role(current_user, 'nzi_console_definer', 'MEMBER') THEN
    EXECUTE 'GRANT nzi_console_definer TO CURRENT_USER';
  END IF;
END $$;

COMMENT ON ROLE nzi_console_definer IS
  'Owns the two functions that read across tenants on purpose, and nothing else. It cannot log in and does not bypass row-level security: everything it may read is a policy naming it, so the permission to cross a tenant boundary is reviewable rather than an attribute of whoever ran the migrations.';

-- Owning an object in a schema requires CREATE on that schema — the check is on the *new* owner, and
-- a superuser executing the ALTER does not waive it. Without this, `ALTER FUNCTION … OWNER TO` fails
-- with "permission denied for schema nzi_console", which names the schema and not the role that lacks
-- the privilege on it.
--
-- It confers nothing in practice: the role cannot log in, and the only way to run anything as it is to
-- call one of the two functions below. But it is a widening, so it is stated here rather than folded
-- into a grant that looks like it is about reading.
GRANT USAGE, CREATE ON SCHEMA nzi_console TO nzi_console_definer;

-- ── The review queue ─────────────────────────────────────────────────────────────────
ALTER FUNCTION nzi_console.open_subject_reviews() OWNER TO nzi_console_definer;

GRANT SELECT ON nzi_console.data_subject_reviews, nzi_console.data_subject_review_members
  TO nzi_console_definer;

-- Limited to what the function actually returns, so widening the function's body cannot widen the
-- disclosure without this line changing too.
CREATE POLICY cross_tenant_review_queue ON nzi_console.data_subject_reviews
  FOR SELECT TO nzi_console_definer USING (status = 'open');

CREATE POLICY cross_tenant_review_members ON nzi_console.data_subject_review_members
  FOR SELECT TO nzi_console_definer USING (EXISTS (
    SELECT 1 FROM nzi_console.data_subject_reviews r
     WHERE (r.organisation_id, r.review_id)
         = (data_subject_review_members.organisation_id, data_subject_review_members.review_id)
       AND r.status = 'open'));

-- ── Public certificate verification ──────────────────────────────────────────────────
ALTER FUNCTION nzi_console.verify_training_certificate(text) OWNER TO nzi_console_definer;

GRANT SELECT ON
  nzi_console.training_certificates,
  nzi_console.training_bookings,
  nzi_console.training_course_runs,
  nzi_console.training_products,
  nzi_console.training_course_sessions
  TO nzi_console_definer;

CREATE POLICY cross_tenant_certificate ON nzi_console.training_certificates
  FOR SELECT TO nzi_console_definer USING (true);
CREATE POLICY cross_tenant_certificate_booking ON nzi_console.training_bookings
  FOR SELECT TO nzi_console_definer USING (true);
CREATE POLICY cross_tenant_certificate_run ON nzi_console.training_course_runs
  FOR SELECT TO nzi_console_definer USING (true);
CREATE POLICY cross_tenant_certificate_product ON nzi_console.training_products
  FOR SELECT TO nzi_console_definer USING (true);
CREATE POLICY cross_tenant_certificate_session ON nzi_console.training_course_sessions
  FOR SELECT TO nzi_console_definer USING (true);

COMMENT ON POLICY cross_tenant_certificate_booking ON nzi_console.training_bookings IS
  'Readable across tenants by the definer role, which owns only verify_training_certificate. The booking carries a person''s name and address, and what a stranger may see of them is the function''s RETURNS list — so the thing to check when changing that function is what it selects, and the thing to check when adding a function owned by this role is whether it should see this table at all.';

COMMIT;
