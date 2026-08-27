BEGIN;

ALTER TABLE nzi_console.portal_access_grants
  ADD COLUMN data_entry_starts_at timestamptz;

ALTER TABLE nzi_console.portal_access_grants
  ADD CONSTRAINT portal_data_entry_window_order
  CHECK (data_entry_expires_at IS NULL OR data_entry_starts_at IS NULL OR data_entry_expires_at > data_entry_starts_at);

CREATE INDEX portal_active_data_entry_windows_idx
  ON nzi_console.portal_access_grants(organisation_id,portal_user_id,job_id,data_entry_expires_at)
  WHERE revoked_at IS NULL AND data_entry_expires_at IS NOT NULL;

COMMIT;
