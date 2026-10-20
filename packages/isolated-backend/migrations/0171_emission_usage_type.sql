-- 0171 A record's usage type — Car, Van, HGV, Motorcycle, Generator — as a governed vocabulary on the record (BUILD-dataset-factor-
-- dedup slice 2; Direction A). Ruled 19 Oct 2026: a new column, not source_subtype.
--
-- ## Why
--
-- A client wants "Diesel — Car / Van / HGV" as separate reported lines, all priced from the one diesel-litres factor. Today the
-- only way to get the label onto the report is a factor per label: the -vcd / -vh / -vvd variants, each a copy of the diesel
-- value (DEEP-DIVE §6b, case 2). The usage belongs to the record, not the factor. This slice puts it there and lets the report
-- label by it, so slice 5 can retire the label-only variants.
--
-- ## Why a new column and not job_emission_sources.source_subtype
--
-- source_subtype already has a meaning: the spend ledger's GL code (the spend import writes it, its duplicate key reads it, the
-- spend roll-forward copies it). One column must not mean two things. And CRP data entry writes scope rows directly — the
-- record the report reads — so the usage has to live on job_scope_rows; a register source carries it too and its sync copies it.
--
-- ## What this adds
--
-- 1. The vocabulary: a reference category `emission_usage_type` (organisation-scoped, as 0089's) seeded per organisation —
--    Car, Van, HGV, Motorcycle, Generator — by a provision function, for every organisation now and every new one (the 0145 /
--    0155 pattern). Admin curates it on the Lookups screen (reference.value.*): add, relabel, deactivate; never delete.
-- 2. `usage_type_id` on job_scope_rows and job_emission_sources: nullable — offered, not required; an unset usage reports
--    exactly as today. A composite foreign key to reference_values, and a CHECK that the id is this category's
--    ('emission_usage_type:…' — seeded and admin-created ids both carry the prefix), so a record can only name a usage type,
--    for every writer. The commands also refuse an inactive value newly chosen.
--
-- ## What it does not change
--
-- No existing row is touched: every usage_type_id starts NULL, and NULL reports, snapshots and composes byte-identically to
-- today. The one visible change is the entry form: three categories offer an optional "Usage type" (section 3). No resolved factor changes; the resolver is untouched (slice 3). Grants are table-level on both tables, so the app role
-- writes the new columns already. NZC-120: a usage type is neither money nor personal data. The runner wraps this.

-- ── 1. The vocabulary ────────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('emission_usage_type', 'Usage types', 'organisation',
   'What an emission record''s source is used as — Car, Van, HGV, Generator… The report labels a line by it, so one factor can be reported under several usages without a factor per label.',
   false, NULL);

CREATE FUNCTION nzi_console.provision_organisation_usage_types(p_organisation_id text, p_actor text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  added integer;
BEGIN
  -- `source` is left at its default with no source_system, which Lookups reads as "Seeded" (not "Added here").
  INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, sort_order, created_by, updated_by)
  SELECT p_organisation_id, 'emission_usage_type', 'emission_usage_type:' || seed.slug, seed.label, seed.sort_order, p_actor, p_actor
    FROM (VALUES ('car', 'Car', 10), ('van', 'Van', 20), ('hgv', 'HGV', 30), ('motorcycle', 'Motorcycle', 40),
                 ('generator', 'Generator', 50)) AS seed(slug, label, sort_order)
   WHERE NOT EXISTS (SELECT 1 FROM nzi_console.reference_values v
                      WHERE v.organisation_id = p_organisation_id AND v.category_key = 'emission_usage_type' AND lower(v.label) = lower(seed.label))
  ON CONFLICT (organisation_id, value_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$;

DO $$
DECLARE
  org record;
  added integer;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    PERFORM set_config('app.organisation_id', org.organisation_id, true);
    added := nzi_console.provision_organisation_usage_types(org.organisation_id, 'migration:0171');
    RAISE NOTICE '0171 usage types: organisation % · % seeded', org.organisation_id, added;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END;
$$;

CREATE FUNCTION nzi_console.provision_new_organisation_usage_types() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nzi_console.provision_organisation_usage_types(NEW.organisation_id, 'migration:0171');
  RETURN NEW;
END;
$$;
CREATE TRIGGER provision_usage_types_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation_usage_types();

-- ── 2. The usage on the record ───────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.job_scope_rows
  ADD COLUMN usage_type_id text NULL,
  ADD CONSTRAINT job_scope_rows_usage_type_vocabulary CHECK (usage_type_id IS NULL OR usage_type_id LIKE 'emission_usage_type:%'),
  ADD CONSTRAINT job_scope_rows_usage_type_fk FOREIGN KEY (organisation_id, usage_type_id)
    REFERENCES nzi_console.reference_values (organisation_id, value_id);
COMMENT ON COLUMN nzi_console.job_scope_rows.usage_type_id IS
  'What the row''s source is used as (an emission_usage_type value: Car, Van, HGV…). The report labels the line "<activity> — <usage>". NULL: no usage, reported exactly as before 0171.';

ALTER TABLE nzi_console.job_emission_sources
  ADD COLUMN usage_type_id text NULL,
  ADD CONSTRAINT job_emission_sources_usage_type_vocabulary CHECK (usage_type_id IS NULL OR usage_type_id LIKE 'emission_usage_type:%'),
  ADD CONSTRAINT job_emission_sources_usage_type_fk FOREIGN KEY (organisation_id, usage_type_id)
    REFERENCES nzi_console.reference_values (organisation_id, value_id);
COMMENT ON COLUMN nzi_console.job_emission_sources.usage_type_id IS
  'What the source is used as (an emission_usage_type value); copied to its scope row by emission.source.sync. Not source_subtype, which is the spend GL code.';

-- ── 3. Data entry asks for it — through the governed input spec, not a field built in code (NZC-102) ──────────────
--
-- Identical in shape to the entries added to `inputSpec.seed.json`, because the fixture and this migration are two
-- representations of one spec and the render characterisation is what proves they agree (the 0117 precedent). The render
-- golden moves on purpose, in this change: these three categories gain an optional "Usage type" after the activity.
--
-- Where a usage means something: company vehicles (Car / Van / HGV / Motorcycle, and a Generator — v7 reported a diesel
-- generator beside the cars and vans on the one diesel-litres factor), and business travel and commuting (by car, by van…).
-- Not Other Stationary Fuels: NZC-168 rules it Natural Gas's form field for field (0165), and a field on one would break that.
-- The consultant's form only — `crm` — as quality tier and confidence are: a client portal entry never sees it. Not under lean capture, which keeps the core fields; optional everywhere — an unset
-- usage reports exactly as today.
INSERT INTO nzi_console.input_spec_fields
  (category_code, field_key, ordering, control, label, hint, optional, when_audiences, when_lean, created_by, updated_by)
VALUES
  ('1.company-vehicles', 'usageType', 35, 'select', 'Usage type',
   'What this is used as — the report shows the line as "<activity> — <usage>", so one factor can be reported for several usages.',
   true, ARRAY['crm'], false, 'migration:0171', 'migration:0171'),
  ('3.6', 'usageType', 35, 'select', 'Usage type',
   'What this is used as — the report shows the line as "<activity> — <usage>", so one factor can be reported for several usages.',
   true, ARRAY['crm'], false, 'migration:0171', 'migration:0171'),
  ('3.7', 'usageType', 35, 'select', 'Usage type',
   'What this is used as — the report shows the line as "<activity> — <usage>", so one factor can be reported for several usages.',
   true, ARRAY['crm'], false, 'migration:0171', 'migration:0171');
