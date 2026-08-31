BEGIN;

-- Previous-year rollforward (NZC-030): a spend source created by copying a prior
-- reporting year's mapping forward records which prior source it came from, so
-- the rollforward is idempotent and the origin is auditable.
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN rolled_forward_from_source_id text;

ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT emission_source_rollforward_origin_fk
  FOREIGN KEY (organisation_id, rolled_forward_from_source_id)
  REFERENCES nzi_console.job_emission_sources(organisation_id, source_id);

-- One rolled-forward copy of a given prior source per target job.
CREATE UNIQUE INDEX job_emission_sources_one_rollforward_per_origin_idx
  ON nzi_console.job_emission_sources(organisation_id, job_id, rolled_forward_from_source_id)
  WHERE rolled_forward_from_source_id IS NOT NULL;

COMMENT ON COLUMN nzi_console.job_emission_sources.rolled_forward_from_source_id IS
  'Prior reporting year''s job_emission_sources.source_id this mapping was rolled forward from (NZC-030).';

COMMIT;
