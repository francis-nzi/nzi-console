BEGIN;

-- The client logo: an uploaded PNG or SVG held in the isolated (non-production)
-- database — staging storage only; no client asset is ever committed to the repo.
-- It appears on the client record, the portal and published reports, each falling
-- back to the monogram when there is none. Assets are append-only; removing a logo
-- clears the client's pointer and keeps the asset for the audit trail.

CREATE TABLE nzi_console.client_logo_assets (
  organisation_id text NOT NULL,
  asset_id text NOT NULL,
  client_id text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/svg+xml')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 262144),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, asset_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);
CREATE INDEX client_logo_assets_client_idx ON nzi_console.client_logo_assets (organisation_id, client_id);
ALTER TABLE nzi_console.client_logo_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_logo_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_logo_assets
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT ON nzi_console.client_logo_assets TO nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_logo_assets FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

ALTER TABLE nzi_console.clients ADD COLUMN logo_asset_id text;
ALTER TABLE nzi_console.clients
  ADD CONSTRAINT clients_logo_asset_fk FOREIGN KEY (organisation_id, logo_asset_id)
  REFERENCES nzi_console.client_logo_assets (organisation_id, asset_id);

-- A published report shows the logo it was released with: the asset is frozen onto the
-- version at validation (assets are append-only, so it always resolves).
ALTER TABLE nzi_console.report_versions ADD COLUMN client_logo_asset_id text;
ALTER TABLE nzi_console.report_versions
  ADD CONSTRAINT report_versions_logo_asset_fk FOREIGN KEY (organisation_id, client_logo_asset_id)
  REFERENCES nzi_console.client_logo_assets (organisation_id, asset_id);

COMMIT;
