BEGIN;

-- DA3b (NZC-060) — optimistic concurrency on gap resolutions. Two reviewers
-- (or a reviewer and a recompute) resolving the same gap concurrently must not
-- silently clobber one another; `assurance.gap.resolve` now takes
-- `expectedVersion` (0 = no resolution yet), the same convention as
-- `report.section.edit` (R2).

ALTER TABLE nzi_console.gap_resolutions
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

COMMENT ON COLUMN nzi_console.gap_resolutions.version IS
  'Optimistic lock for assurance.gap.resolve; 0 (no row) means unresolved.';

COMMIT;
