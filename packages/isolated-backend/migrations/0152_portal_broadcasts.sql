-- 0152 Portal broadcasts (admin Phase F4; ruled `phaseF-comms-crm-plan.md` §F4 and F-Q6, settled by `F4-RULINGS.md`
-- R1–R7): the notices staff write for the client portal — to every portal client, or to one.
--
-- ## What it adds
--
-- **`portal_broadcasts`**, per organisation, its own table (R2's typed shape):
--
-- - `title` and `body`, both required (R6); `style` ∈ {info, warning, success, promo}, default info (R2).
-- - A **link**, both or neither (R3): `link_url` is an `https://` address or one of the console's own paths (`/…`, never
--   `//…`) — no other scheme, held here as well as by the command, because this is a client-facing surface — and
--   `link_label` beside it.
-- - A **window** (R4): `starts_at` required; `ends_at` optional (null = until deactivated), after the start when present.
--   Instants (`timestamptz`); the screen enters them on the platform's London clock. **Live** = active and
--   `starts_at <= now < ends_at`.
-- - An optional **target client** (`target_client_id`; null = every portal client): a foreign key enforced only when set,
--   **no cascade** (R7) — clients are never deleted here, so a targeted broadcast always keeps its target.
-- - `active`, `version`, 0132 provenance. **No v7 import** (R1): v7 had no live or future broadcast to carry (counted 0).
--
-- Forced row-level security and the tenant policy; no DELETE for anyone (R7). Every part is editable — no set-once
-- column beyond the id.

BEGIN;

CREATE TABLE nzi_console.portal_broadcasts (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  broadcast_id text NOT NULL,
  title text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
  body text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 2000),
  style text NOT NULL DEFAULT 'info' CHECK (style IN ('info', 'warning', 'success', 'promo')),
  link_url text CHECK (link_url IS NULL OR (length(link_url) <= 500 AND (link_url ~ '^https://[^[:space:]\\]+$' OR link_url ~ '^/([^/[:space:]\\][^[:space:]\\]*)?$'))),
  link_label text CHECK (link_label IS NULL OR (btrim(link_label) <> '' AND length(link_label) <= 80)),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  target_client_id text,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, broadcast_id),
  -- Enforced only when set (MATCH SIMPLE); no cascade.
  FOREIGN KEY (organisation_id, target_client_id) REFERENCES nzi_console.clients (organisation_id, client_id),
  CONSTRAINT portal_broadcasts_link_both_or_neither CHECK ((link_url IS NULL) = (link_label IS NULL)),
  CONSTRAINT portal_broadcasts_window CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT portal_broadcasts_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
-- What the portal read asks: an organisation's active broadcasts by start.
CREATE INDEX portal_broadcasts_live_idx ON nzi_console.portal_broadcasts (organisation_id, starts_at) WHERE active;
CREATE INDEX portal_broadcasts_target_idx ON nzi_console.portal_broadcasts (organisation_id, target_client_id) WHERE target_client_id IS NOT NULL;
COMMENT ON TABLE nzi_console.portal_broadcasts IS
  'Portal broadcasts (admin F4): staff-written notices to every portal client or one; a style, an allow-listed link, a window (live = active and starts_at <= now < ends_at). Never deleted.';

ALTER TABLE nzi_console.portal_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.portal_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.portal_broadcasts
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.portal_broadcasts FROM PUBLIC;
GRANT SELECT, INSERT ON nzi_console.portal_broadcasts TO nzi_console_app;
GRANT UPDATE (title, body, style, link_url, link_label, starts_at, ends_at, target_client_id, active, source_system, legacy_db_id, legacy_values,
  version, updated_at, updated_by) ON nzi_console.portal_broadcasts TO nzi_console_app;

COMMIT;
