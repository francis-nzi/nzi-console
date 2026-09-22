-- 0108 Erasure: the record that survives it, the statuses it can leave a person in, and the one way
-- to reach the linkage digests (NZC-136, NZC-137).
--
-- ## What erasure is here
--
-- Destroying readability, not rows. The subject's key is shredded, the plaintext beside the ciphertext
-- is nulled, the blind indexes and linkage digests are nulled, and everything structural stays: foreign
-- keys resolve, provenance still says a person did a thing, history still says it changed. What is gone
-- is the ability to say who.
--
-- ## Three things this adds
--
-- **A status a person can be left in.** `data_subjects.status` gains `erased` and `erasure-partial`.
-- The second is the important one: there are columns this system cannot yet erase, and a subject holding
-- one of them is *not* erased. Reporting them as erased would be the compliance equivalent of a green
-- test over an empty set.
--
-- **A permanent record of the act.** `subject_erasures` keeps the manifest: which columns were erased,
-- which were retained and why, which are still pending and on what. Counts and reasons, never a value.
-- This is what evidences the erasure afterwards, when by construction nothing else can.
--
-- **A way to null the digests.** The application role may write a linkage digest and may never read one
-- (NZC-121), and an `UPDATE ... WHERE` needs SELECT on the columns it filters by — so the role that
-- writes digests cannot clear them. A definer function does it for one source row, which keeps the
-- confinement intact: nothing gained the ability to read a digest, only to destroy one.
--
-- ## Why the plaintext columns lose NOT NULL
--
-- Three sealed columns are declared NOT NULL: `client_contacts.full_name`, `portal_users.display_name`
-- and `portal_users.email_normalized`. A shred makes their ciphertext unreadable and leaves the
-- plaintext next to it perfectly readable — 0100 kept it on purpose, to be dropped wholesale later — so
-- erasure has to null it, and NOT NULL forbids exactly that.
--
-- The alternative was a tombstone string, and it fails on contact: `portal_users` has a plain UNIQUE on
-- `(organisation_id, email_normalized)`, so the *second* erased portal user in an organisation would
-- collide with the first. NULLs do not collide, because NULL is distinct from NULL for uniqueness. So
-- NULL is not merely tidier here, it is the only one of the two that works more than once.
--
-- The invariant genuinely weakens: a contact can now be inserted without a name. These columns are
-- transitional and slated to be dropped entirely once the ciphertext is the only copy, so nullable is
-- the direction they were going anyway — but it is a widening, and it is stated here rather than
-- arriving as a side effect of an erasure feature.

BEGIN;

-- ── A person can be erased, or erased as far as this system can yet manage ────────────
ALTER TABLE nzi_console.data_subjects DROP CONSTRAINT data_subjects_status_check;
ALTER TABLE nzi_console.data_subjects ADD CONSTRAINT data_subjects_status_check
  CHECK (status IN ('active', 'merged', 'erased', 'erasure-partial'));

COMMENT ON COLUMN nzi_console.data_subjects.status IS
  'active, merged, erased, or erasure-partial. The last means an erasure ran and did everything it could, and at least one column remains that this system cannot yet erase — the subject is not erased, and the manifest in subject_erasures names what is outstanding and what it waits on.';

-- ── The record that outlives what it describes ───────────────────────────────────────
--
-- One row per subject, updated by a re-run rather than appended to: an erasure is a state a person is
-- in, not a stream of attempts. The manifest is replaced each run, because the answer to "what is still
-- outstanding" is about now and not about the first attempt.
CREATE TABLE nzi_console.subject_erasures (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  subject_id uuid NOT NULL,

  requested_by text NOT NULL,
  request_ref text,
  first_requested_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  status text NOT NULL CHECK (status IN ('partial', 'complete')),

  -- What each prerequisite is called, so a list of partial subjects can be grouped by what would
  -- finish them. Empty exactly when the status is complete.
  pending_on text[] NOT NULL DEFAULT '{}',

  erased_count integer NOT NULL,
  retained_count integer NOT NULL,
  pending_count integer NOT NULL,

  -- Per column: the treatment, the outcome, and the reason. No value, ever — a manifest of an erasure
  -- that quoted what it erased would be the one copy that survived it.
  manifest jsonb NOT NULL,

  PRIMARY KEY (organisation_id, subject_id),

  -- Complete means nothing outstanding, and partial means something is. Without this the two could
  -- disagree and the status would be the more optimistic of the two.
  CONSTRAINT subject_erasure_status_matches_pending CHECK (
    (status = 'complete') = (pending_count = 0 AND cardinality(pending_on) = 0)),
  CONSTRAINT subject_erasure_completed_when_complete CHECK (
    (status = 'complete') = (completed_at IS NOT NULL))
);

CREATE INDEX subject_erasures_pending_idx
  ON nzi_console.subject_erasures(organisation_id, status)
  WHERE status = 'partial';

