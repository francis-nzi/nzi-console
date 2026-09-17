-- 0089 Reference data / lookups foundation (NZC-089).
--
-- The rebuild has no lookups; the live system holds a mature curated set, and the client and job
-- smart-searches resolve against it. This is that subsystem — the foundation Parts 1 and 2 of the
-- redesign depend on.
--
-- ## One table, not eighteen
--
-- Eighteen categories are coming (Job Types, Statuses, VAT Rates, Payment Terms, Positions,
-- Processes, Job Item Categories, Job File Types, UoM, Action Categories, Governance Subjects,
-- BD Bin Reasons, Time Subjects, Portfolios, Industries, Referrals, Client Teams, Currencies).
-- A table each would mean eighteen migrations, eighteen read models and eighteen admin screens
-- that differ only in their labels — and the nineteenth category would need all of it again.
--
-- So a category is a row, and its values are rows. Adding "Payment Terms" later is an INSERT, not
-- a migration. What the categories genuinely do not share — the SIC code an industry carries — is
-- a nullable column, because one optional column is cheaper than a jsonb blob nobody can index or
-- constrain.
--
-- ## Scope is who curates, not where it lives
--
-- The brief distinguishes shared standards (Industries, Currencies, UoM) from firm config (Job
-- Types, Referrals, Portfolios). That distinction is recorded on the category and governs who may
-- edit it and how it is seeded. **Storage stays organisation-partitioned for every category**,
-- because the alternative is a second RLS shape — a nullable organisation_id with a policy that
-- must special-case it — and an organisation-scoped row that some policy lets another tenant read
-- is precisely the failure the whole isolation model exists to prevent. Shared categories are
-- provisioned into each organisation the same way levers and the SRS framework already are.
--
-- ## Archive is deactivation
--
-- The live admin's "Archive" is `active = false`. A value that a client record points at must stay
-- explicable after it stops being offered, so DELETE is revoked. An archived industry still renders
-- on the client that chose it; it simply stops appearing in the search.

SET search_path = nzi_console;

BEGIN;

-- The catalogue of categories. Shared across organisations by nature: every tenant has the same
-- *kinds* of reference data even when the values differ.
CREATE TABLE nzi_console.reference_categories (
  category_key text PRIMARY KEY,
  label text NOT NULL,
  -- `shared` — a universal standard, seeded centrally and the same everywhere it is provisioned.
  -- `organisation` — firm configuration, curated by the firm itself.
  scope text NOT NULL CHECK (scope IN ('shared', 'organisation')),
  description text NOT NULL DEFAULT '',
  -- Whether a value in this category carries a code alongside its label (Industries → SIC,
  -- Currencies → ISO 4217). Declared so a form knows whether to offer the code, rather than
  -- inferring it from whether the column happens to be populated.
  carries_code boolean NOT NULL DEFAULT false,
  code_label text,
  active boolean NOT NULL DEFAULT true,
  CHECK (carries_code = false OR code_label IS NOT NULL)
);

CREATE TABLE nzi_console.reference_values (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  category_key text NOT NULL REFERENCES nzi_console.reference_categories(category_key),
  value_id text NOT NULL,
  label text NOT NULL CHECK (btrim(label) <> ''),
  -- SIC for an industry; null for a category that carries no code.
  code text,
  sort_order integer NOT NULL DEFAULT 0,
  -- Archive, never delete.
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Provenance: where this value came from, so an imported value and a hand-added one are
  -- distinguishable without reading the audit trail.
  source text NOT NULL DEFAULT 'import' CHECK (source IN ('import', 'admin')),
  -- The identity the live export gave it, kept so a re-import reconciles onto the same row
  -- rather than creating a second one. Null for values added here.
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, category_key, value_id)
);

-- Two values in one category must not share a label: a smart-search that offers the same words
-- twice cannot be chosen from. Case-insensitive, and scoped to the live ones — an archived
-- "Manufacturing" must not block a new one.
CREATE UNIQUE INDEX reference_values_label_once_active_idx
  ON nzi_console.reference_values (organisation_id, category_key, lower(btrim(label)))
  WHERE active;

-- The import's reconcile key. A live export row maps to exactly one value.
CREATE UNIQUE INDEX reference_values_source_ref_idx
  ON nzi_console.reference_values (organisation_id, category_key, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX reference_values_lookup_idx
  ON nzi_console.reference_values (organisation_id, category_key, active, sort_order);

-- The first slice's three categories. The rest are INSERTs, not migrations.
INSERT INTO nzi_console.reference_categories (category_key, label, scope, description, carries_code, code_label) VALUES
  ('industries', 'Industries', 'shared', 'The client''s industry, carried forward from the live admin and enriched with its SIC code.', true, 'SIC code'),
  ('referrals', 'Referrals', 'organisation', 'How a client came to NZI. Firm configuration, curated by the firm.', false, NULL);

-- ── Team roster ─────────────────────────────────────────────────────────────────────────────
--
-- The owner and client-manager smart-searches resolve to people, and staff had no name to resolve
-- to: `memberships` carries user_id, role_id and status, and nothing else. Portal users have had a
-- display_name since 0018; staff never did, because nothing had needed one until a form asked a
-- consultant to pick a colleague.
--
-- Nullable, because a membership that predates the roster import has no name yet and inventing one
-- would be worse than showing the handle. The import fills them; the read model falls back to the
-- user_id and says so.
ALTER TABLE nzi_console.memberships
  ADD COLUMN display_name text,
  ADD COLUMN email text;

CREATE UNIQUE INDEX memberships_email_once_idx
  ON nzi_console.memberships (organisation_id, lower(btrim(email)))
  WHERE email IS NOT NULL;

-- ── Isolation ───────────────────────────────────────────────────────────────────────────────

ALTER TABLE nzi_console.reference_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.reference_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.reference_values
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- `reference_categories` is deliberately not tenant-partitioned: it is the catalogue of what kinds
-- of reference data exist, identical for every tenant, and holds no organisation's data. Read-only
-- to the app; a new category is a migration or an admin act, not a request-time write.
GRANT SELECT ON nzi_console.reference_categories TO nzi_console_app;
REVOKE INSERT, UPDATE, DELETE ON nzi_console.reference_categories FROM nzi_console_app, PUBLIC, nzi_console_worker, nzi_console_auth;

GRANT SELECT, INSERT, UPDATE ON nzi_console.reference_values TO nzi_console_app;
-- Archive is deactivation: a client pointing at an industry must stay explicable after that
-- industry stops being offered.
REVOKE DELETE ON nzi_console.reference_values FROM nzi_console_app, PUBLIC, nzi_console_worker, nzi_console_auth;

COMMIT;
