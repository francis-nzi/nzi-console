BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN factor_version text,
  ADD COLUMN factor_label text,
  ADD COLUMN quality_tier text CHECK (quality_tier IN ('measured','estimated','spend-based','survey')),
  ADD COLUMN provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance_json) = 'object'),
  ADD COLUMN lineage_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lineage_json) = 'array'),
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE nzi_console.job_scope_rows
  ADD CONSTRAINT job_scope_rows_scope_format CHECK (scope ~ '^(1|2|3([.][0-9]+)?)$'),
  ADD CONSTRAINT job_scope_rows_quantity_nonnegative CHECK (quantity IS NULL OR quantity >= 0);

CREATE INDEX job_scope_rows_job_enabled_idx
  ON nzi_console.job_scope_rows (organisation_id, job_id, enabled, scope);

COMMIT;
