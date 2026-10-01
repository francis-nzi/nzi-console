-- 0145 Commercial lookups (admin Phase E1; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q1–E-Q3): currencies in
-- their own table, the one-default invariant made exact for currencies and VAT rates, and the one client stored with the
-- non-ISO currency "UAE" corrected to "AED".
--
-- ## What it adds
--
-- 1. **`currencies`** (R2: typed, its own table) — per organisation: the ISO-4217 `code` (the key, set once: the
--    application role holds no UPDATE on it), `name`, `symbol`, `is_default`, `active`, `version`, who-and-when, and 0132's
--    import provenance. One clean set: **no "UAE" row, and no alias** — a CHECK refuses the code (E-Q2). No
--    `exchange_rate` (E-Q1: converting is a commercial act, deferred to the workstream that first converts).
--    This is the table D3c's `currencySymbol(code)` reads from.
-- 2. **Exactly one default**, for `currencies` and for 0139's `vat_rates`: at most one by each table's partial unique
--    index (immediate — a default moves by clearing the old one first), and **at least one** by a deferred constraint
--    trigger, checked at commit: an organisation that holds any row holds a default. 0139 enforced only "at most one".
--    VAT rates already exist (0139) and are already imported (C4's `load:v7-jobs-config`); E1 adds their editing.
-- 3. **The one mis-coded client** (E-Q2): `clients.currency = 'UAE'` → `'AED'`, value-for-value — identified exactly
--    (the non-ISO code itself), version bumped, one audit event per row (`client.currency.corrected`, before and after),
--    each row printed below (RAISE NOTICE) and the total. Done **before** the currencies are seeded, so the set never
--    holds "UAE" — fix, then validate (E-Q3).
-- 4. **Each organisation's starting set**: GBP (the default) and every currency its clients already hold, after the fix.
--    `client.update` validates a currency against the organisation's active set (E-Q3); seeding what is already held
--    means that rule can never lock an existing client out. Names and symbols come from the short ISO table below; a
--    code it lacks is seeded with the code as its name and symbol, to be named on the screen. `load:v7-currencies` then
--    reconciles v7's two currency tables onto these rows.
-- 5. **New organisations** start with GBP as their default currency (a trigger beside 0142's provisioning).
--
-- ## Throughout
--
-- Forced row-level security and the tenant policy; no DELETE for anyone (R3 — deactivate, never delete); nothing here is
-- personal data.

BEGIN;

-- ── 1. Currencies ─────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE nzi_console.currencies (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  code text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  symbol text NOT NULL CHECK (btrim(symbol) <> '' AND length(symbol) <= 8),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_system text,
  legacy_db_id text,
  legacy_values jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
  PRIMARY KEY (organisation_id, code),
  -- E-Q2: v7 stored the UAE dirham as the country, "UAE". The set is ISO-4217 — AED — with no alias.
  CONSTRAINT currencies_not_the_country CHECK (code <> 'UAE'),
  CONSTRAINT currencies_default_is_active CHECK (NOT (is_default AND NOT active)),
  CONSTRAINT currencies_import_provenance_shape CHECK (
    (source_system IS NULL AND legacy_db_id IS NULL AND legacy_values IS NULL)
    OR (source_system IS NOT NULL AND btrim(source_system) <> '' AND legacy_db_id IS NOT NULL AND btrim(legacy_db_id) <> ''
        AND legacy_values IS NOT NULL))
);
CREATE UNIQUE INDEX currencies_one_default ON nzi_console.currencies (organisation_id) WHERE is_default;
CREATE UNIQUE INDEX currencies_import_identity_key ON nzi_console.currencies (organisation_id, source_system, legacy_db_id)
  WHERE source_system IS NOT NULL;
COMMENT ON TABLE nzi_console.currencies IS
  'Currencies per organisation (admin E1): ISO-4217 code (set once), name, symbol, exactly one default. No "UAE" alias. currencySymbol(code) reads from here.';

ALTER TABLE nzi_console.currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.currencies
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
REVOKE ALL ON nzi_console.currencies FROM PUBLIC;
-- The code is the key a client and (later) a quote name: inserted once, never updated — no UPDATE on the column.
GRANT SELECT, INSERT ON nzi_console.currencies TO nzi_console_app;
GRANT UPDATE (name, symbol, is_default, active, source_system, legacy_db_id, legacy_values, version, updated_at, updated_by)
  ON nzi_console.currencies TO nzi_console_app;

-- ── 2. Exactly one default (currencies and VAT rates) ──────────────────────────────────────────────────────────────

-- At commit: an organisation holding any row of the table holds exactly one default. "At most one" stays with each
-- table's partial unique index; this adds "at least one", which no index can say.
CREATE FUNCTION nzi_console.keep_one_default() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  org text := coalesce(NEW.organisation_id, OLD.organisation_id);
  held integer;
  defaults integer;
BEGIN
  EXECUTE format('SELECT count(*), count(*) FILTER (WHERE is_default) FROM nzi_console.%I WHERE organisation_id = $1', TG_TABLE_NAME)
    INTO held, defaults USING org;
  IF held > 0 AND defaults <> 1 THEN
    RAISE EXCEPTION 'ONE_DEFAULT: % holds % % row(s) and % default(s); it must hold exactly one default', org, held, TG_TABLE_NAME, defaults
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_keep_one_default';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER currencies_keep_one_default
  AFTER INSERT OR UPDATE OF is_default, active ON nzi_console.currencies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nzi_console.keep_one_default();

CREATE CONSTRAINT TRIGGER vat_rates_keep_one_default
  AFTER INSERT OR UPDATE OF is_default, active ON nzi_console.vat_rates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nzi_console.keep_one_default();

-- The rows already held must satisfy it before it is relied on: refuse to apply otherwise, rather than leave an
-- organisation whose next edit would fail.
DO $$
DECLARE
  bad record;
BEGIN
  FOR bad IN
    SELECT organisation_id, count(*) AS held, count(*) FILTER (WHERE is_default) AS defaults
      FROM nzi_console.vat_rates GROUP BY organisation_id HAVING count(*) FILTER (WHERE is_default) <> 1
  LOOP
    RAISE EXCEPTION '0145: % holds % VAT rate(s) and % default(s) — put one default right before applying', bad.organisation_id, bad.held, bad.defaults;
  END LOOP;
END;
$$;

COMMENT ON TABLE nzi_console.vat_rates IS
  'VAT rates per organisation, exactly one default (0139 at most one; 0145 at least one, at commit). Edited from admin E1 (vat.*).';

-- ── 3. The one mis-coded client: "UAE" → "AED" (E-Q2) ────────────────────────────────────────────────────────────

DO $$
DECLARE
  corrected record;
  total integer := 0;
BEGIN
  FOR corrected IN
    UPDATE nzi_console.clients
       SET currency = 'AED', version = version + 1, updated_at = now()
     WHERE currency = 'UAE'
    RETURNING organisation_id, client_id, version
  LOOP
    total := total + 1;
    INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json, client_id)
    VALUES (corrected.organisation_id, gen_random_uuid()::text, 'migration:0145', 'system', 'client.currency.corrected', 'client', corrected.client_id, 'migration:0145',
      'Stored as the country "UAE" rather than the ISO-4217 currency; corrected to AED, value for value (ruled phaseE plan E-Q2).',
      jsonb_build_object('currency', 'UAE', 'version', corrected.version - 1),
      jsonb_build_object('currency', 'AED', 'version', corrected.version),
      corrected.client_id);
    RAISE NOTICE '0145 corrected client currency: organisation % · client % · UAE → AED (version %)',
      corrected.organisation_id, corrected.client_id, corrected.version;
  END LOOP;
  RAISE NOTICE '0145 corrected % client currency value(s) from UAE to AED', total;
END;
$$;

-- ── 4. Each organisation's starting set ────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.provision_organisation_currencies(p_organisation_id text, p_actor text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, nzi_console AS $$
DECLARE
  added integer;
BEGIN
  -- GBP (the default, unless the organisation already has one) and every currency its clients hold.
  INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, is_default, created_by, updated_by)
  SELECT p_organisation_id, held.code, coalesce(iso.name, held.code), coalesce(iso.symbol, held.code),
         held.code = 'GBP' AND NOT EXISTS (SELECT 1 FROM nzi_console.currencies d WHERE d.organisation_id = p_organisation_id AND d.is_default),
         p_actor, p_actor
    FROM (SELECT 'GBP' AS code
          UNION SELECT upper(btrim(c.currency)) FROM nzi_console.clients c
           WHERE c.organisation_id = p_organisation_id AND upper(btrim(c.currency)) ~ '^[A-Z]{3}$' AND upper(btrim(c.currency)) <> 'UAE') AS held
    LEFT JOIN (VALUES
      ('GBP', 'Pound sterling', '£'), ('EUR', 'Euro', '€'), ('USD', 'US dollar', '$'), ('AED', 'UAE dirham', 'AED'),
      ('AUD', 'Australian dollar', 'A$'), ('CAD', 'Canadian dollar', 'C$'), ('NZD', 'New Zealand dollar', 'NZ$'),
      ('CHF', 'Swiss franc', 'CHF'), ('JPY', 'Japanese yen', '¥'), ('SEK', 'Swedish krona', 'SEK'), ('NOK', 'Norwegian krone', 'NOK'),
      ('DKK', 'Danish krone', 'DKK'), ('SAR', 'Saudi riyal', 'SAR'), ('QAR', 'Qatari riyal', 'QAR'), ('INR', 'Indian rupee', '₹'),
      ('SGD', 'Singapore dollar', 'S$'), ('HKD', 'Hong Kong dollar', 'HK$'), ('ZAR', 'South African rand', 'R'))
      AS iso(code, name, symbol) ON iso.code = held.code
  ON CONFLICT (organisation_id, code) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$;

DO $$
DECLARE
  org record;
  added integer;
BEGIN
  FOR org IN SELECT organisation_id FROM nzi_console.organisations ORDER BY organisation_id LOOP
    added := nzi_console.provision_organisation_currencies(org.organisation_id, 'migration:0145');
    RAISE NOTICE '0145 currencies: organisation % · % seeded (GBP the default, and every currency its clients hold)', org.organisation_id, added;
  END LOOP;
END;
$$;

-- ── 5. New organisations start with GBP ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION nzi_console.provision_new_organisation_currencies() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nzi_console.provision_organisation_currencies(NEW.organisation_id, 'migration:0145');
  RETURN NEW;
END;
$$;

CREATE TRIGGER provision_currencies_on_insert AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation_currencies();

COMMIT;
