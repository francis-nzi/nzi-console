-- 0107 Where a subject access response lives for the short while it exists (NZC-134, NZC-135).
--
-- ## What this table holds, and why that is uncomfortable
--
-- An export is the most sensitive object this system ever produces: every attributable field this
-- organisation holds about one person, decrypted, in one place. Everything else in the schema is
-- encrypted per subject precisely so that no such object exists. This one has to exist, because the
-- right of access means handing it over — so the answer is not to avoid creating it but to make its
-- lifetime short, its readership one person, and its destruction structural rather than a cleanup job
-- somebody has to remember to run.
--
-- ## Sealed under a key of its own, not the subject's
--
-- The artifact is encrypted under a **per-export ephemeral key**, wrapped by the master key like any
-- subject key, and that key is destroyed when the download completes or the TTL expires — whichever
-- comes first.
--
-- Deliberately **not** the subject's key. An export fulfils the right of access; erasure is the right to
-- be forgotten by the controller. Different rights, different lifecycles. Sealing the response under
-- the subject's key would let a later erasure retroactively destroy an access response the subject
-- lawfully received and is entitled to keep — which is not completeness, it is destroying the subject's
-- own copy for a reason that has nothing to do with this artifact's retention window (NZC-135).
--
-- ## Destruction is both a shred and a null, for two different reasons
--
-- On destruction the wrapped key is nulled **and** so are the two sealed payloads:
--
--   * nulling the payloads is what empties this row, which is what "the artifact is destroyed" means
--     for anyone reading the live database;
--   * shredding the key is what covers every copy this row has already been made into — a backup, a
--     replica, a WAL segment, a snapshot taken mid-window. Those are not reachable by an UPDATE, and
--     without the key they are ciphertext with no key anywhere.
--
-- Neither alone is sufficient, so both happen in the same statement.
--
-- ## The row survives its contents, on purpose
--
-- After destruction the row still says: an export happened, for this subject, requested by this actor,
-- under this request reference, produced then, destroyed then, for this reason, and it contained this
-- many records and fields. That is the evidence the request was fulfilled, and it is exactly the part
-- that carries no personal data — so it is retained while the contents are not. The audit event says
-- the same thing independently; this is the record of the artifact, not a second audit.
--
-- `destroyed_reason` is constrained rather than free text because "was it downloaded or did it lapse"
-- is a question a regulator can ask, and the answer should not depend on how somebody phrased it.
--
-- ## DELETE is revoked, like everywhere else
--
-- The row is emptied, never removed. A deleted row is indistinguishable from an export that never
-- happened, which would lose the compliance record this table exists to keep.

BEGIN;

CREATE TABLE nzi_console.subject_export_artifacts (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  export_id text NOT NULL,
  subject_id text NOT NULL,

  -- Who asked, under what reference, and who may read it back. The recipient is recorded at creation
  -- and compared on every read: "retrievable only by the authorised recipient" is a column, not a
  -- convention.
  requested_by text NOT NULL,
  request_ref text,
  recipient_principal text NOT NULL CHECK (recipient_principal IN ('staff','portal')),
  recipient_id text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,

  -- The sealed artifact: the machine-readable response and the human-readable rendering of the same
  -- content. Both nulled on destruction.
  sealed_json jsonb,
  sealed_html jsonb,

  -- NULL once shredded, which is what makes every copy of the payloads unreadable.
  wrapped_key jsonb,

  -- What it contained, so the compliance record outlives the contents.
  record_count integer NOT NULL,
  datum_count integer NOT NULL,
  withheld_count integer NOT NULL,

  downloaded_at timestamptz,
  destroyed_at timestamptz,
  destroyed_reason text CHECK (destroyed_reason IN ('downloaded','expired')),

  PRIMARY KEY (organisation_id, export_id),

  -- An artifact is either intact or destroyed, and never half of each: a destroyed row has no key, no
  -- payloads and a reason, and an intact one has a key and both payloads. Without this a shred that
  -- nulled the key and left a payload behind would look like a normal row.
  CONSTRAINT subject_export_destroyed_consistently CHECK (
    (destroyed_at IS NULL AND destroyed_reason IS NULL AND wrapped_key IS NOT NULL
      AND sealed_json IS NOT NULL AND sealed_html IS NOT NULL)
    OR
    (destroyed_at IS NOT NULL AND destroyed_reason IS NOT NULL AND wrapped_key IS NULL
      AND sealed_json IS NULL AND sealed_html IS NULL)),

  -- A window with no end is the failure this whole arrangement is against.
  CONSTRAINT subject_export_expires_after_creation CHECK (expires_at > created_at)
);

-- The TTL sweep's query: the artifacts still holding a key past their window.
CREATE INDEX subject_export_artifacts_expiry_idx
  ON nzi_console.subject_export_artifacts(expires_at)
  WHERE destroyed_at IS NULL;

CREATE INDEX subject_export_artifacts_subject_idx
  ON nzi_console.subject_export_artifacts(organisation_id, subject_id, created_at DESC);

ALTER TABLE nzi_console.subject_export_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.subject_export_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.subject_export_artifacts
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.subject_export_artifacts TO nzi_console_app;

-- The sweep runs in the worker, which needs to find lapsed artifacts and empty them. It never needs to
-- read a payload, and has no way to: the key is what reads them, and the sweep destroys it.
GRANT SELECT, UPDATE ON nzi_console.subject_export_artifacts TO nzi_console_worker;

REVOKE DELETE ON nzi_console.subject_export_artifacts
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMENT ON TABLE nzi_console.subject_export_artifacts IS
  'One subject access response, encrypted under a per-export ephemeral key that is destroyed when the download completes or the window expires. The payloads are nulled at the same moment; the row itself is retained empty, because it is the evidence the request was fulfilled and it is the part that holds no personal data.';

COMMENT ON COLUMN nzi_console.subject_export_artifacts.wrapped_key IS
  'The ephemeral key for this artifact, wrapped by the master key. NULL once destroyed — which is what makes any copy of the payloads already taken (backup, replica, snapshot) unreadable, since those are not reachable by an UPDATE.';

COMMENT ON COLUMN nzi_console.subject_export_artifacts.downloaded_at IS
  'When a download completed. Before that, within the window, the authenticated link keeps working: a dropped connection is a retry, not a burned artifact that forces a re-request — and a re-request would only mint another copy of the same personal data.';

COMMIT;
