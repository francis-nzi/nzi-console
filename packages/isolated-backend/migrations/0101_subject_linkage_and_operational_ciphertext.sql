-- 0101 The linkage digest, confined — and ciphertext for the addresses 0100 left in the clear
-- (NZC-118).
--
-- Two corrections to 0100, which is applied and therefore frozen.
--
-- ## 1. The linker cannot use the column digests, and that is by design
--
-- 0100's digests are domain-separated per column, so a digest taken from `client_contacts` — a
-- table many people can read — cannot confirm who holds a staff login. That separation is what
-- makes them safe to have. It is also why the subject linker cannot use them: the same address in
-- two tables produces two different digests, which is precisely the comparison the linker exists to
-- make.
--
-- So linkage gets one digest of its own, shared across the person-tables, and is confined instead
-- of separated:
--
--   * its own key, so holding the column-index key does not confer the ability to correlate;
--   * its own table, which `nzi_console_app` **cannot read** — reachable only through the
--     privileged function below, which is the NZC-100 lineage: where a policy cannot confine a
--     thing, privilege does;
--   * nulled on erasure, alongside the operational digests.
--
-- ## 2. An operational address still has to be encrypted
--
-- 0100 gave the operational columns a blind index and no ciphertext. The index makes an address
-- matchable; it does nothing to make it unreadable, and those addresses are personal data like any
-- other. Without ciphertext, shredding a subject's key would leave every login address sitting in
-- the clear and erasure would not have erased them. The sealed columns are added here.

BEGIN;

-- ── Ciphertext for the operational addresses ─────────────────────────────────────────
ALTER TABLE nzi_console.staff_credentials ADD COLUMN email_sealed jsonb;
ALTER TABLE nzi_console.portal_users ADD COLUMN email_sealed jsonb;
ALTER TABLE nzi_console.trainees ADD COLUMN email_sealed jsonb;
ALTER TABLE nzi_console.client_contacts ADD COLUMN email_sealed jsonb;
ALTER TABLE nzi_console.memberships ADD COLUMN email_sealed jsonb;
ALTER TABLE nzi_console.trainee_email_changes
  ADD COLUMN current_email_sealed jsonb,
  ADD COLUMN new_email_sealed jsonb;

COMMENT ON COLUMN nzi_console.staff_credentials.email_sealed IS
  'The address itself, encrypted under the subject''s key. The blind index beside it makes the address matchable; only this makes it unreadable, which is what erasure destroys.';

-- ── The linkage digest, in a table the application cannot read ───────────────────────
CREATE TABLE nzi_console.data_subject_linkage (
  organisation_id text NOT NULL,
  source_table text NOT NULL CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships', 'trainee_email_changes')),
  source_id text NOT NULL,
  -- Which address this is, for a row that has more than one (a change record has an old and a new).
  field text NOT NULL DEFAULT 'email',
  -- Null once erased: an erased person leaves nothing correlatable behind.
  linkage_bidx text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, source_table, source_id, field)
);

COMMENT ON TABLE nzi_console.data_subject_linkage IS
  'One digest per address, shared across the person-tables so the linker can compare them — and confined to the linker: its own key, a table the application role cannot read, and nulled on erasure. Never joined into a read model.';

CREATE INDEX data_subject_linkage_digest_idx
  ON nzi_console.data_subject_linkage(organisation_id, linkage_bidx) WHERE linkage_bidx IS NOT NULL;

ALTER TABLE nzi_console.data_subject_linkage ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.data_subject_linkage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.data_subject_linkage
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- The confinement that matters: the application role may write a digest and may never read one.
-- Reading is the correlating act, and it happens only inside the function below.
GRANT INSERT, UPDATE ON nzi_console.data_subject_linkage TO nzi_console_app;
REVOKE SELECT ON nzi_console.data_subject_linkage FROM nzi_console_app;
REVOKE DELETE ON nzi_console.data_subject_linkage FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── The one way to read it ───────────────────────────────────────────────────────────
--
-- Returns rows that *share* a digest, never the digest itself — so the linker learns "these two
-- rows are the same address" without learning anything it could compare against a guess, and a
-- caller cannot extract the correlatable value even though it is the thing being computed over.
CREATE FUNCTION nzi_console.subject_linkage_groups(p_organisation_id text)
RETURNS TABLE (group_key integer, source_table text, source_id text, field text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
  SELECT dense_rank() OVER (ORDER BY l.linkage_bidx)::int AS group_key,
         l.source_table, l.source_id, l.field
    FROM nzi_console.data_subject_linkage l
   WHERE l.organisation_id = p_organisation_id
     AND l.linkage_bidx IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM nzi_console.data_subject_linkage peer
        WHERE peer.organisation_id = l.organisation_id
          AND peer.linkage_bidx = l.linkage_bidx
          AND (peer.source_table, peer.source_id, peer.field) <> (l.source_table, l.source_id, l.field))
   ORDER BY group_key, l.source_table, l.source_id;
$$;

REVOKE EXECUTE ON FUNCTION nzi_console.subject_linkage_groups(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.subject_linkage_groups(text) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.subject_linkage_groups(text) IS
  'Rows that share an address, as anonymous groups. Deliberately returns a group number rather than the digest: the linker needs to know which rows match, and never needs the value they matched on. A function rather than a grant, so the correlating read has exactly one entry point.';

COMMIT;
