-- 0194 Data entry D3 (R1, R7): local-first currency — a site's own currency, and a per-site, per-job FX rate used only to express
-- money in the client's currency (BUILD-dataentry-D3-pgs-specifics).
--
-- ## What is added
--
-- - **`client_sites.currency`** — the ISO-4217 code the site spends in. Null: the client's currency (`clients.currency`). A spend
--   line is captured in its site's currency, and priced by a spend factor in that currency — the country's own (CEDA etc.). The
--   emissions are local spend × that factor; **no FX ever enters the carbon maths** (the write already holds a currency entry to a
--   factor priced in the same currency, D1).
-- - **`job_site_fx_rates`** — for one job and one site, the CRM's **average rate for the reporting 12-month period**: how many
--   units of the client's currency one unit of the site's currency is worth. It is read **only** to express money in the client's
--   currency where a total needs one (a category's spend total), never by the calculation. Versioned; the currencies it converts
--   between are recorded with it, so a later change of the site's or client's currency cannot silently re-mean an old rate.
--
-- Not personal data. Tenant-isolated; written by the console only.

BEGIN;

ALTER TABLE nzi_console.client_sites
  ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
COMMENT ON COLUMN nzi_console.client_sites.currency IS
  'D3: the ISO-4217 currency the site spends in. Null: the client''s currency. Spend at the site is captured and priced in it; FX never enters the emissions.';

CREATE TABLE nzi_console.job_site_fx_rates (
  organisation_id text NOT NULL,
  job_id text NOT NULL,
  site_id text NOT NULL,
  from_currency text NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency text NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$' AND to_currency <> from_currency),
  -- 1 unit of from_currency = rate units of to_currency, the average over the job's reporting period.
  rate numeric(18, 8) NOT NULL CHECK (rate > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (organisation_id, job_id, site_id),
  FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs(organisation_id, job_id),
  FOREIGN KEY (organisation_id, site_id) REFERENCES nzi_console.client_sites(organisation_id, site_id)
);
COMMENT ON TABLE nzi_console.job_site_fx_rates IS
  'D3: per job and site, the CRM''s average FX rate for the reporting period — from the site''s currency to the client''s. Used only to express money in the client''s currency; never in the emissions calculation.';

ALTER TABLE nzi_console.job_site_fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.job_site_fx_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.job_site_fx_rates
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));
GRANT SELECT, INSERT, UPDATE ON nzi_console.job_site_fx_rates TO nzi_console_app;
REVOKE DELETE ON nzi_console.job_site_fx_rates FROM nzi_console_app, PUBLIC;

COMMIT;
