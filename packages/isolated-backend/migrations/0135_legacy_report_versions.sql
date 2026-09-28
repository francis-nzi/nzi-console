-- 0135 v7's report versions, kept as sealed, hash-verified, append-only records of account
-- (docs/CLIENT_JOB_IMPORT_DESIGN.md §5.2, §7; decisions 2, 3 and 10; NZC-166).
--
-- ## Why
--
-- A historical report is what a client was told. It is never re-resolved against today's factors or today's
-- engine: the imported version is v7's snapshot, byte for byte, with the hash v7 computed over it. This table
-- holds those versions — and v7's one LCA result (§6.2) — beside the console's own `report_versions`, which it
-- does not touch.
--
-- ## How the content is sealed (decision 10, ruled 28 Sep 2026)
--
-- Every version gets **its own content key**, generated at import and stored wrapped by `NZI_SUBJECT_MASTER_KEY`
-- (`content_key_wrapped`) — envelope encryption, using the same primitives as a person's key. Two things are
-- sealed under it:
--
--   * `payload_sealed` — v7's `snapshot_json` (or the LCA's `resolved_lines_snapshot`), whole. It names people
--     (preparers, approvers, contacts) and cannot be picked apart field by field, so it is sealed as one value.
--   * `particulars_sealed` — the free text and names around the version: its label, notes, who generated,
--     reviewed, finalised and superseded it, and the PDF's file name, path and OneDrive link (a OneDrive path
--     carries its owner's name).
--
-- **The report is not a data subject.** Nothing here is registered in `data_subject_keys` or linked through
-- `data_subject_links`; a report's key is not a person's key, and erasing a person does not reach it. Personal
-- data inside a report is retained as part of a signed record of account (NZC-166), on a basis counsel confirms
-- in the DSAR build; the inventory records it that way. Destroying a report's key is **reserved** for where
-- retention is not lawful — the columns for it exist, and nothing grants the right to use them yet.
--
-- ## The hash (decision 3)
--
-- v7 writes `data_hash = sha256(snapshot_json)` over the UTF-8 text exactly as stored. `payload_sha256` is that
-- digest recomputed at import over the same bytes, and the table refuses a row where v7's hash is present and
-- disagrees. It is kept, so a version can be proved unchanged every time it is opened.
--
-- ## What is plain
--
-- Only what reconciliation and listing need and what names nobody: the job, v7's id, version number, status and
-- format verbatim, whether it was a portal version, the storage provider, and the dates. Which portal versions
-- count as *the published report* is decision 11 and is not interpreted here — the fact is stored, not a verdict.
--
-- ## Append-only
--
-- The application role may INSERT and SELECT. No role may UPDATE or DELETE a version; a trigger refuses both
-- for the owner too, with one exception reserved for later: the key-shred transition (wrapped key → NULL, with
-- who and when), which is the only change a record of account may undergo.

BEGIN;

CREATE TABLE nzi_console.legacy_report_versions (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  legacy_report_id text NOT NULL CHECK (btrim(legacy_report_id) <> ''),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('report', 'lca-result')),
  source_system text NOT NULL CHECK (btrim(source_system) <> ''),
  legacy_db_id text NOT NULL CHECK (btrim(legacy_db_id) <> ''),

  version_number integer CHECK (version_number IS NULL OR version_number > 0),
  legacy_status text NOT NULL CHECK (btrim(legacy_status) <> ''),
  report_format text,
  is_portal_version boolean NOT NULL DEFAULT false,
  storage_provider text,
  generated_at timestamptz,
  reviewed_at timestamptz,
  finalized_at timestamptz,
  superseded_at timestamptz,

  v7_data_hash text,
  payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sealed jsonb,
  particulars_sealed jsonb,

  content_key_wrapped jsonb,
  content_key_shredded_at timestamptz,
  content_key_shredded_by text,

  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by text NOT NULL CHECK (btrim(imported_by) <> ''),

  PRIMARY KEY (organisation_id, legacy_report_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id),

  -- A report version is numbered; the LCA result is an assessment and is not.
  CONSTRAINT legacy_report_versions_numbered CHECK ((kind = 'report') = (version_number IS NOT NULL)),
  -- A payload and its digest come together, or neither does (a v7 version with no snapshot is recorded as such).
  CONSTRAINT legacy_report_versions_payload_shape CHECK ((payload_sealed IS NULL) = (payload_sha256 IS NULL)),
  -- Hash verified: where v7 stated a hash, it is the digest of the bytes imported.
  CONSTRAINT legacy_report_versions_hash_verified
    CHECK (v7_data_hash IS NULL OR (payload_sha256 IS NOT NULL AND lower(btrim(v7_data_hash)) = payload_sha256)),
  -- Sealed content needs a key to be sealed under — or a record of that key's destruction.
  CONSTRAINT legacy_report_versions_key_shape CHECK (
    (content_key_wrapped IS NULL) = (content_key_shredded_at IS NOT NULL AND content_key_shredded_by IS NOT NULL)
    AND (content_key_shredded_at IS NULL) = (content_key_shredded_by IS NULL)),
  CONSTRAINT legacy_report_versions_sealed_shape CHECK (
    (payload_sealed IS NULL OR payload_sealed ?& ARRAY['ciphertext','iv','tag'])
    AND (particulars_sealed IS NULL OR particulars_sealed ?& ARRAY['ciphertext','iv','tag'])
    AND (content_key_wrapped IS NULL OR content_key_wrapped ?& ARRAY['ciphertext','iv','tag']))
);

