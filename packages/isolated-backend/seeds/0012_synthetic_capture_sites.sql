BEGIN;

SET search_path TO nzi_console, public;

-- Sites for the synthetic J000712 demonstrator, so the capture surface's site tabs have something to
-- scope (NZC-147).
--
-- **Name only, deliberately.** `client_sites` carries `address_lines_sealed` and `postcode_sealed`
-- beside its plaintext address columns, because a site address is personal data when the site is
-- somebody's home. This seed gives each site a name and nothing else: no address, no postcode, nothing
-- that would need sealing. A seed that wrote a plaintext address would either break the standing
-- invariant — no row holds personal data without ciphertext beside it — or need the sealing keys, and
-- neither belongs in a fixture whose whole purpose is to be reproducible from nothing.
INSERT INTO client_sites (organisation_id, site_id, client_id, name, created_by)
VALUES
  ('demo-nzi-console','demo-site-bristol','bushy-tails','Bristol depot','demo-admin'),
  ('demo-nzi-console','demo-site-leeds','bushy-tails','Leeds office','demo-admin')
ON CONFLICT (organisation_id, site_id) DO NOTHING;

-- Rows are allocated across the two sites — and **one row is left with no site on purpose**.
--
-- `demo-712-spend` is purchased goods against a spend figure, which is exactly the case that has no
-- honest site allocation: a ledger total is not attributable to a depot without someone deciding it is.
-- It stays unallocated so the capture surface has a row that appears under "All sites" and under no
-- individual site tab, which is the behaviour the register must keep: an unrecorded allocation is never
-- claimed as one. Deleting this row's absence of a site would make the site tabs untestable in the one
-- case they can get wrong.
UPDATE job_scope_rows SET site_id = 'demo-site-bristol'
  WHERE organisation_id = 'demo-nzi-console'
    AND scope_row_id IN ('demo-712-diesel','demo-712-gas','demo-712-fgas','demo-712-freight');

UPDATE job_scope_rows SET site_id = 'demo-site-leeds'
  WHERE organisation_id = 'demo-nzi-console'
    AND scope_row_id IN ('demo-712-electricity','demo-712-air','demo-712-commute','demo-712-waste');

COMMIT;
