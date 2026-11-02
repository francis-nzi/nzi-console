-- Portal files (BRIEF-portal-files-secure-upload-storage): the record of a file shared in either direction — NZI → client
-- (deliverable) and client → NZI (client_upload). The bytes live behind a storage adapter; this row holds only what the portal
-- needs and nothing a provider-specific query could depend on: the provider name, an opaque external item id and the SHA-256.
-- A file is quarantined on arrival and servable only once released; it is deactivated, never deleted.
CREATE TABLE nzi_console.portal_files (
  organisation_id text NOT NULL,
  file_id text NOT NULL,
  client_id text NOT NULL,
  job_id text,
  direction text NOT NULL CHECK (direction IN ('client_upload', 'deliverable')),
  status text NOT NULL CHECK (status IN ('quarantined', 'released', 'rejected', 'deactivated')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 120),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_provider text NOT NULL CHECK (storage_provider IN ('sharepoint', 'local')),
  external_item_id text,
  flag text CHECK (flag IN ('infected', 'oversize', 'type_not_allowed', 'executable', 'macro', 'empty', 'scan_inconclusive', 'scan_failed')),
  flag_detail text CHECK (flag_detail IS NULL OR char_length(flag_detail) <= 500),
  uploaded_by text NOT NULL,
  uploaded_by_principal text NOT NULL CHECK (uploaded_by_principal IN ('staff', 'portal')),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  deactivated_at timestamptz,
  deactivated_by text,
  deactivated_reason text CHECK (deactivated_reason IS NULL OR char_length(deactivated_reason) <= 500),
  PRIMARY KEY (organisation_id, file_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id) ON DELETE CASCADE,
  -- Who sends which way: a deliverable is staff's, a client upload is the client's.
  CONSTRAINT portal_files_direction_principal CHECK ((direction = 'deliverable' AND uploaded_by_principal = 'staff') OR (direction = 'client_upload' AND uploaded_by_principal = 'portal')),
  -- Servable means released: it has bytes, a release time and no flag. A rejected file says why. A held file says it is held.
  CONSTRAINT portal_files_released_shape CHECK (status <> 'released' OR (external_item_id IS NOT NULL AND released_at IS NOT NULL AND flag IS NULL)),
  CONSTRAINT portal_files_rejected_flagged CHECK (status <> 'rejected' OR flag IS NOT NULL),
  CONSTRAINT portal_files_quarantined_has_bytes CHECK (status <> 'quarantined' OR external_item_id IS NOT NULL),
  CONSTRAINT portal_files_deactivated_shape CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL))
);
CREATE INDEX portal_files_client_idx ON nzi_console.portal_files(organisation_id, client_id, uploaded_at DESC);
CREATE INDEX portal_files_job_idx ON nzi_console.portal_files(organisation_id, job_id) WHERE job_id IS NOT NULL;
ALTER TABLE nzi_console.portal_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_files USING (organisation_id = current_setting('app.organisation_id', true)) WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
-- No DELETE: a file is deactivated, never deleted.
GRANT SELECT, INSERT, UPDATE ON nzi_console.portal_files TO nzi_console_app;
COMMENT ON TABLE nzi_console.portal_files IS 'Portal files, both directions. Quarantined on arrival, servable only when released, deactivated never deleted. Bytes live behind a storage adapter; storage_provider + external_item_id + sha256 are all this row knows of them.';
