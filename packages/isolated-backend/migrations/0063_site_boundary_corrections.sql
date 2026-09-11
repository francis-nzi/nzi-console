BEGIN;

-- NZC-070 corrective pass on 0062.
--
-- 0062 gave every existing site `in_service_from = current_date` — the day the
-- migration ran — which drops every legacy site out of every historical
-- reporting boundary. A NULL start is the open lower bound ("in service from
-- before records"). It is never the migration date and never a guessed job date.
ALTER TABLE nzi_console.client_sites
  ALTER COLUMN in_service_from DROP DEFAULT,
  ALTER COLUMN in_service_from DROP NOT NULL;

-- One term, one meaning: 0035's `active_from` / `vacated_date` were a second
-- lifecycle pair that no command ever wrote. Carry across any value a row does
-- hold (`vacated_date` was the last day on site; `vacated_effective` is the
-- first day out), then drop them. Every other row takes the open lower bound.
UPDATE nzi_console.client_sites SET in_service_from = active_from;
UPDATE nzi_console.client_sites
  SET vacated_effective = vacated_date + 1
  WHERE vacated_effective IS NULL AND vacated_date IS NOT NULL;
ALTER TABLE nzi_console.client_sites
  DROP CONSTRAINT client_sites_active_before_vacated,
  DROP COLUMN active_from,
  DROP COLUMN vacated_date;

COMMENT ON COLUMN nzi_console.client_sites.in_service_from IS 'First day in service. NULL = in service from before records (open lower bound, NZC-070).';
COMMENT ON COLUMN nzi_console.client_sites.vacated_effective IS 'First day OUT of service. In the boundary for a period when in_service_from <= period end and vacated_effective > period start (NZC-070).';

-- A vacated site cannot be the registered office. The commands refuse first
-- (vacating the registered office is blocked until it is reassigned); this is
-- the backstop. At most one per client is 0062's partial unique index.
ALTER TABLE nzi_console.client_sites
  ADD CONSTRAINT client_sites_registered_office_in_service
  CHECK (NOT (is_registered_office AND vacated_effective IS NOT NULL));

-- NZC-070: a scope row at a site outside the reporting boundary is raised as a
-- fifth gap type, which a reviewer may resolve with a reason.
ALTER TABLE nzi_console.gap_resolutions
  DROP CONSTRAINT gap_resolutions_flag_type_check,
  ADD CONSTRAINT gap_resolutions_flag_type_check
  CHECK (flag_type IN ('yoy_movement','completeness','zero_blank','unmapped','out_of_boundary'));

COMMIT;
