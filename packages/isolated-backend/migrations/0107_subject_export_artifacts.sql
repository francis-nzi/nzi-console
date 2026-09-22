-- 0107 Where a subject access response lives for the short while it exists (NZC-134, NZC-135).
--
-- ## What this holds, and why that is uncomfortable
--
-- An export is the most sensitive object this system ever produces: every attributable field this
-- organisation holds about one person, decrypted, in one place. Everything else in the schema is
-- encrypted per subject precisely so that no such object exists. This one has to exist, because the
-- right of access means handing it over — so the answer is not to avoid creating it but to make its
-- lifetime short, its readership one person, and its destruction structural rather than a cleanup job
-- somebody has to remember to run.
--
-- ## Two tables, because two different things are being kept
--
--   * `subject_export_artifacts` — **permanent**. Who asked, for whom, under what reference, when it was
--     produced, when and why it was destroyed, and how much it contained. No personal data at all. This
--     is the evidence the request was fulfilled, and it has to outlive the response.
--
--   * `subject_export_payloads` — **UNLOGGED**. The sealed response and the key that opens it. Exists
--     only inside the window.
--
-- Splitting them is what lets the second be unlogged without losing the first.
--
-- ## Why UNLOGGED is the load-bearing word
--
-- The destruction story is "shredding the key reaches every copy of the ciphertext, including copies an
-- UPDATE cannot touch". That claim is true for the live row and for streaming replicas, which follow the
-- primary. It was **not** true for a point-in-time backup: a snapshot taken mid-window holds the
-- pre-shred key *and* the ciphertext, and shredding the live key does not reach it — that copy would
-- outlive the window and die of backup retention instead, which is a different and much weaker promise.
--
-- An UNLOGGED table is not written to WAL. Concretely, for this table:
--
--   * nothing about it enters the write-ahead log, so it is **not in PITR** and there is no point in
--     time to which it can be recovered;
--   * it is **not replicated** to a streaming standby, so no replica ever holds a key or a ciphertext;
--   * after any restore from a physical base backup — and after any unclean shutdown — an unlogged table
--     is **empty**, because recovery truncates it.
--
-- So the pre-shred key and ciphertext exist in exactly one place that can be reached, and the shred
-- reaches it. The claim is now complete rather than bounded by a retention period.
--
-- The one remaining path is a **logical** dump: `pg_dump` includes unlogged table *data* unless it is
-- given `--no-unlogged-table-data`. Any dump procedure that touches this database must pass that flag —
-- stated here because it is the single place where this arrangement depends on something outside the
-- schema, and an undocumented dependency is how the last such assumption went unnoticed (NZC-122).
--
-- The cost of UNLOGGED is that an unclean restart empties the window early, and the subject requests
-- again. That is the right trade: it fails towards destroying the artifact rather than towards keeping
-- it, and the compliance record in the permanent table is untouched either way.
--
-- ## Destruction is the absence of a row, not a row full of nulls
--
-- Readable and destroyed are now distinguishable by existence: the payload row is there, with all three
-- columns NOT NULL, or it is gone. There is no half state to represent and none to check for.
--
-- This is the one table in the schema where DELETE is granted, and it is granted because these rows are
-- *meant* to cease existing. It is revoked on the permanent table as everywhere else: a removed artifact
-- row would be indistinguishable from an export that never happened, which would lose the record this
-- whole arrangement exists to keep.

BEGIN;

-- ── The permanent record: an export happened, and nothing about its contents ─────────
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

  -- What it contained, so the compliance record outlives the contents.
  record_count integer NOT NULL,
  datum_count integer NOT NULL,
  withheld_count integer NOT NULL,

  downloaded_at timestamptz,
  destroyed_at timestamptz,
  destroyed_reason text CHECK (destroyed_reason IN ('downloaded','expired')),

  PRIMARY KEY (organisation_id, export_id),

  -- Destroyed means destroyed for a stated reason. `destroyed_reason` is constrained rather than free
  -- text because "was it downloaded or did it lapse" is a question a regulator can ask, and the answer
  -- should not depend on how somebody phrased it.
  CONSTRAINT subject_export_destroyed_has_a_reason CHECK (
    (destroyed_at IS NULL) = (destroyed_reason IS NULL)),

  -- A window with no end is the failure this whole arrangement is against.
  CONSTRAINT subject_export_expires_after_creation CHECK (expires_at > created_at)
);

