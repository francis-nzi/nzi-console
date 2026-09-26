-- 0128 Removals: an emission factor may be negative only when it is marked as stored or sequestered carbon
-- (REFERENCE_DATA_DESIGN §4, "ICE negatives").
--
-- ## Why
--
-- 0009 declared `kgco2e_per_unit >= 0`. ICE's "Including Carbon Storage" timber values are negative — real
-- sequestration, ruled to load as priced (25 Sep 2026) — and the constraint refuses them, so the v7 import cannot
-- commit. Dropping the check would leave the import's ICE-only rule as the only guard against a negative anywhere; a
-- flag keeps the database refusing any negative that is not declared a removal, and gives reporting the marker it
-- needs: a removal is reported separately and never netted into gross Scope totals (GHG Protocol).
--
-- ## What changes
--
-- `emission_factors.is_removal boolean NOT NULL DEFAULT false`, and the check becomes
-- `kgco2e_per_unit >= 0 OR is_removal`. A removal may still be zero or positive; what the flag permits is a negative.
--
-- ## What it does not do
--
-- No backfill: every existing row takes `false`, and the old check means no existing row is negative, so none violates
-- the new one. Client factors (0034, their own `>= 0` check) are unchanged. Nothing reads the flag yet — keeping
-- removals out of gross totals is the reporting build's requirement, recorded in §4.

BEGIN;

ALTER TABLE nzi_console.emission_factors
  ADD COLUMN is_removal boolean NOT NULL DEFAULT false;

ALTER TABLE nzi_console.emission_factors DROP CONSTRAINT emission_factors_kgco2e_per_unit_check;
ALTER TABLE nzi_console.emission_factors
  ADD CONSTRAINT emission_factors_kgco2e_per_unit_check CHECK (kgco2e_per_unit >= 0 OR is_removal);

COMMENT ON COLUMN nzi_console.emission_factors.is_removal IS
  'Stored or sequestered carbon (e.g. ICE "Including Carbon Storage"): the only rows that may be negative. Reported '
  'separately as removals, never netted into gross Scope totals.';

COMMIT;
