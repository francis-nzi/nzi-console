-- 0139 Jobs configuration (admin Phase C; ruled plan `admin-phaseC-plan.md`, Q1–Q12): all of the phase's schema.
--
-- ## What it adds
--
-- 1. **`vat_rates`** (Q1) — a typed rate per organisation, one default. In Phase C it is a read-only picker, filled by
--    the import (C4); its editing screen and currencies arrive in Phase E.
-- 2. **`job_types`** (R2: typed, its own table) — the services the firm sells: name, optional console code (Q3), one
--    family (Q3: v7's `is_crp` / `job_group` are kept in `legacy_values` only), description, default price ex VAT,
--    estimated hours, a VAT rate, and the milestone template a new job of the type starts from (Q8 — the design's
--    single link direction). A type's name is unique per organisation, case-insensitive, inactive rows included (Q2),
--    so reinstating never collides.
-- 3. **`milestone_templates` + `milestone_template_items`** — a template names up to three items, one per
--    `job_milestones` kind (R12), each with its own label and day offset. **Exactly one default per organisation**
--    (Q6), and the default cannot be deactivated. Items are never deleted: a kind a template drops is kept with
--    `included = false`, so an item's history stays, and nothing can cascade into a job (v7's item edit deleted and
--    re-inserted items, wiping every job's ticks). Jobs copy dates into `job_milestones` (PR 3); a template edit never
--    reaches an existing job.
-- 4. **`job_file_types`** (Q9) — the job file-type vocabulary and its storage mapping, built now and inert: the
--    console has no job-file store yet. The key is **immutable by construction** — the application role may insert
--    it but holds no UPDATE on it — and a system type is **protected by construction**: the role cannot insert or set
--    `is_system`, and a system type cannot be inactive. v7's two core types are provisioned here for
--    `net-zero-international`.
-- 5. **`jobs.job_type_id` and `jobs.milestone_template_id`** — a job's type and the template its milestones come
--    from. Both nullable: the imported jobs are linked by `load:v7-job-links` (C5), new jobs by `job.create` (PR 3).
--    Neither is in the client loader's compare set, so its re-run stays "already loaded and identical".
--
-- ## Throughout
--
-- Every table is per organisation (R1): forced row-level security, the tenant policy, no DELETE for anyone (R3 —
-- deactivate, never delete), `version` and who-and-when. Each carries 0132's import provenance (`source_system`,
-- `legacy_db_id`, `legacy_values` — what a row was last loaded as, so a re-run tells "v7 changed" from "edited here",
-- R4) with a unique import identity. None holds personal data.

BEGIN;

-- ── VAT rates (Q1) ──────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.vat_rates (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  vat_rate_id text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  rate_pct numeric(5,2) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, vat_rate_id),
  CONSTRAINT vat_rates_default_is_active CHECK (NOT (is_default AND NOT active)),
  CONSTRAINT vat_rates_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX vat_rates_one_default ON nzi_console.vat_rates (organisation_id) WHERE is_default;
