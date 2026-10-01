-- 0147 Job-type templates (admin Phase E3; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q5/E-Q10): which
-- catalogue items a job type starts with.
--
-- ## What it adds
--
-- 1. **`job_type_items`** — one row per (job type, catalogue item): `quantity`, `is_required`, `sort_order`, and
--    `included`. A row is **never deleted** (R3): an item a template drops is kept with `included = false`, so the
--    template's history stays and nothing can cascade into a job — the milestone-template items' pattern (0139). The
--    pair is the row's identity: the role holds no UPDATE on `job_type_id` or `item_id`.
-- 2. **`job_types.items_version`** — the template's own version, apart from the definition's `version`. Editing a
--    type's included items never collides with editing its name or price, and the import that fills templates leaves
--    the definition (and C4's re-run bookkeeping on it) untouched.
--
-- ## The copy-at-creation contract (E-Q5)
--
-- This is the **source** a new job's lines are copied from; the copy itself — `job_line_items`, a snapshot taken when a
-- job is created — is downstream (Quotes / Job commercials). The copy takes the **included** rows, in `sort_order`, with
-- their quantity and required flag, and each item's catalogue values as they stand at that moment. A later edit to the
-- template or the catalogue never reaches a job that already exists. `docs/JOB_TYPE_TEMPLATE_CONTRACT.md` states it for
-- the downstream plan.
--
-- Forced row-level security and the tenant policy; no DELETE for anyone; nothing here is personal data.

BEGIN;

ALTER TABLE nzi_console.job_types ADD COLUMN items_version integer NOT NULL DEFAULT 1 CHECK (items_version > 0);
COMMENT ON COLUMN nzi_console.job_types.items_version IS
  'The included-items template''s own version (admin E3): bumped by job_type.items.set and load:v7-job-type-items, never by a definition edit.';

CREATE TABLE nzi_console.job_type_items (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  job_type_id text NOT NULL,
  item_id text NOT NULL,
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  is_required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 1000000),
  included boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, job_type_id, item_id),
  FOREIGN KEY (organisation_id, job_type_id) REFERENCES nzi_console.job_types (organisation_id, job_type_id),
  FOREIGN KEY (organisation_id, item_id) REFERENCES nzi_console.job_items (organisation_id, item_id),
  CONSTRAINT job_type_items_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX job_type_items_import_identity_key ON nzi_console.job_type_items (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
CREATE INDEX job_type_items_item_idx ON nzi_console.job_type_items (organisation_id, item_id) WHERE included;
COMMENT ON TABLE nzi_console.job_type_items IS
  'Job-type templates (admin E3): the catalogue items a new job of the type starts with — the source of the copy at job creation (E-Q5), never the copy. Dropped items are kept with included = false; never deleted.';

ALTER TABLE nzi_console.job_type_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_type_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_type_items
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.job_type_items FROM PUBLIC;
-- The pair is the identity: inserted once, never updated — no UPDATE on job_type_id or item_id.
GRANT SELECT, INSERT ON nzi_console.job_type_items TO nzi_console_app;
GRANT UPDATE (quantity, is_required, sort_order, included, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.job_type_items TO nzi_console_app;

COMMIT;
