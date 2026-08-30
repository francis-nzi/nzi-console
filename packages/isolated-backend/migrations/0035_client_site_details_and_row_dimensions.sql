BEGIN;

-- Sites become real places with a lifecycle, not just labels.
ALTER TABLE nzi_console.client_sites
  ADD COLUMN address_lines_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(address_lines_json) = 'array'),
  ADD COLUMN postcode text,
  ADD COLUMN latitude numeric,
  ADD COLUMN longitude numeric,
  ADD COLUMN geocode_source text,
  ADD COLUMN geocode_precision text,
  ADD COLUMN active_from date,
  ADD COLUMN vacated_date date,
  ADD COLUMN archived boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT client_sites_active_before_vacated CHECK (active_from IS NULL OR vacated_date IS NULL OR active_from <= vacated_date);

-- Canonical row: apportionment, second confidence axis, conversion memory, column heading.
ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN apply_pct numeric NOT NULL DEFAULT 100 CHECK (apply_pct >= 0 AND apply_pct <= 100),
  ADD COLUMN data_confidence text CHECK (data_confidence IN ('H', 'M', 'L')),
  ADD COLUMN source_quantity numeric,
  ADD COLUMN source_unit text,
  ADD COLUMN column_text text;

COMMENT ON COLUMN nzi_console.job_scope_rows.apply_pct IS 'Apportionment percentage of the source attributed to this row (e.g. one meter split across sites).';
COMMENT ON COLUMN nzi_console.job_scope_rows.source_quantity IS 'As-entered quantity before unit conversion (conversion memory); source_unit is its unit.';
COMMENT ON COLUMN nzi_console.client_sites.vacated_date IS 'Date the client left the site; activity after this date is expected to be absent.';

COMMIT;
