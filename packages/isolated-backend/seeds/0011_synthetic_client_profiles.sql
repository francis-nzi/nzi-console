BEGIN;

SET search_path TO nzi_console, public;

-- Populates the NZC-064 client profile fields (migration 0060) for the five
-- synthetic demonstrator clients.
--
-- Synthetic throughout: fictional names, `.invalid` domains, no real company
-- registrations, no copied notes, no live identifiers (NZC-020). What is borrowed
-- from the live system is *shape*, not content — the states the redesign has to
-- render without falling over:
--
--   bushy-tails      fully populated, every tab complete
--   cedar-crane      targets set but no baseline period and no interim years;
--                    billing address differs from registered
--   verdant-foods    long description, quarterly reporting, subsidiary of a group
--   quaymed-devices  onboarding — almost nothing set; the empty-tab case
--   harbourline      EUR, monthly reporting, non-round baselines, wide Scope 3
--
-- Controlled vocabularies must match @nzi/contracts exactly, or the edit form will
-- reject its own seeded values on save: reporting_frameworks/certifications use the
-- contract's labels, primary_scope3_categories the canonical taxonomy codes (3.1–3.15).
--
-- logo_url is left NULL: a fictional client has no real logo to point at, and a
-- dead URL would render a broken preview that reads as a bug.
--
-- Idempotent — the guard compares the incoming profile against the stored one, so
-- re-running is a no-op and does not inflate `version`.

