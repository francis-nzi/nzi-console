BEGIN;

-- Track C — LCA/PCF reference module, slice 7 (report manifest + PCF
-- labelling). A professional EN 15804 / ISO 14067 deliverable cites the exact
-- emission factors, versions and datasets it used — and that citation must be
-- bound to what was signed off, not rebuilt from the current mapped lines
-- (which can silently drift if a factor or dataset moves after approval). So
-- `lca.assessment.snapshot.create` now freezes the factor-set list into the
-- snapshot alongside the numbers (whose `data_hash` already binds them), and
-- the report footer reads it verbatim. This is the LCA counterpart of the
-- R-track's frozen-snapshot rule (NZC-051).

ALTER TABLE nzi_console.lca_result_snapshots
  ADD COLUMN factor_sets jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(factor_sets) = 'array');

COMMENT ON COLUMN nzi_console.lca_result_snapshots.factor_sets IS
  'Frozen at sign-off: [{label,version,dataset,originalId}] — the exact factor citation the LCA/PCF report footer prints (L7).';

COMMIT;
