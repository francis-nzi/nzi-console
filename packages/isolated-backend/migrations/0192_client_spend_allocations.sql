-- 0192 Data entry D2: the allocation map — a client's GL codes (or, without them, normalised descriptions) routed to the category
-- each spend line belongs in, so PG&S stops being where spend goes by default (BUILD-dataentry-D2-allocation-map, R1–R4, R6).
--
-- ## Why its own table, on the reference engine's terms
--
-- The reference-data engine (`reference_values`, 0089/0138) is an organisation's flat vocabularies: a value, a label, a code.
-- The map is **per client** (it learns that client's chart of accounts) and each entry is **typed**: a key of a kind, a target
-- category in the emission taxonomy, whether VAT applies there, and optionally the spend factor to price it with. Forcing that
-- through `code` / `source_ref` is the blob 0089 refused. So the map has its own table and keeps the engine's discipline:
-- versioned, archived never deleted, its key set once, provenance in `source`, one live entry per key, the admin.lookups
-- capability for Admin's edits.
--
-- ## The key
--
-- `key_kind` is `gl` or `description`; `match_key` is the key normalised exactly as routing normalises a line
-- (`normaliseGlCode` / `normaliseDescription` in @nzi/contracts), so a lookup is an equality, never a fuzzy match; `display_key`
-- is what a person typed, for reading. At most one **live** entry per (client, kind, key): an archived one leaves room for its
-- replacement and still resolves on whatever cites it.
--
-- ## Where an entry comes from (`source`)
--
-- `admin` — set in Admin; `reallocation` — learnt from a reviewer moving a line (R4); `suggestion-confirmed` — an AI suggestion a
-- person confirmed (R5, the follow-on PR). The AI never writes here: only a person's confirmation does.
--
-- No figures, no personal data: a GL code and an accounts description are the client's chart of accounts, not a person.

BEGIN;

CREATE TABLE nzi_console.client_spend_allocations (
  organisation_id text NOT NULL,
  allocation_id text NOT NULL,
  client_id text NOT NULL,
  key_kind text NOT NULL CHECK (key_kind IN ('gl', 'description')),
  match_key text NOT NULL CHECK (btrim(match_key) <> '' AND length(match_key) <= 200),
  display_key text NOT NULL CHECK (btrim(display_key) <> '' AND length(display_key) <= 200),
  target_category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  vat_applies boolean NOT NULL DEFAULT true,
  default_dataset_id text,
  default_factor_id text,
  source text NOT NULL CHECK (source IN ('admin', 'reallocation', 'suggestion-confirmed')),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, allocation_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  CONSTRAINT client_spend_allocations_default_factor_paired CHECK ((default_dataset_id IS NULL) = (default_factor_id IS NULL))
);
COMMENT ON TABLE nzi_console.client_spend_allocations IS
  'D2: a client''s allocation map — a GL code (or normalised description) to the category a spend line belongs in, with VAT-applies and an optional default spend factor. Versioned, archived never deleted.';

CREATE UNIQUE INDEX client_spend_allocations_live_key_idx
  ON nzi_console.client_spend_allocations (organisation_id, client_id, key_kind, match_key) WHERE active;
CREATE INDEX client_spend_allocations_client_idx
  ON nzi_console.client_spend_allocations (organisation_id, client_id);

ALTER TABLE nzi_console.client_spend_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_spend_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_spend_allocations
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.client_spend_allocations TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_spend_allocations FROM nzi_console_app, PUBLIC;

COMMIT;
