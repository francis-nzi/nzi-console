BEGIN;

-- B4 — remembered CSV column mapping per client (NZC-036, decision D4). One map
-- per client per import kind (spend now; commuting / vehicle later), so a client
-- who sends the same export layout every year maps their columns once.
CREATE TABLE nzi_console.client_import_mappings (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  import_kind text NOT NULL CHECK (import_kind IN ('spend')),
  mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mapping_json) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, client_id, import_kind),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE
);

ALTER TABLE nzi_console.client_import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_import_mappings
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.client_import_mappings TO nzi_console_app;

COMMENT ON TABLE nzi_console.client_import_mappings IS
  'Per-client remembered column map for the bulk import column-mapper (NZC-036 B4). mapping_json is {canonicalField: headerText}.';

COMMIT;