WITH profile (
  client_id, portfolio, client_manager, website, industry_sic, company_registration, headquarters,
  financial_year_end_month, data_reporting_frequency, currency, company_description, referral,
  net_zero_target_year, net_zero_target_reduction_pct, baseline_period_start, baseline_period_end,
  baseline_scope1_tco2e, baseline_scope2_tco2e, baseline_scope3_tco2e, baseline_total_tco2e,
  scope1_interim_year, scope1_interim_reduction_pct, scope2_interim_year, scope2_interim_reduction_pct,
  scope3_interim_year, scope3_interim_reduction_pct,
  registered_address_line1, registered_address_line2, registered_city, registered_region,
  registered_postcode, registered_country,
  billing_same_as_registered, billing_company, billing_address_line1, billing_address_line2,
  billing_city, billing_region, billing_postcode, billing_country,
  parent_company, group_structure, reporting_frameworks, certifications, primary_scope3_categories
) AS (VALUES
  (
    'bushy-tails', 'NZN', 'A. Shaw', 'https://bushy-tails.synthetic.invalid', '10410',
    'SC000000', 'Bushy Tails Manufacturing Hub', 12::int, 'annual', 'GBP',
    'Consumer pet-care goods manufactured and packed in Greater Manchester, distributed to UK and Irish grocery retail.',
    'Net Zero Nation',
    2045::int, 90::numeric, DATE '2022-04-01', DATE '2023-03-31',
    612.4::numeric, 488.9::numeric, 741.3::numeric, 1842.6::numeric,
    2035::int, 50::numeric, 2035::int, 50::numeric, 2035::int, 42.5::numeric,
    'Unit 14, Northbank Industrial Estate', 'Ashcroft Way', 'Manchester', 'Greater Manchester',
    'M17 1TX', 'United Kingdom',
    true, 'Bushy Tails Ltd', NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
    NULL::text, 'standalone',
    ARRAY['SECR','GHG Protocol','CDP']::text[],
    ARRAY['ISO 14001','B Corp']::text[],
    ARRAY['3.1','3.4','3.5','3.6','3.7']::text[]
  ),
  (
    -- Targets partly set: a net-zero commitment with no baseline period agreed yet
    -- and no interim years — common early in an engagement, and the state the
    -- Targets tab most needs to render without implying false precision.
    'cedar-crane', 'NZN', 'A. Shaw', 'https://cedar-crane.synthetic.invalid', '71111',
    'OC000000', 'Cedar & Crane Studio', 3, 'annual', 'GBP',
    'Architecture practice working on public-sector and residential retrofit.',
    NULL,
    2040, 90, NULL, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL,
    'Second Floor, The Tannery', '41 Bermondsey Street', 'London', 'Greater London',
    'SE1 3XF', 'United Kingdom',
    -- Invoices go to the practice's accountant, not the studio.
    false, 'Cedar & Crane Architects LLP', 'Marchmont Accountancy', 'PO Box 2214',
    'Croydon', 'Greater London', 'CR9 1SS', 'United Kingdom',
    NULL, 'standalone',
    ARRAY['SECR','Voluntary CRP']::text[],
    ARRAY[]::text[],
    ARRAY['3.1','3.6','3.7']::text[]
  ),
  (
    'verdant-foods', 'NZN', 'M. Osei', 'https://verdant-foods.synthetic.invalid', '10890',
    '00000000', 'Verdant Foods Production Site', 9, 'quarterly', 'GBP',
    'Chilled ready-meal and soup production across two Bristol sites, supplying own-label ranges to four UK grocery multiples and a national foodservice distributor. Reporting scope covers both production sites, the Avonmouth cold store and the leased distribution fleet; the Somerset packing partner is treated as an upstream supplier rather than an operated site, which is the boundary question raised at the last review.',
    'Existing client referral',
    2050, 90, DATE '2023-10-01', DATE '2024-09-30',
    3120.5, 2044.75, 4045.2, 9210.45,
    2035, 45, 2035, 55, 2040, 30,
    'Verdant Foods Production Site', 'Kingsland Trading Estate, St Philips', 'Bristol', 'Bristol, City of',
    'BS2 0RZ', 'United Kingdom',
    true, 'Verdant Foods Co', NULL, NULL, NULL, NULL, NULL, NULL,
    'Greenfold Holdings', 'subsidiary',
    ARRAY['SECR','GHG Protocol','ESOS','TCFD']::text[],
    ARRAY['ISO 14001','ISO 50001','Race to Zero']::text[],
    ARRAY['3.1','3.2','3.3','3.4','3.5','3.9','3.12']::text[]
  ),
  (
    -- Onboarding: the empty-tab case. Only what is known at account opening.
    'quaymed-devices', NULL, 'M. Osei', NULL, NULL, NULL, NULL,
    NULL, 'annual', 'EUR', NULL, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL,
    'Parkmore Business Park West', NULL, 'Galway', 'County Galway',
    'H91 XH2P', 'Ireland',
    true, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL,
    ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[]
  ),
  (
    'harbourline-logistics', 'NZN', 'A. Shaw', 'https://harbourline.synthetic.invalid', '52290',
    '00000000', 'Harbourline Logistics Rotterdam Terminal', 12, 'monthly', 'EUR',
    'Short-sea and inland freight forwarding operating out of Rotterdam, with owned tractor units and chartered barge capacity.',
    'Net Zero Nation',
    2050, 85, DATE '2022-01-01', DATE '2022-12-31',
    14208.35, 1187.6, 3004.05, 18400.0,
    2035, 40, 2035, 60, 2040, 25,
    'Wilhelminakade 173', 'Havennummer 2153', 'Rotterdam', 'Zuid-Holland',
    '3072 AP', 'Netherlands',
    true, 'Harbourline Logistics B.V.', NULL, NULL, NULL, NULL, NULL, NULL,
    'Harbourline Group N.V.', 'parent',
    ARRAY['GHG Protocol','CSRD','CDP','SBTi']::text[],
    ARRAY['ISO 14001','SBTi pledge']::text[],
    ARRAY['3.3','3.4','3.6','3.9','3.11']::text[]
  )
)
UPDATE clients c SET
  portfolio = p.portfolio, client_manager = p.client_manager, website = p.website,
  industry_sic = p.industry_sic, company_registration = p.company_registration,
  headquarters = p.headquarters, financial_year_end_month = p.financial_year_end_month,
  data_reporting_frequency = p.data_reporting_frequency, currency = p.currency,
  company_description = p.company_description, referral = p.referral,
  net_zero_target_year = p.net_zero_target_year, net_zero_target_reduction_pct = p.net_zero_target_reduction_pct,
  baseline_period_start = p.baseline_period_start, baseline_period_end = p.baseline_period_end,
  baseline_scope1_tco2e = p.baseline_scope1_tco2e, baseline_scope2_tco2e = p.baseline_scope2_tco2e,
  baseline_scope3_tco2e = p.baseline_scope3_tco2e, baseline_total_tco2e = p.baseline_total_tco2e,
  scope1_interim_year = p.scope1_interim_year, scope1_interim_reduction_pct = p.scope1_interim_reduction_pct,
  scope2_interim_year = p.scope2_interim_year, scope2_interim_reduction_pct = p.scope2_interim_reduction_pct,
  scope3_interim_year = p.scope3_interim_year, scope3_interim_reduction_pct = p.scope3_interim_reduction_pct,
  registered_address_line1 = p.registered_address_line1, registered_address_line2 = p.registered_address_line2,
  registered_city = p.registered_city, registered_region = p.registered_region,
  registered_postcode = p.registered_postcode, registered_country = p.registered_country,
  billing_same_as_registered = p.billing_same_as_registered, billing_company = p.billing_company,
  billing_address_line1 = p.billing_address_line1, billing_address_line2 = p.billing_address_line2,
  billing_city = p.billing_city, billing_region = p.billing_region,
  billing_postcode = p.billing_postcode, billing_country = p.billing_country,
  parent_company = p.parent_company, group_structure = p.group_structure,
  reporting_frameworks = p.reporting_frameworks, certifications = p.certifications,
  primary_scope3_categories = p.primary_scope3_categories,
  version = c.version + 1, updated_at = now()
