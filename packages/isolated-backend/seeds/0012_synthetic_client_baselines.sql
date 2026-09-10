BEGIN;

SET search_path TO nzi_console, public;

-- Baseline records for the synthetic demonstrator clients (NZC-065).
--
-- On staging these three already exist: migration 0061 carried them across from
-- the `clients.baseline_*` columns it retired. This seed is for a database built
-- from scratch, where 0061 ran before seed 0011 had anything to carry — hence
-- ON CONFLICT DO NOTHING rather than an upsert, so it never contradicts a record
-- a consultant has since re-based.
--
-- Typed figures, so `declared`. Live baseline data is deliberately not seeded
-- anywhere (MODEL_FIDELITY_BASELINE.md §5).
--
-- The states worth exercising:
--   bushy-tails    an assured-looking initial baseline, earlier than the current job
--   verdant-foods  re-based once, so the resolver has to pick by effective_from
--                  and the superseded record has to stay resolvable
--   harbourline    initial baseline in its own reporting year (job IS its own baseline)
--   cedar-crane    no baseline at all — a net-zero commitment with no base year agreed
--   quaymed        onboarding, nothing set

INSERT INTO client_baselines (
  organisation_id, baseline_id, client_id, period_start, period_end,
  scope1_tco2e, scope2_tco2e, scope3_tco2e, total_tco2e,
  kind, source, reason, set_by, set_at, effective_from, superseded_at
) VALUES
  ('demo-nzi-console', 'bl-bushy-tails-2022', 'bushy-tails',
   DATE '2022-04-01', DATE '2023-03-31', 612.4, 488.9, 741.3, 1842.6,
   'initial', 'declared', NULL, 'demo-admin', now(), DATE '2022-04-01', NULL),

  -- Superseded: kept so a report issued against it can still reproduce itself.
  ('demo-nzi-console', 'bl-verdant-foods-2021', 'verdant-foods',
   DATE '2021-10-01', DATE '2022-09-30', 2980.0, 2210.0, 3960.0, 9150.0,
   'initial', 'declared', NULL, 'demo-admin', now() - interval '2 years', DATE '2021-10-01',
   now() - interval '20 days'),

  ('demo-nzi-console', 'bl-verdant-foods-2023', 'verdant-foods',
   DATE '2023-10-01', DATE '2024-09-30', 3120.5, 2044.75, 4045.2, 9210.45,
   'rebaseline', 'declared',
   'Acquired the Avonmouth cold store and brought the leased distribution fleet in-house; the 2021 base year no longer represents the operating boundary.',
   'demo-admin', now() - interval '20 days', DATE '2023-10-01', NULL),

  ('demo-nzi-console', 'bl-harbourline-2022', 'harbourline-logistics',
   DATE '2022-01-01', DATE '2022-12-31', 14208.35, 1187.6, 3004.05, 18400.0,
   'initial', 'declared', NULL, 'demo-admin', now(), DATE '2022-01-01', NULL)
ON CONFLICT (organisation_id, baseline_id) DO NOTHING;

-- A base-year recalculation policy has to state a significance threshold; 5% is the
-- common SBTi/GHG Protocol figure and is what these demonstrator clients declare.
UPDATE clients SET baseline_significance_threshold_pct = 5
WHERE organisation_id = 'demo-nzi-console'
  AND client_id IN ('bushy-tails', 'verdant-foods', 'harbourline-logistics')
  AND baseline_significance_threshold_pct IS DISTINCT FROM 5;

COMMIT;