ALTER TABLE nzi_console.subject_erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.subject_erasures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.subject_erasures
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.subject_erasures TO nzi_console_app;
REVOKE DELETE ON nzi_console.subject_erasures
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMENT ON TABLE nzi_console.subject_erasures IS
  'The permanent record of an erasure: when it ran, who asked, and a manifest of every inventory column with its treatment, outcome and reason. Counts and reasons only, never a value. After an erasure this is the evidence it happened and what it covered, because by construction nothing else can say.';

COMMENT ON COLUMN nzi_console.subject_erasures.pending_on IS
  'The prerequisites that would finish this erasure — auth-bridge, plaintext-drop. A partial subject is listed here rather than left for somebody to notice, and re-running the erasure once a prerequisite lands is what promotes it to complete.';

-- ── Nulling a digest, without gaining the ability to read one ────────────────────────
--
-- The confinement in NZC-121 is that the application role may write a digest and never read one, which
-- also means it cannot clear one: `UPDATE ... WHERE source_id = $1` requires SELECT on `source_id`.
--
-- So erasure asks for exactly the act it needs — null every digest for one source row — and gets back a
-- count, not a digest. The function refuses outside its own tenant, like every other definer function
-- here: a definer's first job is to refuse what its privilege would otherwise allow.
CREATE FUNCTION nzi_console.erase_subject_linkage(
  p_organisation_id text,
  p_source_table text,
  p_source_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = nzi_console, pg_temp AS $$
DECLARE
  v_erased integer;
BEGIN
  IF p_organisation_id IS DISTINCT FROM current_setting('app.organisation_id', true) THEN
    RAISE EXCEPTION 'Cannot erase linkage outside the current organisation' USING ERRCODE = '42501';
  END IF;

  UPDATE nzi_console.data_subject_linkage
     SET linkage_bidx = NULL
   WHERE organisation_id = p_organisation_id
     AND source_table = p_source_table
     AND source_id = p_source_id
     AND linkage_bidx IS NOT NULL;

  GET DIAGNOSTICS v_erased = ROW_COUNT;
  -- A count of rows changed says nothing about anybody: it is how many digests this row held, which the
  -- inventory already states.
  RETURN v_erased;
END $$;

REVOKE EXECUTE ON FUNCTION nzi_console.erase_subject_linkage(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nzi_console.erase_subject_linkage(text, text, text) TO nzi_console_app;

COMMENT ON FUNCTION nzi_console.erase_subject_linkage(text, text, text) IS
  'Nulls every linkage digest for one source row and returns how many it cleared. The application role cannot do this directly, because clearing a digest requires reading the row it is on and reading digests is the correlating act this table is confined to prevent. Destroying one confers no ability to read one.';

-- ── The plaintext that erasure has to be able to clear ───────────────────────────────
--
-- See the header: a shred leaves these readable, so erasure nulls them, and NOT NULL forbids it. NULL
-- rather than a tombstone because `portal_users` is UNIQUE on the normalised address and two erased
-- people would collide on any fixed string.
ALTER TABLE nzi_console.client_contacts ALTER COLUMN full_name DROP NOT NULL;
ALTER TABLE nzi_console.portal_users ALTER COLUMN display_name DROP NOT NULL;
ALTER TABLE nzi_console.portal_users ALTER COLUMN email_normalized DROP NOT NULL;

COMMENT ON COLUMN nzi_console.client_contacts.full_name IS
  'The plaintext name, kept beside its ciphertext until the plaintext columns are dropped wholesale. Nullable because erasure nulls it: shredding the key makes full_name_sealed unreadable and would otherwise leave this perfectly readable next to it.';

-- ── The constraint that forbade a tombstone ──────────────────────────────────────────
--
-- 0067 said a report version has a signee contact and a signee name, or neither:
--
--   CHECK ((signee_contact_id IS NULL) = (signee_name IS NULL))
--
-- which was right while the name was part of the record of who signed. It is exactly the shape an
-- erasure has to produce, though: the association survives and the name goes (NZC-127), so an erased
-- signee is a pointer with no name — the one combination this forbids. The erasure failed here, which is
-- the constraint doing its job against a case nobody had yet had.
--
-- The replacement keeps the half that still matters. A *name* without a pointer is still nonsense — it
-- would be a person recorded nowhere else — so that stays forbidden. A pointer without a name is now
-- allowed, and means the person it pointed to has been erased.
ALTER TABLE nzi_console.report_versions DROP CONSTRAINT report_versions_signee_pair;
ALTER TABLE nzi_console.report_versions ADD CONSTRAINT report_versions_signee_pair
  CHECK (signee_name IS NULL OR signee_contact_id IS NOT NULL);

COMMENT ON CONSTRAINT report_versions_signee_pair ON nzi_console.report_versions IS
  'A signee name always has a contact behind it; a contact may have no name, which is what an erased signee looks like — the report still records that it was signed and stops recording by whom.';

COMMIT;