FROM profile p
WHERE c.organisation_id = 'demo-nzi-console' AND c.client_id = p.client_id
  AND (
    c.portfolio, c.client_manager, c.website, c.industry_sic, c.company_registration, c.headquarters,
    c.financial_year_end_month, c.data_reporting_frequency, c.currency, c.company_description, c.referral,
    c.net_zero_target_year, c.net_zero_target_reduction_pct, c.baseline_period_start, c.baseline_period_end,
    c.baseline_scope1_tco2e, c.baseline_scope2_tco2e, c.baseline_scope3_tco2e, c.baseline_total_tco2e,
    c.scope1_interim_year, c.scope1_interim_reduction_pct, c.scope2_interim_year, c.scope2_interim_reduction_pct,
    c.scope3_interim_year, c.scope3_interim_reduction_pct,
    c.registered_address_line1, c.registered_address_line2, c.registered_city, c.registered_region,
    c.registered_postcode, c.registered_country,
    c.billing_same_as_registered, c.billing_company, c.billing_address_line1, c.billing_address_line2,
    c.billing_city, c.billing_region, c.billing_postcode, c.billing_country,
    c.parent_company, c.group_structure, c.reporting_frameworks, c.certifications, c.primary_scope3_categories
  ) IS DISTINCT FROM (
    p.portfolio, p.client_manager, p.website, p.industry_sic, p.company_registration, p.headquarters,
    p.financial_year_end_month, p.data_reporting_frequency, p.currency, p.company_description, p.referral,
    p.net_zero_target_year, p.net_zero_target_reduction_pct, p.baseline_period_start, p.baseline_period_end,
    p.baseline_scope1_tco2e, p.baseline_scope2_tco2e, p.baseline_scope3_tco2e, p.baseline_total_tco2e,
    p.scope1_interim_year, p.scope1_interim_reduction_pct, p.scope2_interim_year, p.scope2_interim_reduction_pct,
    p.scope3_interim_year, p.scope3_interim_reduction_pct,
    p.registered_address_line1, p.registered_address_line2, p.registered_city, p.registered_region,
    p.registered_postcode, p.registered_country,
    p.billing_same_as_registered, p.billing_company, p.billing_address_line1, p.billing_address_line2,
    p.billing_city, p.billing_region, p.billing_postcode, p.billing_country,
    p.parent_company, p.group_structure, p.reporting_frameworks, p.certifications, p.primary_scope3_categories
  );

COMMIT;
