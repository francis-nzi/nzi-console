-- The import's non-PII view set, in the previous system's own database (BRIEF-v7-import-server-side Phase A;
-- NOTE-v7-import-server-side-phase-a, ruled 13 Nov 2026: credential (a), view set A, the sanitisation rule as written).
--
-- NOT a console migration. Apply it to the previous system's Supabase project, the way cc_readonly was set up:
--
--   psql "<that project's postgres URL>" -v ON_ERROR_STOP=1 -f packages/isolated-backend/v7-source/v7_import_views.sql
--   then, once, by hand (the password never lives in this file or the repository):
--   ALTER ROLE cc_import_view PASSWORD '<generated>';
--
-- Idempotent: every run drops and re-creates the schema's views and functions inside one transaction, re-applies the grants,
-- and checks them. The console reads it as cc_import_view through NZI_V7_VIEW_URL (src/v7ImportView.ts), which refuses to
-- read if any view's columns differ from V7_IMPORT_VIEW_CONTRACT.
--
-- What crosses: ids, codes, numbers, dates, booleans and labels put through the rule below. Never a client name, a contact,
-- a site name or address, a row's notes (they carry employee names on consolidated commuting rows), a spend description, a
-- source's free text, a report, or anything else. The views run with their owner's rights; cc_import_view holds SELECT on
-- them and EXECUTE on the two label functions, and nothing else — checked at the end of this script.
--
-- Scope: decision 8, as the extract's prelude has it — the jobs of Active / Portfolio Owner clients that are not archived.

\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';
BEGIN;

-- ── The role: view-only, no inheritance, no membership, a login for the console's one connection ──
-- (Superuser, replication and RLS bypass are off by default; they are asserted at the end, not set — Supabase's postgres may
-- not alter them.)
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_import_view') THEN
    CREATE ROLE cc_import_view LOGIN NOINHERIT;
  END IF;
END $role$;
ALTER ROLE cc_import_view NOINHERIT NOCREATEDB NOCREATEROLE;
ALTER ROLE cc_import_view SET default_transaction_read_only = on;
ALTER ROLE cc_import_view SET statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS v7_import;
REVOKE ALL ON SCHEMA v7_import FROM PUBLIC;

DROP VIEW IF EXISTS v7_import.scope_rows, v7_import.emission_sources, v7_import.emission_groups, v7_import.spend_entries,
  v7_import.crp_job_details, v7_import.jobs, v7_import.job_types, v7_import.sites, v7_import.clients, v7_import.datasets,
  v7_import.factor_labels CASCADE;

-- ── The label rule (mirrored in src/v7ImportLabel.ts; the shared-fixture test requires identical output) ──

