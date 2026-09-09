-- 0060 Client identity parity (NZC-064).
-- Carries the live CRM's client record forward: Details firmographics, the
-- net-zero trajectory reporting reads (WORKFLOWS.md §2), registered/billing
-- address, and the compliance context AI insights are grounded on.
-- Additive and nullable throughout — existing rows stay valid and inert until edited.

SET search_path = nzi_console;

ALTER TABLE nzi_console.clients
  -- Details
  ADD COLUMN portfolio text,
  ADD COLUMN client_manager text,
  ADD COLUMN website text,
  ADD COLUMN industry_sic text,
  ADD COLUMN company_registration text,
  ADD COLUMN headquarters text,
  ADD COLUMN financial_year_end_month integer,
  ADD COLUMN data_reporting_frequency text NOT NULL DEFAULT 'annual',
  ADD COLUMN currency text NOT NULL DEFAULT 'GBP',
  ADD COLUMN logo_url text,
  ADD COLUMN company_description text,
  ADD COLUMN referral text,
  -- Targets
  ADD COLUMN net_zero_target_year integer,
  ADD COLUMN net_zero_target_reduction_pct numeric,
  ADD COLUMN baseline_period_start date,
  ADD COLUMN baseline_period_end date,
  ADD COLUMN baseline_scope1_tco2e numeric,
  ADD COLUMN baseline_scope2_tco2e numeric,
  ADD COLUMN baseline_scope3_tco2e numeric,
  ADD COLUMN baseline_total_tco2e numeric,
  ADD COLUMN scope1_interim_year integer,
  ADD COLUMN scope1_interim_reduction_pct numeric,
  ADD COLUMN scope2_interim_year integer,
  ADD COLUMN scope2_interim_reduction_pct numeric,
  ADD COLUMN scope3_interim_year integer,
  ADD COLUMN scope3_interim_reduction_pct numeric,
  -- Registered / trading address
  ADD COLUMN registered_address_line1 text,
  ADD COLUMN registered_address_line2 text,
  ADD COLUMN registered_city text,
  ADD COLUMN registered_region text,
  ADD COLUMN registered_postcode text,
  ADD COLUMN registered_country text,
  -- Billing address
  ADD COLUMN billing_same_as_registered boolean NOT NULL DEFAULT true,
  ADD COLUMN billing_company text,
  ADD COLUMN billing_address_line1 text,
  ADD COLUMN billing_address_line2 text,
  ADD COLUMN billing_city text,
  ADD COLUMN billing_region text,
  ADD COLUMN billing_postcode text,
  ADD COLUMN billing_country text,
  -- Compliance context
  ADD COLUMN parent_company text,
  ADD COLUMN group_structure text,
  ADD COLUMN reporting_frameworks text[] NOT NULL DEFAULT '{}',
  ADD COLUMN certifications text[] NOT NULL DEFAULT '{}',
  ADD COLUMN primary_scope3_categories text[] NOT NULL DEFAULT '{}';

ALTER TABLE nzi_console.clients
  ADD CONSTRAINT clients_reporting_frequency_check
    CHECK (data_reporting_frequency IN ('annual','quarterly','monthly')),
  ADD CONSTRAINT clients_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT clients_fye_month_check
    CHECK (financial_year_end_month IS NULL OR financial_year_end_month BETWEEN 1 AND 12),
  ADD CONSTRAINT clients_baseline_period_check
    CHECK (baseline_period_start IS NULL OR baseline_period_end IS NULL
           OR baseline_period_end > baseline_period_start),
  ADD CONSTRAINT clients_group_structure_check
    CHECK (group_structure IS NULL
           OR group_structure IN ('standalone','subsidiary','parent','joint-venture'));

-- Target years and reduction percentages share one shape across net-zero and the
-- three interim scopes, so they share one pair of constraints.
ALTER TABLE nzi_console.clients
  ADD CONSTRAINT clients_target_years_check CHECK (
    (net_zero_target_year IS NULL OR net_zero_target_year BETWEEN 2020 AND 2100) AND
    (scope1_interim_year IS NULL OR scope1_interim_year BETWEEN 2020 AND 2100) AND
    (scope2_interim_year IS NULL OR scope2_interim_year BETWEEN 2020 AND 2100) AND
    (scope3_interim_year IS NULL OR scope3_interim_year BETWEEN 2020 AND 2100)
  ),
  ADD CONSTRAINT clients_target_reductions_check CHECK (
    (net_zero_target_reduction_pct IS NULL OR net_zero_target_reduction_pct BETWEEN 0 AND 100) AND
    (scope1_interim_reduction_pct IS NULL OR scope1_interim_reduction_pct BETWEEN 0 AND 100) AND
    (scope2_interim_reduction_pct IS NULL OR scope2_interim_reduction_pct BETWEEN 0 AND 100) AND
    (scope3_interim_reduction_pct IS NULL OR scope3_interim_reduction_pct BETWEEN 0 AND 100)
  ),
  ADD CONSTRAINT clients_baseline_emissions_check CHECK (
    (baseline_scope1_tco2e IS NULL OR baseline_scope1_tco2e >= 0) AND
    (baseline_scope2_tco2e IS NULL OR baseline_scope2_tco2e >= 0) AND
    (baseline_scope3_tco2e IS NULL OR baseline_scope3_tco2e >= 0) AND
    (baseline_total_tco2e  IS NULL OR baseline_total_tco2e  >= 0)
  );
