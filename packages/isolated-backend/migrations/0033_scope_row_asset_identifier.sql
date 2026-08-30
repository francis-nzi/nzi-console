BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN asset_identifier text,
  ADD CONSTRAINT job_scope_rows_asset_identifier_present
    CHECK (asset_identifier IS NULL OR (nullif(trim(asset_identifier), '') IS NOT NULL AND char_length(asset_identifier) <= 240));

COMMENT ON COLUMN nzi_console.job_scope_rows.asset_identifier IS
  'Optional bucket-agnostic source reference such as a vehicle registration, employee name, meter ID, or asset code.';

COMMIT;
