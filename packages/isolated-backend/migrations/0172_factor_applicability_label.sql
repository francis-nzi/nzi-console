-- 0172 A factor's label under each category it may be filed under, and the row that records it was filed so (BUILD-dataset-factor-
-- dedup slice 3; ruled 20 Oct 2026: "Option 1 — label on applicability").
--
-- ## Why
--
-- Slice 3 lets the resolver price a (base, category) pair off the base's own value, valid because the category is in the base's
-- applicability (0170) — no `<base><suffix>` value row needed. The number is the base's, and 0170 guarantees it equals any
-- variant's. The label is not the base's. On J000663 the commuting rows use NZI's `-c` copies of DESNZ's *Business Travel*
-- car, bus and rail factors: the same value, but the variant's curated report label is "Employee Commuting: Average Car Diesel"
-- where the base's is "Business Travel: Average Car Diesel". A report label joins on the full factor id, so a commuting row
-- priced off the base would print "Business Travel…" on a commuting line — prices identical, report wrong.
--
-- So the label a factor carries under a category moves to the applicability row that already records the pair. The variant's
-- own curated string is relocated, not recomposed, so a row filed the new way prints byte-for-byte what its variant printed, and
-- the label survives slice 5's retirement of the variant rows.
--
-- ## What this adds
--
-- 1. `factor_identity_categories.report_label` and `.label` — nullable, never blank: what a line filed under this (factor,
--    category) prints, and the factor label the audit names. Both relocated from each pair's variant identity (`<base><suffix>`),
--    the exact strings: on staging all 388 pairs have one, and all 388 variant identities carry both. A pair with no variant identity
--    (one NZI curated beyond the source) is left NULL until an admin names it. The ruling named the report label; the factor label
--    is the same move, because the composed audit prints it and J000663 must read exactly as today in both places.
-- 2. `job_scope_rows.filed_suffix_code` — nullable, a registry suffix: this row's factor is a base, filed under that category by
--    applicability. Only a dataset factor may be filed so (CHECK). NULL — every existing row — means what it always meant: the row's
--    factor id says what it is. Written only by the slice-3 path, which is behind REPORT_FACTOR_APPLICABILITY (off by default).
--
-- ## What it does not change
--
-- No existing row, no resolved factor, no issued report: every filed_suffix_code starts NULL, and a NULL row's label resolves
-- exactly as before. The resolver reads none of this until the flag is turned on. NZC-120 untouched. The runner wraps this.

-- ── 1. The label under each category ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.factor_identity_categories
  ADD COLUMN report_label text NULL,
  ADD COLUMN label text NULL,
  ADD CONSTRAINT factor_identity_category_report_label_shape CHECK (report_label IS NULL OR btrim(report_label) <> ''),
  ADD CONSTRAINT factor_identity_category_label_shape CHECK (label IS NULL OR btrim(label) <> '');
COMMENT ON COLUMN nzi_console.factor_identity_categories.report_label IS
  'What a line filed under this (factor, category) prints — the curated report label its variant identity carried, relocated here so it survives the variant row. NULL: none set; a line filed so then falls through past the identity label (it never prints the base''s).';
COMMENT ON COLUMN nzi_console.factor_identity_categories.label IS
  'The factor''s curated label under this category — the variant identity''s own, relocated — which a row filed so stores as its factor label (it prints as the audit''s factor). NULL: none set; the row keeps the label it was sent.';

-- Both of the variant identity's curated strings move: its report label (the line) and its label (the factor the audit names). A
-- commuting row priced off its business-travel base must print exactly what its -c row printed, in both places.
DO $$
DECLARE org text; labelled bigint; unlabelled bigint;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org, true);
    UPDATE nzi_console.factor_identity_categories a
       -- The exact strings, byte for byte (a blank one is no label).
       SET report_label = CASE WHEN btrim(coalesce(v.report_label, '')) <> '' THEN v.report_label END,
           label = CASE WHEN btrim(coalesce(v.label, '')) <> '' THEN v.label END
      FROM nzi_console.factor_identities v
     WHERE a.organisation_id = org AND v.organisation_id = org
       AND v.factor_id = a.factor_id || a.suffix_code;
    GET DIAGNOSTICS labelled = ROW_COUNT;
    SELECT count(*) INTO unlabelled FROM nzi_console.factor_identity_categories WHERE organisation_id = org AND report_label IS NULL;
    IF labelled > 0 OR unlabelled > 0 THEN
      RAISE NOTICE '0172 applicability labels for %: % relocated from their variant identity, % without one', org, labelled, unlabelled;
    END IF;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END $$;

-- ── 2. The row records that it was filed by applicability ─────────────────────────────────────────────────────────

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN filed_suffix_code text NULL REFERENCES nzi_console.factor_category_variants (suffix_code),
  ADD CONSTRAINT job_scope_rows_filed_suffix_dataset_only CHECK (filed_suffix_code IS NULL OR factor_source = 'dataset');
COMMENT ON COLUMN nzi_console.job_scope_rows.filed_suffix_code IS
  'Dedup slice 3: this row''s factor is a base, filed under that registry suffix''s category by applicability (factor_identity_categories) — priced off the base''s value, labelled by the pair''s report_label. NULL: the factor id says what it is, as before 0172.';