-- Belt and braces: each pattern verbatim from V7_IMPORT_LABEL_PII_PATTERNS (`~*` where the TypeScript says insensitive).
CREATE OR REPLACE FUNCTION v7_import.label_has_pii(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT value IS NOT NULL AND (
       value ~  '[^\s@]+@[^\s@]+\.[A-Za-z]{2,}'
    OR value ~* '(^|[^A-Za-z0-9])[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}($|[^A-Za-z0-9])'
    OR value ~  '(^|[^A-Za-z0-9])[A-Z]{2}[0-9]{2} ?[A-Z]{3}($|[^A-Za-z0-9])'
    OR value ~  '(^|[^A-Za-z0-9])[A-Z][0-9]{1,3} ?[A-Z]{3}($|[^A-Za-z0-9])'
    OR value ~  '(^|[^A-Za-z0-9])[A-Z]{3} ?[0-9]{1,3}[A-Z]($|[^A-Za-z0-9])'
    OR value ~  '[0-9]{6,}'
    OR value ~  '[0-9]{2}-[0-9]{2}-[0-9]{2}'
    OR value ~  '(^|[^0-9])(\+44 ?|0)[0-9]{2,4} ?[0-9]{3,4} ?[0-9]{3,4}'
    OR value ~  '(^|[^A-Za-z])(Mr|Mrs|Ms|Miss|Mx|Dr)\.? +[A-Z][a-z]+')
$fn$;

-- allow-listed and clean → kept; person-linked → the factor's own text; else `<base> — site <id>`; else `<base>`.
CREATE OR REPLACE FUNCTION v7_import.sanitise_label(value text, allowed boolean, person_linked boolean, factor_label text, base text, site_id text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN value IS NULL OR btrim(value) = '' THEN value
    WHEN allowed AND NOT v7_import.label_has_pii(value) THEN value
    WHEN person_linked AND factor_label IS NOT NULL AND NOT v7_import.label_has_pii(factor_label) THEN factor_label
    WHEN site_id IS NOT NULL AND NOT v7_import.label_has_pii(base || ' — site ' || site_id) THEN base || ' — site ' || site_id
    ELSE base
  END
$fn$;

-- The allow-list: every factor's taxonomy text, and the system's fixed labels (V7_IMPORT_LABEL_DEFAULTS).
CREATE VIEW v7_import.factor_labels AS
  SELECT DISTINCT btrim(t.label) AS label
  FROM public.factor_lookup fl
  CROSS JOIN LATERAL (VALUES (fl.level_1), (fl.level_2), (fl.level_3), (fl.column_text)) AS t(label)
  WHERE t.label IS NOT NULL AND btrim(t.label) <> ''
  UNION
  SELECT label FROM (VALUES ('Employee Commuting'), ('Imported Totals'), ('Business travel'), ('Asset register'), ('Uncategorised'),
    ('Scope 1'), ('Scope 2'), ('Scope 3')) AS d(label);

-- ── Decision 8's clients and jobs (the extract's prelude) ──
CREATE VIEW v7_import.clients AS
  SELECT c.db_id, c.status, c.archived
  FROM public.clients c
  WHERE COALESCE(c.status, 'Active') IN ('Active', 'Portfolio Owner') AND NOT COALESCE(c.archived, false);

CREATE VIEW v7_import.jobs AS
  SELECT j.job_id, j.client_db_id, j.job_number, j.status, j.archived, j.job_type_id, j.job_type, j.reporting_year,
    j.reporting_period_start, j.reporting_period_end
  FROM public.jobs j
  WHERE j.client_db_id IN (SELECT db_id FROM v7_import.clients);

CREATE VIEW v7_import.job_types AS
  SELECT t.job_type_id, t.name, t.job_family, t.job_group, t.is_crp FROM public.job_types t;

CREATE VIEW v7_import.crp_job_details AS
  SELECT d.job_id, d.reporting_period_from, d.reporting_period_to
  FROM public.crp_job_details d WHERE d.job_id IN (SELECT job_id FROM v7_import.jobs);

-- A site is its id and its client: never its name, address or coordinates.
CREATE VIEW v7_import.sites AS
  SELECT s.site_id, s.client_db_id, s.is_registered_office, s.vacated_date, s.archived
  FROM public.client_sites s WHERE s.client_db_id IN (SELECT db_id FROM v7_import.clients);

CREATE VIEW v7_import.datasets AS
  SELECT d.dataset_id, d.year, d.version FROM public.datasets d;

-- ── Scope rows: the planner's inputs, labels through the rule, notes reduced to its two tokens ──
CREATE VIEW v7_import.scope_rows AS
  SELECT r.row_id, r.job_id, r.scope, r.original_id, r.qty, r.uom, r.factor, r.ghg_unit, r.enabled, r.site_id, r.dataset_id, r.factor_db_id,
    v7_import.sanitise_label(r.category, btrim(r.category) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS category,
    v7_import.sanitise_label(r.level_1, btrim(r.level_1) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS level_1,
    v7_import.sanitise_label(r.level_2, btrim(r.level_2) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS level_2,
    v7_import.sanitise_label(r.level_3, btrim(r.level_3) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS level_3,
    v7_import.sanitise_label(r.level_4, btrim(r.level_4) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS level_4,
    v7_import.sanitise_label(r.column_text, btrim(r.column_text) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS column_text,
    v7_import.sanitise_label(r.report_label, btrim(r.report_label) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, r.site_id::text) AS report_label,
    -- The only two things the import reads from notes (v7EmissionsFormula.ts): the tokens, never the text around them.
    substring(r.notes FROM '(?i)(?:^|[;( ])factor_original_id=([^;)\s]+)') AS factor_original_id,
    substring(r.notes FROM '(?i)(?:^|[;( ])storage_reason=([^;)\s]+)') AS storage_reason,
    r.apply_pct, r.month_1, r.month_2, r.month_3, r.month_4, r.month_5, r.month_6, r.month_7, r.month_8, r.month_9, r.month_10, r.month_11, r.month_12,
    r.calc_tco2e, r.override_tco2e,
    -- A source the import knows, as it is; anything else as one fixed word (the import carries it as "Other" either way).
    CASE WHEN r.data_source IS NULL OR btrim(r.data_source) = '' THEN r.data_source
      WHEN btrim(r.data_source) IN ('Company Data', 'Spend Data', 'WFM Import', 'Legacy Annual Upload', 'Previous Year Import',
        'Employee Commuting Template', 'Employee Commuting Direct Entry', 'Employee Commuting (Consolidated)', 'Source Register',
        'Asset Register', 'Business Travel Register', 'Client Portal', 'Previous Year', 'Business Travel Data', 'Custom Dataset',
        'Asset Register (Consolidated)', 'Business Travel Register (Consolidated)') THEN r.data_source
      ELSE 'Unlisted' END AS data_source,
    r.data_confidence, r.is_custom_entry, r.linked_row_id, r.is_auto_generated, r.auto_pair_kind, r.review_status,
    -- The extract's factor-lookup reference (v7-extract-sql.mjs REFERENCE_JOIN), verbatim.
    CASE WHEN ref1.factor IS NOT NULL THEN ref1.factor ELSE ref2.factor END AS reference_factor,
    CASE WHEN ref1.factor IS NOT NULL THEN NULLIF(trim(ref1.ghg_unit), '')
      ELSE COALESCE(NULLIF(trim(ref2.ghg_unit), ''), NULLIF(trim(ref1.ghg_unit), '')) END AS reference_ghg_unit,
    c.person_linked AS label_person_linked, c.factor_label AS label_factor, c.base AS label_base
  FROM public.job_scope_rows r
  LEFT JOIN LATERAL (SELECT fl.factor, fl.ghg_unit FROM public.factor_lookup fl WHERE r.dataset_id IS NOT NULL AND fl.dataset_id = r.dataset_id
    AND fl.original_id = substring(r.notes FROM '(?i)(?:^|[;( ])factor_original_id=([^;)\s]+)') AND (trim(r.scope) = '' OR fl.scope = trim(r.scope))
    ORDER BY CASE WHEN fl.scope = trim(r.scope) THEN 0 ELSE 1 END, fl.db_id LIMIT 1) ref1 ON true
  LEFT JOIN LATERAL (SELECT fl.factor, fl.ghg_unit FROM public.factor_lookup fl LEFT JOIN public.datasets d ON d.dataset_id = fl.dataset_id
    WHERE trim(COALESCE(r.original_id, '')) <> '' AND fl.original_id = trim(r.original_id) ORDER BY COALESCE(d.year, 0) DESC, fl.db_id DESC LIMIT 1) ref2 ON true
  LEFT JOIN LATERAL (SELECT COALESCE(NULLIF(btrim(f.column_text), ''), NULLIF(btrim(f.level_3), ''), NULLIF(btrim(f.level_2), ''), NULLIF(btrim(f.level_1), '')) AS label
    FROM public.factor_lookup f WHERE f.db_id::text = r.factor_db_id::text ORDER BY f.db_id LIMIT 1) own ON true
  CROSS JOIN LATERAL (SELECT
    concat_ws(' ', r.data_source, r.auto_pair_kind, r.category, r.level_1, r.level_2) ~* '(commut|home ?working|gr[ae]y ?fleet)' AS person_linked,
    CASE WHEN own.label IS NOT NULL AND btrim(own.label) IN (SELECT label FROM v7_import.factor_labels) AND NOT v7_import.label_has_pii(own.label) THEN own.label END AS factor_label,
    CASE WHEN btrim(r.category) IN (SELECT label FROM v7_import.factor_labels) AND NOT v7_import.label_has_pii(r.category) THEN btrim(r.category)
      WHEN btrim(r.level_1) IN (SELECT label FROM v7_import.factor_labels) AND NOT v7_import.label_has_pii(r.level_1) THEN btrim(r.level_1)
      WHEN substring(r.scope FROM '[123]') IS NOT NULL THEN 'Scope ' || substring(r.scope FROM '[123]')
      ELSE 'Uncategorised' END AS base) c
  WHERE r.job_id IN (SELECT job_id FROM v7_import.jobs);

CREATE VIEW v7_import.emission_groups AS
  SELECT g.group_id, g.job_id, g.dataset_id, g.factor_db_id, g.original_id, g.factor, g.ghg_unit, g.uom, g.enabled
  FROM public.job_emission_groups g WHERE g.job_id IN (SELECT job_id FROM v7_import.jobs);

-- Register sources: codes and figures; the category (a register row's label) through the rule. No name, no free text.
CREATE VIEW v7_import.emission_sources AS
  SELECT s.source_id, s.job_id, s.scope, s.source_type, s.enabled, s.group_id, s.source_subtype, s.site_id,
    v7_import.sanitise_label(s.category, btrim(s.category) IN (SELECT label FROM v7_import.factor_labels), c.person_linked, c.factor_label, c.base, s.site_id::text) AS category,
    s.dataset_id, s.factor_db_id, s.original_id, s.qty, s.uom, s.factor, s.ghg_unit, s.apply_pct, s.calc_tco2e,
    CASE WHEN s.data_source IS NULL OR btrim(s.data_source) = '' THEN s.data_source
      WHEN btrim(s.data_source) IN ('Company Data', 'Spend Data', 'WFM Import', 'Legacy Annual Upload', 'Previous Year Import',
        'Employee Commuting Template', 'Employee Commuting Direct Entry', 'Employee Commuting (Consolidated)', 'Source Register',
        'Asset Register', 'Business Travel Register', 'Client Portal', 'Previous Year', 'Business Travel Data', 'Custom Dataset',
        'Asset Register (Consolidated)', 'Business Travel Register (Consolidated)') THEN s.data_source
      ELSE 'Unlisted' END AS data_source,
    s.data_confidence, s.review_status,
    c.person_linked AS label_person_linked, c.factor_label AS label_factor, c.base AS label_base
  FROM public.job_emission_sources s
  LEFT JOIN LATERAL (SELECT COALESCE(NULLIF(btrim(f.column_text), ''), NULLIF(btrim(f.level_3), ''), NULLIF(btrim(f.level_2), ''), NULLIF(btrim(f.level_1), '')) AS label
    FROM public.factor_lookup f WHERE f.db_id::text = s.factor_db_id::text ORDER BY f.db_id LIMIT 1) own ON true
  CROSS JOIN LATERAL (SELECT
    concat_ws(' ', s.source_type, s.source_subtype, s.data_source, s.category) ~* '(commut|home ?working|gr[ae]y ?fleet)' AS person_linked,
    CASE WHEN own.label IS NOT NULL AND btrim(own.label) IN (SELECT label FROM v7_import.factor_labels) AND NOT v7_import.label_has_pii(own.label) THEN own.label END AS factor_label,
    CASE WHEN substring(s.scope FROM '[123]') IS NOT NULL THEN 'Scope ' || substring(s.scope FROM '[123]') ELSE 'Uncategorised' END AS base) c
  WHERE s.job_id IN (SELECT job_id FROM v7_import.jobs);

-- Spend entries: the evidence behind the spend-data rows — ids, amounts, currencies. Never a description.
CREATE VIEW v7_import.spend_entries AS
  SELECT e.entry_id, e.job_id, e.amount_gross, e.is_deleted, e.site_id, e.factor_db_id, e.factor_original_id, e.mapped_scope,
    e.conversion_currency, e.currency, e.submitted_by_portal, e.review_status, e.estimated_emissions_tco2e
  FROM public.job_spend_entries e WHERE e.job_id IN (SELECT job_id FROM v7_import.jobs);

-- ── Grants: SELECT on the views and EXECUTE on the two functions (a view's caller needs it), nothing else ──
REVOKE ALL ON ALL TABLES IN SCHEMA v7_import FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA v7_import FROM PUBLIC;
GRANT USAGE ON SCHEMA v7_import TO cc_import_view;
GRANT SELECT ON v7_import.factor_labels, v7_import.clients, v7_import.jobs, v7_import.job_types, v7_import.crp_job_details,
  v7_import.sites, v7_import.datasets, v7_import.scope_rows, v7_import.emission_groups, v7_import.emission_sources,
  v7_import.spend_entries TO cc_import_view;
GRANT EXECUTE ON FUNCTION v7_import.label_has_pii(text), v7_import.sanitise_label(text, boolean, boolean, text, text, text) TO cc_import_view;

-- ── The check: cc_import_view reads the view set and nothing else, and belongs to no role ──
DO $check$
DECLARE stray integer; columns integer; member integer; other integer; powerful integer;
BEGIN
  -- From the catalogues, whoever granted it: any table-level or column-level grant to the role outside the view set.
  SELECT count(*) INTO stray FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'v7_import' AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'cc_import_view'::regrole);
  SELECT count(*) INTO columns FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'v7_import' AND EXISTS (SELECT 1 FROM aclexplode(t.attacl) a WHERE a.grantee = 'cc_import_view'::regrole);
  SELECT count(*) INTO member FROM pg_auth_members m WHERE m.member = 'cc_import_view'::regrole;
  SELECT count(*) INTO other FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE n.nspname = 'v7_import' AND a.grantee = 'cc_import_view'::regrole AND a.privilege_type <> 'SELECT';
  SELECT count(*) INTO powerful FROM pg_roles WHERE rolname = 'cc_import_view'
    AND (rolsuper OR rolbypassrls OR rolreplication OR rolcreaterole OR rolcreatedb OR rolinherit);
  IF stray + columns + member + other + powerful > 0 THEN
    RAISE EXCEPTION 'cc_import_view must read the view set only: % table and % column grant(s) outside v7_import, % role membership(s), % non-SELECT privilege(s) on it, % elevated attribute(s). Nothing was applied.',
      stray, columns, member, other, powerful;
  END IF;
END $check$;

COMMIT;