-- ── The transient half: the response, and the key that opens it ──────────────────────
--
-- UNLOGGED on purpose. See the header: this is what makes "the shred reaches every copy" true rather
-- than nearly true.
CREATE UNLOGGED TABLE nzi_console.subject_export_payloads (
  organisation_id text NOT NULL,
  export_id text NOT NULL,

  -- The machine-readable response and the human-readable rendering of the same content.
  sealed_json jsonb NOT NULL,
  sealed_html jsonb NOT NULL,

  -- This artifact's own ephemeral key, wrapped by the master key. Deliberately not the subject's key:
  -- an export fulfils the right of access and erasure is the right to be forgotten, so sealing the
  -- response under the subject's key would let a later erasure destroy an access response the subject
  -- lawfully received and is entitled to keep (NZC-135).
  wrapped_key jsonb NOT NULL,

  PRIMARY KEY (organisation_id, export_id),
  FOREIGN KEY (organisation_id, export_id)
    REFERENCES nzi_console.subject_export_artifacts(organisation_id, export_id)
);

-- The TTL sweep's query: artifacts still inside a window that has closed.
CREATE INDEX subject_export_artifacts_expiry_idx
  ON nzi_console.subject_export_artifacts(expires_at)
  WHERE destroyed_at IS NULL;

CREATE INDEX subject_export_artifacts_subject_idx
  ON nzi_console.subject_export_artifacts(organisation_id, subject_id, created_at DESC);

-- ── Tenant isolation, on both ────────────────────────────────────────────────────────
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['subject_export_artifacts', 'subject_export_payloads'] LOOP
    EXECUTE format('ALTER TABLE nzi_console.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE nzi_console.%I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON nzi_console.%I
        USING (organisation_id = current_setting('app.organisation_id', true))
        WITH CHECK (organisation_id = current_setting('app.organisation_id', true))$p$, target);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON nzi_console.subject_export_artifacts TO nzi_console_app;

-- The sweep runs in the worker: it finds lapsed artifacts, marks them destroyed, and removes their
-- payloads. It never reads a payload and has no reason to be able to — but SELECT on the payload table
-- is what a DELETE needs to find its row, so the confinement that matters is that the *key* is what
-- reads a payload, and destroying the row destroys the key with it.
GRANT SELECT, UPDATE ON nzi_console.subject_export_artifacts TO nzi_console_worker;

-- DELETE, granted here and nowhere else in this schema, because these rows are meant to cease existing.
GRANT SELECT, INSERT, DELETE ON nzi_console.subject_export_payloads TO nzi_console_app;
GRANT SELECT, DELETE ON nzi_console.subject_export_payloads TO nzi_console_worker;

-- No UPDATE on a payload at all: a sealed response is written once and then either read or destroyed.
REVOKE UPDATE ON nzi_console.subject_export_payloads
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

REVOKE DELETE ON nzi_console.subject_export_artifacts
  FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMENT ON TABLE nzi_console.subject_export_artifacts IS
  'The record that a subject access export happened: who asked, for whom, under what reference, when it was produced and when and why it was destroyed, and how much it contained. No personal data. Retained after the response itself is gone, because it is the evidence the request was fulfilled.';

COMMENT ON TABLE nzi_console.subject_export_payloads IS
  'One sealed subject access response and the ephemeral key that opens it. UNLOGGED deliberately: nothing about it enters the WAL, so it is absent from PITR, never reaches a replica, and is empty after any restore from a physical backup — which is what makes destroying the key reach every copy of the ciphertext rather than every copy except a backup. A logical pg_dump must pass --no-unlogged-table-data. The row exists inside the window and is deleted when the download completes or the window closes.';

COMMENT ON COLUMN nzi_console.subject_export_artifacts.downloaded_at IS
  'When a download completed. Before that, within the window, the authenticated link keeps working: a dropped connection is a retry, not a burned artifact that forces a re-request — and a re-request would only mint another copy of the same personal data.';

COMMIT;
