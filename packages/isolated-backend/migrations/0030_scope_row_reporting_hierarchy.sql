BEGIN;

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN report_label text,
  ADD COLUMN level_1 text,
  ADD COLUMN level_2 text,
  ADD COLUMN level_3 text,
  ADD COLUMN level_4 text;

UPDATE nzi_console.job_scope_rows
SET report_label = source_label,
    level_1 = 'Scope ' || split_part(scope, '.', 1),
    level_2 = CASE scope
      WHEN '1' THEN 'Direct emissions'
      WHEN '2' THEN 'Purchased energy'
      WHEN '3' THEN 'Other Scope 3'
      WHEN '3.1' THEN 'Purchased goods and services'
      WHEN '3.2' THEN 'Capital goods'
      WHEN '3.3' THEN 'Fuel- and energy-related activities'
      WHEN '3.4' THEN 'Upstream transportation and distribution'
      WHEN '3.5' THEN 'Waste generated in operations'
      WHEN '3.6' THEN 'Business travel'
      WHEN '3.7' THEN 'Employee commuting'
      WHEN '3.8' THEN 'Upstream leased assets'
      WHEN '3.9' THEN 'Downstream transportation and distribution'
      WHEN '3.10' THEN 'Processing of sold products'
      WHEN '3.11' THEN 'Use of sold products'
      WHEN '3.12' THEN 'End-of-life treatment of sold products'
      WHEN '3.13' THEN 'Downstream leased assets'
      WHEN '3.14' THEN 'Franchises'
      WHEN '3.15' THEN 'Investments'
    END;

ALTER TABLE nzi_console.job_scope_rows
  ALTER COLUMN report_label SET NOT NULL,
  ALTER COLUMN level_1 SET NOT NULL,
  ALTER COLUMN level_2 SET NOT NULL,
  ADD CONSTRAINT job_scope_rows_report_label_present CHECK (nullif(trim(report_label), '') IS NOT NULL),
  ADD CONSTRAINT job_scope_rows_level_1_present CHECK (nullif(trim(level_1), '') IS NOT NULL),
  ADD CONSTRAINT job_scope_rows_level_2_present CHECK (nullif(trim(level_2), '') IS NOT NULL),
  ADD CONSTRAINT job_scope_rows_level_3_present CHECK (level_3 IS NULL OR nullif(trim(level_3), '') IS NOT NULL),
  ADD CONSTRAINT job_scope_rows_level_4_present CHECK (level_4 IS NULL OR nullif(trim(level_4), '') IS NOT NULL);

COMMIT;