CREATE UNIQUE INDEX vat_rates_name_key ON nzi_console.vat_rates (organisation_id, lower(name));
CREATE UNIQUE INDEX vat_rates_import_identity_key ON nzi_console.vat_rates (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.vat_rates IS
  'VAT rates per organisation, one default (Q1). A read-only picker in Phase C, filled by load:v7-jobs-config; edited from Phase E.';

-- ── Milestone templates (R12, Q6) ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.milestone_templates (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  template_id text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, template_id),
  -- The default is the template a job falls back to; it cannot be switched off (Q6).
  CONSTRAINT milestone_templates_default_is_active CHECK (NOT (is_default AND NOT active)),
  CONSTRAINT milestone_templates_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX milestone_templates_one_default ON nzi_console.milestone_templates (organisation_id) WHERE is_default;
CREATE UNIQUE INDEX milestone_templates_name_key ON nzi_console.milestone_templates (organisation_id, lower(name));
CREATE UNIQUE INDEX milestone_templates_import_identity_key ON nzi_console.milestone_templates (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.milestone_templates IS
  'Default delivery schedules a new job''s milestones are generated from (PR 3). Exactly one default per organisation, which cannot be deactivated (Q6).';

CREATE TABLE nzi_console.milestone_template_items (
  organisation_id text NOT NULL,
  template_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('data_collection', 'first_draft', 'final_report')),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 120),
  days_offset integer NOT NULL CHECK (days_offset >= 0 AND days_offset <= 3650),
  -- A kind the template no longer schedules is kept, not deleted (R3), so its history and audit stay intact.
  included boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  -- One item per kind: the three kinds are the Risk rule's milestones, not v7's "first three by sort order".
  PRIMARY KEY (organisation_id, template_id, kind),
  FOREIGN KEY (organisation_id, template_id) REFERENCES nzi_console.milestone_templates (organisation_id, template_id),
  CONSTRAINT milestone_template_items_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX milestone_template_items_import_identity_key ON nzi_console.milestone_template_items (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON COLUMN nzi_console.milestone_template_items.days_offset IS
  'Days after the job''s anchor (the later of its start date and reporting-period start — v7''s rule) that this milestone falls due.';

-- ── Job types (R2, Q2–Q4, Q8) ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.job_types (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  job_type_id text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  code text CHECK (code IS NULL OR (btrim(code) <> '' AND length(code) <= 32)),
  family text NOT NULL CHECK (family IN ('crp', 'consultancy', 'lca', 'pcf', 'training')),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  default_price_ex_vat numeric(12,2) CHECK (default_price_ex_vat IS NULL OR default_price_ex_vat >= 0),
  estimated_hours numeric(8,2) CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  vat_rate_id text,
  milestone_template_id text,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, job_type_id),
  FOREIGN KEY (organisation_id, vat_rate_id) REFERENCES nzi_console.vat_rates (organisation_id, vat_rate_id),
  FOREIGN KEY (organisation_id, milestone_template_id) REFERENCES nzi_console.milestone_templates (organisation_id, template_id),
  CONSTRAINT job_types_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
-- Q2: unique per organisation, case-insensitive, inactive rows included — a reinstate never collides.
CREATE UNIQUE INDEX job_types_name_key ON nzi_console.job_types (organisation_id, lower(name));
CREATE UNIQUE INDEX job_types_code_key ON nzi_console.job_types (organisation_id, lower(code)) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX job_types_import_identity_key ON nzi_console.job_types (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
CREATE INDEX job_types_vat_rate_idx ON nzi_console.job_types (organisation_id, vat_rate_id) WHERE vat_rate_id IS NOT NULL;
CREATE INDEX job_types_template_idx ON nzi_console.job_types (organisation_id, milestone_template_id) WHERE milestone_template_id IS NOT NULL;
COMMENT ON TABLE nzi_console.job_types IS
  'The services the firm sells (admin C1): one family, default price ex VAT (the organisation''s base currency), estimated hours, VAT rate, and the milestone template a new job of the type starts from.';
COMMENT ON COLUMN nzi_console.job_types.family IS
  'The job family a job of this type has. Locked while any job uses the type (Q4), because a job carries its family.';
COMMENT ON COLUMN nzi_console.job_types.legacy_values IS
  'What v7 held when this type was last loaded — including is_crp and job_group, which are not columns here (Q3).';

-- ── Job file types (Q9) ─────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.job_file_types (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  file_type_id text NOT NULL,
  file_type_key text NOT NULL CHECK (file_type_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 120),
  storage_folder_key text NOT NULL CHECK (storage_folder_key ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 1000000),
  active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, file_type_id),
  -- A system type is always available (v7's core keys could never be archived).
  CONSTRAINT job_file_types_system_is_active CHECK (NOT (is_system AND NOT active)),
  CONSTRAINT job_file_types_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX job_file_types_key ON nzi_console.job_file_types (organisation_id, file_type_key);
CREATE UNIQUE INDEX job_file_types_name_key ON nzi_console.job_file_types (organisation_id, lower(display_name));
CREATE UNIQUE INDEX job_file_types_import_identity_key ON nzi_console.job_file_types (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.job_file_types IS
  'The job file-type vocabulary and its storage folder (Q9). Inert until the console has a job-file store. The key never changes once made; a system type is always active.';

-- v7's two core types (`_JOB_FILE_TYPE_CORE_KEYS`), for the organisation the v7 import loads into. The import (C4)
-- stamps them with their v7 identity by key; it never duplicates them.
INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, sort_order, is_system, created_by, updated_by)
SELECT o.organisation_id, v.id, v.key, v.name, v.folder, v.sort, true, 'migration:0139', 'migration:0139'
  FROM nzi_console.organisations o
  CROSS JOIN (VALUES
    ('file-type:client_provided', 'client_provided', 'Client Provided (Evidence)', 'client-provided', 10),
    ('file-type:generated_report', 'generated_report', 'Generated Report', 'generated-reports', 20)) AS v(id, key, name, folder, sort)
 WHERE o.organisation_id = 'net-zero-international';

-- ── On jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.jobs
  ADD COLUMN job_type_id text,
  ADD COLUMN milestone_template_id text,
  ADD CONSTRAINT jobs_job_type_fk
    FOREIGN KEY (organisation_id, job_type_id) REFERENCES nzi_console.job_types (organisation_id, job_type_id),
  ADD CONSTRAINT jobs_milestone_template_fk
    FOREIGN KEY (organisation_id, milestone_template_id) REFERENCES nzi_console.milestone_templates (organisation_id, template_id);
CREATE INDEX jobs_job_type_idx ON nzi_console.jobs (organisation_id, job_type_id) WHERE job_type_id IS NOT NULL;
CREATE INDEX jobs_milestone_template_idx ON nzi_console.jobs (organisation_id, milestone_template_id) WHERE milestone_template_id IS NOT NULL;

-- ── Tenancy and grants: forced RLS everywhere; no DELETE for anyone (R3) ────────────────────────────────────────

ALTER TABLE nzi_console.vat_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.vat_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.vat_rates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.vat_rates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.vat_rates TO nzi_console_app;

ALTER TABLE nzi_console.milestone_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.milestone_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.milestone_templates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.milestone_templates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.milestone_templates TO nzi_console_app;

ALTER TABLE nzi_console.milestone_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.milestone_template_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.milestone_template_items
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.milestone_template_items FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.milestone_template_items TO nzi_console_app;

ALTER TABLE nzi_console.job_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_types
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.job_types FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_types TO nzi_console_app;

ALTER TABLE nzi_console.job_file_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_file_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_file_types
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.job_file_types FROM PUBLIC;
-- By construction (Q9): the role may add a type but never make it a system type, and may edit a type but never its key.
GRANT SELECT ON nzi_console.job_file_types TO nzi_console_app;
GRANT INSERT (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, sort_order, active,
              source_system, legacy_db_id, legacy_values, created_by, updated_by)
  ON nzi_console.job_file_types TO nzi_console_app;
GRANT UPDATE (display_name, storage_folder_key, sort_order, active, source_system, legacy_db_id, legacy_values,
              version, updated_at, updated_by)
  ON nzi_console.job_file_types TO nzi_console_app;

COMMIT;
