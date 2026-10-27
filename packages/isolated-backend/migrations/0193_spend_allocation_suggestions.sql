-- 0193 Data entry D2 (R5): AI suggestions of the proper category for a spend line the client's allocation map does not know, on the
-- S3 terms (BUILD-dataentry-D2-allocation-map, R5, R8).
--
-- A suggestion is **stored labelled and never applied**: it is `suggested` until a person confirms it — which writes the map entry,
-- as `suggestion-confirmed` (0192) — or dismisses it. The AI never writes the map. A move at review that lands where the suggestion
-- said confirms it too.
--
-- What is kept: the line's key as the map keys it (GL code, or normalised description), the suggested category and a short
-- figure-free reason, and **by reference** the request — the model and the SHA-256 of the exact prompt. The prompt and the reply
-- are never stored; the audit events carry the model, the hash and the category, never the description or the reason.
--
-- No figures, no personal data: a GL code and a normalised accounts description (digits and punctuation already gone).

BEGIN;

CREATE TABLE nzi_console.spend_allocation_suggestions (
  organisation_id text NOT NULL,
  suggestion_id text NOT NULL,
  client_id text NOT NULL,
  job_id text NOT NULL,
  key_kind text NOT NULL CHECK (key_kind IN ('gl', 'description')),
  match_key text NOT NULL CHECK (btrim(match_key) <> '' AND length(match_key) <= 200),
  display_key text NOT NULL CHECK (btrim(display_key) <> '' AND length(display_key) <= 200),
  suggested_category_code text NOT NULL REFERENCES nzi_console.input_spec_categories(category_code),
  reason text NOT NULL CHECK (length(reason) <= 240 AND reason !~ '[0-9]'),
  model text NOT NULL CHECK (btrim(model) <> ''),
  prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
  confirmed_category_code text REFERENCES nzi_console.input_spec_categories(category_code),
  allocation_id text,
  decided_by text,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (organisation_id, suggestion_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, allocation_id) REFERENCES nzi_console.client_spend_allocations(organisation_id, allocation_id),
  CONSTRAINT spend_allocation_suggestions_decided CHECK ((status = 'suggested') = (decided_at IS NULL)),
  CONSTRAINT spend_allocation_suggestions_confirmed CHECK ((status = 'confirmed') = (confirmed_category_code IS NOT NULL AND allocation_id IS NOT NULL))
);
COMMENT ON TABLE nzi_console.spend_allocation_suggestions IS
  'D2 R5: an AI suggestion of the category for an unmapped spend line — labelled, never applied; a person confirms (writing the map) or dismisses it. The request is kept by reference (model + prompt SHA-256), never its text.';

CREATE INDEX spend_allocation_suggestions_key_idx ON nzi_console.spend_allocation_suggestions (organisation_id, client_id, key_kind, match_key);

ALTER TABLE nzi_console.spend_allocation_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.spend_allocation_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.spend_allocation_suggestions
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.spend_allocation_suggestions TO nzi_console_app;
REVOKE DELETE ON nzi_console.spend_allocation_suggestions FROM nzi_console_app, PUBLIC;

COMMIT;
