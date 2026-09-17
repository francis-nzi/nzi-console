-- 0090 Client identity fields become references (NZC-090).
--
-- `sector`, `referral` and `client_manager` hold free text chosen from nothing; since 0089 the
-- curated lists exist, and the Add-client form now picks from them. This carries the columns the
-- rest of the way: the chosen value becomes an id, so renaming "Manufacturing" in the lookup
-- renames it on every client that chose it, instead of leaving 40 copies of a word behind.
--
-- ## Additive, with the text kept
--
-- The existing text columns stay and keep their values. A client whose industry does not match
-- anything in the curated list still shows the industry it was given — the backfill reports it
-- rather than blanking it, because a client's recorded industry is data the firm entered, not a
-- cache to be invalidated. The read resolves the id when there is one and falls back to the text
-- when there is not, so nothing on a client record goes blank on the day this lands.
--
-- ## The owner column is not touched here
--
-- `clients.owner_user_id` already exists (0066) and is what `own_clients` resolves against: it
-- decides which staff can see which clients. The backfill may **populate it where it is null** and
-- the name matches exactly one person; it must never **change** one that is already set, and this
-- migration adds no mechanism that could. Re-pointing an owner is a permission act — a person's
-- decision, audited as such — and a name-matching script is not the place for it. Disagreements
-- between `owner_name` and `owner_user_id` are reported for a human to settle.

SET search_path = nzi_console;

BEGIN;

-- `value_id` is already unique within an organisation by construction — it is built as
-- "<category>:<slug>" — so a unique constraint costs nothing and buys real referential integrity
-- for the columns below. The alternative was carrying a redundant category column on `clients`
-- beside each reference, three times over, purely to satisfy a composite foreign key.
ALTER TABLE nzi_console.reference_values
  ADD CONSTRAINT reference_values_org_value_unique UNIQUE (organisation_id, value_id);

ALTER TABLE nzi_console.clients
  ADD COLUMN sector_value_id text,
  ADD COLUMN referral_value_id text,
  ADD COLUMN client_manager_user_id text;

ALTER TABLE nzi_console.clients
  ADD CONSTRAINT clients_sector_reference_fk
    FOREIGN KEY (organisation_id, sector_value_id)
    REFERENCES nzi_console.reference_values (organisation_id, value_id),
  ADD CONSTRAINT clients_referral_reference_fk
    FOREIGN KEY (organisation_id, referral_value_id)
    REFERENCES nzi_console.reference_values (organisation_id, value_id),
  -- Mirrors clients_owner_membership_fk from 0066: a client manager is a member of this
  -- organisation, and the database says so rather than the application remembering to.
  ADD CONSTRAINT clients_manager_membership_fk
    FOREIGN KEY (organisation_id, client_manager_user_id)
    REFERENCES nzi_console.memberships (organisation_id, user_id);

CREATE INDEX clients_manager_idx ON nzi_console.clients (organisation_id, client_manager_user_id)
  WHERE client_manager_user_id IS NOT NULL;

COMMIT;
