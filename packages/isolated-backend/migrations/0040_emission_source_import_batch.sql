BEGIN;

-- B4 — spend Excel/CSV import (NZC-036). Every row committed by a bulk import
-- shares one import_batch_id so the batch can be soft-voided as a unit while it
-- is still pending/unsynced (decision D3). void is a mark, never a delete —
-- audit history stays immutable.
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN import_batch_id text;
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN voided_at timestamptz;
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN voided_by text;

ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT emission_source_void_paired
  CHECK ((voided_at IS NULL) = (voided_by IS NULL));

CREATE INDEX job_emission_sources_import_batch_idx
  ON nzi_console.job_emission_sources(organisation_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.job_emission_sources.import_batch_id IS
  'Bulk-import batch this spend source was committed in (NZC-036 B4); NULL for hand-entered / rolled-forward sources.';
COMMENT ON COLUMN nzi_console.job_emission_sources.voided_at IS
  'Set when a bulk-import batch is soft-voided; the row is excluded like an archive but the void is auditable.';

COMMIT;
