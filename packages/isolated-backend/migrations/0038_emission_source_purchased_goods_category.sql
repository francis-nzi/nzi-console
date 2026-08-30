BEGIN;

-- Spend sources (and any other Scope 3.1 register entry) carry the client's
-- controlled purchased-goods category, so the sync into job_scope_rows can set
-- the same FK the manual scope-row path already uses (0015, NZC-033).
ALTER TABLE nzi_console.job_emission_sources ADD COLUMN purchased_goods_category_id text;
ALTER TABLE nzi_console.job_emission_sources
  ADD CONSTRAINT emission_source_purchased_goods_category_fk
  FOREIGN KEY (organisation_id, purchased_goods_category_id)
  REFERENCES nzi_console.purchased_goods_categories(organisation_id, category_id);

COMMENT ON COLUMN nzi_console.job_emission_sources.purchased_goods_category_id IS
  'Controlled PG&S category (NZC-033); carried into the synced Scope 3.1 canonical row.';

COMMIT;
