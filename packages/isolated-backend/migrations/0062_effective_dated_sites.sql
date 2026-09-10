BEGIN;

ALTER TABLE nzi_console.client_sites
  ADD COLUMN is_registered_office boolean NOT NULL DEFAULT false,
  ADD COLUMN in_service_from date NOT NULL DEFAULT current_date,
  ADD COLUMN vacated_effective date,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE nzi_console.client_sites
  ADD CONSTRAINT client_sites_effective_dates CHECK (vacated_effective IS NULL OR vacated_effective >= in_service_from);
CREATE UNIQUE INDEX client_sites_one_registered_office
  ON nzi_console.client_sites (organisation_id, client_id)
  WHERE is_registered_office = true AND archived = false;
COMMENT ON COLUMN nzi_console.client_sites.vacated_effective IS 'The first date the site is no longer in service; the site remains in a reporting boundary for any year it overlaps.';

COMMIT;