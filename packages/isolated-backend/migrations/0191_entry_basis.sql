-- 0191 Data entry D1: the basis an add-entry drawer opens on — Activity or Spend — admin-set per category and remembered per
-- client (BUILD-dataentry-D1-drawer-toggle-basis, R4).
--
-- ## What is added, and what is not
--
-- - `organisation_entry_basis_defaults` — the Admin setting (R4): for a category, the basis its drawer opens on, for this
--   organisation. **No row is the seed**: PG&S (3.1) = Spend, every other category = Activity (settled 27 Oct), which lives in
--   code (`seededEntryBasis`) beside the taxonomy it is a fact about, not copied here as rows nobody has chosen.
-- - `client_entry_basis_choices` — the client's last choice for a category, which overrides the default for them. Written by the
--   create that carries the drawer's basis, in the same transaction as the row (a choice that was used, not a toggle idly
--   clicked); never by template seeding or the v7 re-ingest, which send none.
-- - **Not a basis column on `job_scope_rows`.** A row's unit already says its basis — a spend entry is recorded in a currency,
--   which no activity is — so the basis is read from the unit everywhere (`entryBasisOfUnit`). A stored copy could disagree with
--   the unit it describes, and every row already written would need a backfill to have one.
--
-- Both are settings, not personal data: tenant-isolated by policy, written by the console only.

BEGIN;

CREATE TABLE nzi_console.organisation_entry_basis_defaults (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  default_basis text NOT NULL CHECK (default_basis IN ('activity', 'spend')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, category_code)
);
COMMENT ON TABLE nzi_console.organisation_entry_basis_defaults IS
  'D1: the basis (activity | spend) a category''s add-entry drawer opens on, set in Admin. No row: the seed — 3.1 spend, the rest activity.';

CREATE TABLE nzi_console.client_entry_basis_choices (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  basis text NOT NULL CHECK (basis IN ('activity', 'spend')),
  chosen_at timestamptz NOT NULL DEFAULT now(),
  chosen_by text NOT NULL,
  PRIMARY KEY (organisation_id, client_id, category_code),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);
COMMENT ON TABLE nzi_console.client_entry_basis_choices IS
  'D1: the basis this client last recorded an entry on, per category — the drawer opens on it, over the Admin default.';

ALTER TABLE nzi_console.organisation_entry_basis_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.organisation_entry_basis_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.organisation_entry_basis_defaults
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

ALTER TABLE nzi_console.client_entry_basis_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_entry_basis_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_entry_basis_choices
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.organisation_entry_basis_defaults, nzi_console.client_entry_basis_choices TO nzi_console_app;
REVOKE DELETE ON nzi_console.organisation_entry_basis_defaults, nzi_console.client_entry_basis_choices FROM nzi_console_app, PUBLIC;

COMMIT;
