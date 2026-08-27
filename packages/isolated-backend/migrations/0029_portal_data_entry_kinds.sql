BEGIN;

ALTER TABLE nzi_console.portal_data_entry_bucket_grants
  ADD COLUMN entry_kind text NOT NULL DEFAULT 'manual_activity'
  CHECK (entry_kind IN ('manual_activity','spend','commuting','vehicle'));

COMMIT;
