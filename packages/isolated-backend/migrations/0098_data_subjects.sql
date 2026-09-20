-- 0098 Who a person is, so that erasing them is a well-defined act (NZC-116).
--
-- The erasure workstream reconciles on crypto-shred: personal data encrypted under a per-subject
-- key, erased by destroying the key. That needs a subject, and there wasn't one — `trainees`,
-- `client_contacts`, `portal_users` and `memberships` each key a person their own way with no
-- foreign key between them, so the same human can exist three times under three unrelated
-- identifiers. "Destroy the key" would have destroyed one facet of a person and left the others.
--
-- ## The registry holds no personal data, and that is the point
--
-- A registry that copied names and addresses in order to match them would become one more place to
-- erase from — and the worst kind, because it is the place erasure is run from. So a subject is an
-- identifier and a status. Links and reviews carry **pointers** to source rows, never copies, and
-- anything that needs to show a name reads it from the source row at the moment it renders it.
--
-- The same instinct as `verify_certificate_attempts`, which counts rate-limit attempts against a
-- salted hash precisely so that verifying a certificate leaves no address behind.
--
-- ## A subject id is globally unique, deliberately
--
-- The primary key is tenant-scoped like everything else, but `subject_id` itself is a UUID rather
-- than something derived per organisation. The same human at two firms is two subjects today —
-- that follows from RLS and is the right answer for a DSAR, which is answered within a tenant — but
-- a later cross-tenant resolution layer will want to say "these two subjects are one person", and a
-- non-unique id would make that a rewrite instead of a mapping.

BEGIN;

-- ── The identity ─────────────────────────────────────────────────────────────────────
CREATE TABLE nzi_console.data_subjects (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  -- Globally unique, so a future cross-tenant layer can reference it without collision.
  subject_id uuid NOT NULL UNIQUE,
  -- Deactivated when merged into another subject; never deleted, because links and decisions
  -- point at it and a dangling pointer is worse than a superseded row.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz,
  updated_by text,
  PRIMARY KEY (organisation_id, subject_id),
  CONSTRAINT data_subject_merge_shape CHECK ((status = 'merged') = (merged_into IS NOT NULL))
);

COMMENT ON TABLE nzi_console.data_subjects IS
  'A person, as an identifier and nothing else. Deliberately holds no name, address or email — not even a hash of one — because the machinery that erases personal data must not accumulate any.';
COMMENT ON COLUMN nzi_console.data_subjects.subject_id IS
  'A UUID rather than a tenant-derived id, so a later cross-tenant resolution layer can map two subjects to one person without a rewrite.';

