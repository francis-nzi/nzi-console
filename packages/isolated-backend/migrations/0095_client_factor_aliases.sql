-- 0095 What this client calls this factor (NZC-109).
--
-- A shared dataset factor is called "Diesel (average biofuel blend) — HGV rigid >7.5t" because that
-- is what the published dataset calls it. A client's report should be allowed to call it "Fleet
-- fuel". Today the only place to put that name is `job_scope_rows.report_label`, which belongs to
-- one row in one job: the name has to be re-typed on every row that uses the factor, and typed
-- again next year when rollforward mints new rows.
--
-- ## Why this is not a column on something that already exists
--
-- **Not on the factor.** `emission_factors` is the published dataset. One client's preferred wording
-- is not a property of a dataset every client shares.
--
-- **Not through `client_factors` (0034).** That table is a *standalone client-specific factor*: it
-- carries its own kgco2e_per_unit, unit, geography, vintage and evidence, and has no reference to a
-- dataset factor at all. Renaming a dataset factor by creating one of those would mint a client
-- factor as a renaming device and fork the emission value away from the dataset — the dataset gets
-- updated, the renamed copy does not. That is re-pointing the factor, which the identity invariant
-- forbids (NZC-108 records this ruling being withdrawn).
--
-- **Not on the scope row.** A row is a transient artefact of one job. A name keyed to it dies at
-- rollforward and has to be re-applied every year, which is the experience this exists to prevent.
--
-- ## Label and nothing else, structurally
--
-- The table carries a label. It cannot carry a quantity, a factor value or a unit, because those
-- columns do not exist here — which is the property that makes this safe in a way that reusing
-- `client_factors` could never be. A row in this table cannot change a number. The worst a wrong
-- entry can do is print the wrong words, and the audit trail says who chose them.

BEGIN;

CREATE TABLE nzi_console.client_factor_aliases (
  organisation_id text NOT NULL,
  client_id text NOT NULL,
  dataset_id text NOT NULL,
  factor_id text NOT NULL,
  -- What the client's report calls this factor. Present and non-blank, because an alias that
  -- resolves to nothing would print nothing where a name belongs.
  label text NOT NULL CHECK (nullif(btrim(label), '') IS NOT NULL),
  -- Archive, never delete: an alias that was in force when a report was issued stays readable, so
  -- the wording of that report can still be explained.
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  PRIMARY KEY (organisation_id, client_id, dataset_id, factor_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, dataset_id, factor_id) REFERENCES nzi_console.emission_factors(organisation_id, dataset_id, factor_id)
);

COMMENT ON TABLE nzi_console.client_factor_aliases IS
  'What one client calls one shared dataset factor. A label and nothing else — it cannot carry a value, which is what makes it display rather than measurement. Keyed to the client and the factor rather than to a scope row, so it survives rollforward instead of being re-typed each year.';
COMMENT ON COLUMN nzi_console.client_factor_aliases.active IS
  'Deactivated rather than deleted. A report issued while an alias was in force keeps its wording, and that wording stays explicable.';

-- The read is always "this client's aliases", resolved a screen at a time.
CREATE INDEX client_factor_aliases_client_idx
  ON nzi_console.client_factor_aliases(organisation_id, client_id) WHERE active;

ALTER TABLE nzi_console.client_factor_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_factor_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_factor_aliases
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

GRANT SELECT, INSERT, UPDATE ON nzi_console.client_factor_aliases TO nzi_console_app;
REVOKE DELETE ON nzi_console.client_factor_aliases FROM PUBLIC, nzi_console_app, nzi_console_worker, nzi_console_auth;

COMMIT;