CREATE UNIQUE INDEX legacy_report_versions_import_identity_key
  ON nzi_console.legacy_report_versions (organisation_id, source_system, kind, legacy_db_id);
CREATE INDEX legacy_report_versions_by_job
  ON nzi_console.legacy_report_versions (organisation_id, job_id);

COMMENT ON TABLE nzi_console.legacy_report_versions IS
  'v7 report versions and LCA results as imported: whole payload sealed under a per-report content key wrapped by NZI_SUBJECT_MASTER_KEY, hash-verified, append-only. A record of account, not a data subject (decision 10, NZC-166).';
COMMENT ON COLUMN nzi_console.legacy_report_versions.payload_sealed IS
  'v7 snapshot_json (or resolved_lines_snapshot), sealed whole under this version''s content key. Never re-resolved.';
COMMENT ON COLUMN nzi_console.legacy_report_versions.particulars_sealed IS
  'Label, notes, the people who generated/reviewed/finalised/superseded it, and the PDF''s file name, path and link — sealed under the same content key.';
COMMENT ON COLUMN nzi_console.legacy_report_versions.payload_sha256 IS
  'sha256 of the payload''s UTF-8 bytes as imported; equals v7''s data_hash wherever v7 stated one.';
COMMENT ON COLUMN nzi_console.legacy_report_versions.content_key_wrapped IS
  'This version''s own content key, wrapped by NZI_SUBJECT_MASTER_KEY. Not a person''s key. Nulled only by the reserved key-shred (NZC-166).';
COMMENT ON COLUMN nzi_console.legacy_report_versions.is_portal_version IS
  'v7 named this version as the one shown in the client portal. Whether that makes it the published report is decision 11.';

CREATE FUNCTION nzi_console.refuse_legacy_report_version_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy report versions are records of account and are never deleted (%)', OLD.legacy_report_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The one reserved change: destroying the content key, with who and when. Everything else stays as imported.
  IF OLD.content_key_wrapped IS NOT NULL AND NEW.content_key_wrapped IS NULL
     AND (to_jsonb(NEW) - ARRAY['content_key_wrapped','content_key_shredded_at','content_key_shredded_by'])
       = (to_jsonb(OLD) - ARRAY['content_key_wrapped','content_key_shredded_at','content_key_shredded_by']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legacy report versions are immutable records of account (%)', OLD.legacy_report_id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER legacy_report_versions_immutable
  BEFORE UPDATE ON nzi_console.legacy_report_versions
  FOR EACH ROW EXECUTE FUNCTION nzi_console.refuse_legacy_report_version_change();
CREATE TRIGGER legacy_report_versions_undeletable
  BEFORE DELETE ON nzi_console.legacy_report_versions
  FOR EACH ROW EXECUTE FUNCTION nzi_console.refuse_legacy_report_version_change();

ALTER TABLE nzi_console.legacy_report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.legacy_report_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.legacy_report_versions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.legacy_report_versions FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.legacy_report_versions TO nzi_console_app;

COMMIT;
