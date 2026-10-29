BEGIN;

-- 0197 Master templates (data-entry templates R1, ruled 29 Oct 2026: BUILD-data-entry-templates.md) — the organisation's
-- starting templates, authored in admin: `Master · Default`, `Master · Construction`, `Master · Office`. A master is the
-- shape of a client's reporting template (0159) — scope → category → lines, each line an activity named by its factor's
-- identity (0125) — but held on the organisation, not a client: it is **site-agnostic** and names **no dataset**, so a
-- job resolves each line's factor to its own editions when it is seeded. A template is a shell: **never a quantity**.
--
-- ## The two tables
--
-- 1. **`master_templates`** — the header: its name (the `<Type>` in `Master · <Type>`, unique per organisation,
--    case-insensitive, archived ones included, so a reinstate never collides), whether it is active, and `rows_version`,
--    the version of its lines in force (0 until lines are first set). Renamed, archived and reinstated in place, so the
--    app holds UPDATE on those columns alone; never deleted (0147's rule) — archiving says why.
-- 2. **`master_template_rows`** — a version of the lines, written whole by `master.template.rows.set` as the next
--    `rows_version`. Append-only (SELECT, INSERT): the version before stays readable, as 0159's do.
--
-- A line's category is required: a master is curated, so nothing in it is "to categorise". Its factor is optional — a
-- category shell (a PG&S line, whose spend is captured through its own pathway) names none.
--
-- ## Seeded
--
-- The three masters, empty (rows_version 0), for every organisation — now, and on each new one (the 0171 pattern). Their
-- lines are an administrator's to author; this migration invents no activity.
--
-- Forced row-level security and the tenant policy; no DELETE for anyone; nothing here is personal data.

CREATE TABLE nzi_console.master_templates (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  master_id text NOT NULL CHECK (btrim(master_id) <> ''),
  -- The `<Type>`; shown as `Master · <Type>`.
  name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
  active boolean NOT NULL DEFAULT true,
  -- Archive, never delete: an archive says why, and reinstating clears it.
  archived_reason text CHECK (archived_reason IS NULL OR (archived_reason = btrim(archived_reason) AND archived_reason <> '')),
  rows_version integer NOT NULL DEFAULT 0 CHECK (rows_version >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, master_id),
  CONSTRAINT master_templates_archive_reason CHECK (active = (archived_reason IS NULL))
);
CREATE UNIQUE INDEX master_templates_name_key ON nzi_console.master_templates (organisation_id, lower(name));
COMMENT ON TABLE nzi_console.master_templates IS
  'Master templates (data-entry R1): the organisation''s starting templates, shown as "Master · <name>". Site-agnostic, no dataset, never a quantity. Archived, never deleted; lines versioned in master_template_rows.';

CREATE TABLE nzi_console.master_template_rows (
  organisation_id text NOT NULL,
  master_id text NOT NULL,
  rows_version integer NOT NULL CHECK (rows_version > 0),
  row_id text NOT NULL CHECK (btrim(row_id) <> ''),

  scope text NOT NULL CHECK (scope IN ('1', '2', '3')),
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  source_label text NOT NULL CHECK (btrim(source_label) <> ''),
  report_label text CHECK (report_label IS NULL OR btrim(report_label) <> ''),
  -- The activity by its factor's identity — every year's edition of it — never one dataset's row.
  factor_id text,
  unit text CHECK (unit IS NULL OR btrim(unit) <> ''),
  ordering integer NOT NULL CHECK (ordering >= 0),

  PRIMARY KEY (organisation_id, master_id, rows_version, row_id),
  FOREIGN KEY (organisation_id, master_id) REFERENCES nzi_console.master_templates(organisation_id, master_id),
  FOREIGN KEY (organisation_id, factor_id) REFERENCES nzi_console.factor_identities(organisation_id, factor_id),
  -- One vocabulary: a category belongs to one scope, and the line says the same scope.
  CONSTRAINT master_template_rows_category_scope CHECK (split_part(category_code, '.', 1) = scope)
);
CREATE INDEX master_template_rows_version_idx ON nzi_console.master_template_rows (organisation_id, master_id, rows_version, ordering);
COMMENT ON TABLE nzi_console.master_template_rows IS
  'A master template''s lines, one whole version per rows_version (master.template.rows.set). Append-only; scope, category, labels, factor identity and unit — no site, no dataset, no quantity.';

ALTER TABLE nzi_console.master_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.master_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.master_templates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
ALTER TABLE nzi_console.master_template_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.master_template_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.master_template_rows
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

REVOKE ALL ON nzi_console.master_templates FROM PUBLIC;
REVOKE ALL ON nzi_console.master_template_rows FROM PUBLIC;
-- The header: inserted, then renamed, archived, reinstated and pointed at its next lines — its identity never moves.
GRANT SELECT, INSERT ON nzi_console.master_templates TO nzi_console_app;
GRANT UPDATE (name, active, archived_reason, rows_version, version, updated_by, updated_at) ON nzi_console.master_templates TO nzi_console_app;
-- The lines: append-only — a change is the next version, never an edit of the one before it.
GRANT SELECT, INSERT ON nzi_console.master_template_rows TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.master_template_rows FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;
REVOKE DELETE ON nzi_console.master_templates FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

-- ── The three masters, for every organisation ─────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.provision_organisation_master_templates(p_organisation_id text, p_actor text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  added integer;
BEGIN
  INSERT INTO nzi_console.master_templates (organisation_id, master_id, name, created_by, updated_by)
  SELECT p_organisation_id, 'master:' || seed.slug, seed.name, p_actor, p_actor
    FROM (VALUES ('default', 'Default', 1), ('construction', 'Construction', 2), ('office', 'Office', 3)) AS seed(slug, name, ordering)
   WHERE NOT EXISTS (SELECT 1 FROM nzi_console.master_templates m
                      WHERE m.organisation_id = p_organisation_id AND lower(m.name) = lower(seed.name))
   ORDER BY seed.ordering
  ON CONFLICT (organisation_id, master_id) DO NOTHING;
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
    added := nzi_console.provision_organisation_master_templates(org.organisation_id, 'migration:0197');
    RAISE NOTICE '0197 master templates: organisation % · % seeded', org.organisation_id, added;
  END LOOP;
  PERFORM set_config('app.organisation_id', '', true);
END;
$$;

CREATE FUNCTION nzi_console.provision_new_organisation_master_templates() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nzi_console.provision_organisation_master_templates(NEW.organisation_id, 'migration:0197');
  RETURN NEW;
END;
$$;
CREATE TRIGGER provision_master_templates_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation_master_templates();

COMMIT;