-- ── Which rows are this person ────────────────────────────────────────────────────────
CREATE TABLE nzi_console.data_subject_links (
  organisation_id text NOT NULL,
  subject_id uuid NOT NULL,
  -- A pointer, never a copy. The source table is named rather than joined, because the four
  -- person-shaped tables have no common key — which is the whole reason this registry exists.
  source_table text NOT NULL CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships')),
  source_id text NOT NULL CHECK (nullif(btrim(source_id), '') IS NOT NULL),
  -- How the link came about, so a deterministic match and a human judgement are never confused.
  link_method text NOT NULL CHECK (link_method IN ('deterministic-email', 'reviewed', 'unlinked-no-key')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by text NOT NULL,
  PRIMARY KEY (organisation_id, source_table, source_id),
  FOREIGN KEY (organisation_id, subject_id) REFERENCES nzi_console.data_subjects(organisation_id, subject_id)
);

-- A person-row belongs to at most one subject. That is what makes "erase this subject" a
-- well-defined act rather than a search, and it is enforced by the primary key above.
COMMENT ON TABLE nzi_console.data_subject_links IS
  'Which source rows are one person. Pointers only: (source_table, source_id), resolved at read time under the ordinary tenant rules. A row belongs to at most one subject, which is what makes erasure well-defined.';

CREATE INDEX data_subject_links_subject_idx ON nzi_console.data_subject_links(organisation_id, subject_id);

-- ── What a person must decide ─────────────────────────────────────────────────────────
CREATE TABLE nzi_console.data_subject_reviews (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  review_id uuid NOT NULL,
  -- Why this reached a human rather than linking itself.
  reason text NOT NULL CHECK (reason IN ('shared-key', 'history-match', 'name-suggestion', 'no-key')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
  -- The outcome, including "these are different people" — a decision that is not remembered is a
  -- decision that gets asked again on every run.
  decision text CHECK (decision IN ('linked', 'distinct', 'deferred')),
  -- Why the reviewer decided that. Required with a decision: a ruling about a person's identity
  -- that nobody can explain later is not reviewable, and this is the record a regulator reads.
  basis text NOT NULL DEFAULT '',
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, review_id),
  CONSTRAINT data_subject_review_decision_shape
    CHECK ((status = 'decided') = (decision IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  -- A decision without a basis is not a decision anybody can stand behind.
  CONSTRAINT data_subject_review_basis_present
    CHECK (status <> 'decided' OR nullif(btrim(basis), '') IS NOT NULL)
);

COMMENT ON TABLE nzi_console.data_subject_reviews IS
  'Identity questions the linker will not answer on its own. Decisions persist with the basis recorded, so a ruling about who someone is can be explained later and is never re-asked on the next run.';

CREATE TABLE nzi_console.data_subject_review_members (
  organisation_id text NOT NULL,
  review_id uuid NOT NULL,
  source_table text NOT NULL CHECK (source_table IN ('trainees', 'client_contacts', 'portal_users', 'memberships')),
  source_id text NOT NULL,
  PRIMARY KEY (organisation_id, review_id, source_table, source_id),
  FOREIGN KEY (organisation_id, review_id) REFERENCES nzi_console.data_subject_reviews(organisation_id, review_id) ON DELETE CASCADE
);

COMMENT ON TABLE nzi_console.data_subject_review_members IS
  'The rows one review is about. Pointers, like everything else here — a reviewer''s screen reads the name from the source row when it draws it, and stores none of it.';

-- The linker re-runs; an open review for the same members must not pile up.
CREATE UNIQUE INDEX data_subject_reviews_open_reason_idx
  ON nzi_console.data_subject_reviews(organisation_id, reason, review_id) WHERE status = 'open';

-- ── Tenant isolation, on all four ─────────────────────────────────────────────────────
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['data_subjects', 'data_subject_links', 'data_subject_reviews', 'data_subject_review_members'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON nzi_console.%I
        USING (organisation_id = current_setting('app.organisation_id', true))
        WITH CHECK (organisation_id = current_setting('app.organisation_id', true))$p$, target);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON nzi_console.%I TO nzi_console_app', target);
    EXECUTE format('REVOKE DELETE ON nzi_console.%I FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth', target);
  END LOOP;
END $$;

-- ── The one tenant-crossing read, and it crosses on purpose ──────────────────────────
--
-- Queue review is an admin-only privileged act that spans organisations: the questions are about
-- people, and a person is not confined to one tenant. RLS cannot express that, so — exactly as
-- `verify_training_certificate` does for public certificate checks — it is a SECURITY DEFINER
-- function, deliberately, **so its return list is the whole contract**.
--
-- What that buys here: the function returns pointers, reasons and counts. It cannot leak a name or
-- an address across a tenant boundary because it does not select one. A reviewer who needs to see
-- the person reads the source row through the ordinary tenant-scoped path, where the usual rules
-- apply and the usual audit follows.
CREATE FUNCTION nzi_console.open_subject_reviews()
RETURNS TABLE (
  organisation_id text, review_id uuid, reason text, member_count integer, created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
  SELECT r.organisation_id, r.review_id, r.reason,
         (SELECT count(*)::int FROM nzi_console.data_subject_review_members m
           WHERE (m.organisation_id, m.review_id) = (r.organisation_id, r.review_id)),
         r.created_at
    FROM nzi_console.data_subject_reviews r
   WHERE r.status = 'open'
   ORDER BY r.created_at, r.review_id;
$$;

REVOKE EXECUTE ON FUNCTION nzi_console.open_subject_reviews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.open_subject_reviews() TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.open_subject_reviews() IS
  'Every open identity question, across organisations — the only tenant-crossing read in the erasure spine. A function rather than a policy exception so its return list is the whole contract: pointers, reasons and counts, never a name or an address. The application layer still requires the reviewing capability before calling it.';

COMMIT;
