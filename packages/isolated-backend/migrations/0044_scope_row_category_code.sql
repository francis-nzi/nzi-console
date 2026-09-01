BEGIN;

-- NZC-046 / UX1 — the data-entry accordion attributes each row to a stored
-- category taxonomy code (contracts `emissionCategoryTaxonomy`). Scope 3 codes
-- already equal the row `scope` string ("3.1".."3.15"); Scope 1/2 gain a finer
-- category ("1.natural-gas", "1.company-vehicles", "1.refrigerants",
-- "2.purchased-electricity", "2.renewable-electricity"). Additive and nullable:
-- existing rows keep null and fall back to `scope` for grouping until re-saved.

ALTER TABLE nzi_console.job_scope_rows ADD COLUMN category_code text;
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN category_code text;

COMMENT ON COLUMN nzi_console.job_scope_rows.category_code IS
  'NZC-046 category taxonomy code (emissionCategoryTaxonomy); groups the row into its accordion section. Falls back to `scope` when null.';

COMMIT;
