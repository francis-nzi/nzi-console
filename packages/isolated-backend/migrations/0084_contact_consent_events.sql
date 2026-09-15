-- 0084 — Recording that a contact may be emailed, with who said so and on what basis.
--
-- `0083` added `client_contacts.email_consent`, defaulting to `unknown`, which blocks.
-- Nothing could move it except a hand-edit in the database — which is precisely the thing
-- that must not be how a client comes to be emailed. This is production gate (a): a governed
-- control, and a record of every decision behind the state.
--
-- **The column stays the state; this table is the history.** The worker reads
-- `client_contacts.email_consent` at send time and must keep doing so — a single indexed
-- column it can check per contact, not a history it would have to reduce. This table answers
-- the other question: who recorded that, when, and on what basis.
--
-- **Append-only, so a withdrawal supersedes and never erases.** UPDATE and DELETE are revoked.
-- A contact who granted consent in March and withdrew it in September has both rows: the
-- current state is the latest, and the earlier one still evidences what was true when the
-- mail went out. Deleting it would destroy the only proof that a past send was permitted.
--
-- No new capability. `contact.manage` is already held by exactly Admin and Consultant, and
-- by neither Finance nor Viewer — the holders this control needs — so the matrix is unchanged
-- and stays at version 3.

BEGIN;

CREATE TABLE nzi_console.client_contact_consent_events (
  organisation_id text NOT NULL,
  consent_event_id text NOT NULL,
  contact_id text NOT NULL,
  client_id text NOT NULL,
  /* Per-contact sequence. The current state is the highest version, so a reader never has to
     resolve two rows by timestamp — and two concurrent recordings cannot both claim to be
     the latest, because the primary key refuses it. */
  version integer NOT NULL CHECK (version > 0),
  /* Only a decision is recordable. Moving a contact *back* to `unknown` is not a decision
     anyone makes; it is the absence of one, and the absence is already the default. */
  state text NOT NULL CHECK (state IN ('granted','declined')),
  /* What it was before, so the history reads without recomputing it from the row before. */
  previous_state text NOT NULL CHECK (previous_state IN ('unknown','granted','declined')),
  /* `portal-self-serve` is reserved here for phase 2 — the contact recording their own
     consent, which is the most defensible basis. Phase 1 does not write it: the staff
     console cannot claim a client acted on their own behalf. */
  basis text NOT NULL CHECK (basis IN ('consultant-recorded','imported','portal-self-serve')),
  note text NOT NULL DEFAULT '',
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, consent_event_id),
  UNIQUE (organisation_id, contact_id, version),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES nzi_console.client_contacts(organisation_id, contact_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES nzi_console.clients(organisation_id, client_id)
);

CREATE INDEX client_contact_consent_events_contact_idx
  ON nzi_console.client_contact_consent_events (organisation_id, contact_id, version DESC);
CREATE INDEX client_contact_consent_events_client_idx
  ON nzi_console.client_contact_consent_events (organisation_id, client_id);

COMMENT ON TABLE nzi_console.client_contact_consent_events IS
  'Every recorded decision about whether a contact may be emailed by automations: the state, what it was before, who recorded it, when, and on what basis. Append-only — a withdrawal supersedes the previous decision and never erases it, because an earlier grant is the evidence that an earlier send was permitted.';
COMMENT ON COLUMN nzi_console.client_contact_consent_events.basis IS
  'How the decision reached NZI. consultant-recorded and imported are staff-recorded; portal-self-serve is reserved for phase 2, when the contact records their own.';

ALTER TABLE nzi_console.client_contact_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.client_contact_consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.client_contact_consent_events
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

-- Recorded and read, never rewritten. The revokes are the deactivate-not-delete rule in the
-- database rather than in the command that happens to be calling today.
GRANT SELECT, INSERT ON nzi_console.client_contact_consent_events TO nzi_console_app;
REVOKE UPDATE ON nzi_console.client_contact_consent_events FROM nzi_console_app;
REVOKE DELETE ON nzi_console.client_contact_consent_events FROM nzi_console_app;
REVOKE UPDATE, DELETE ON nzi_console.client_contact_consent_events FROM PUBLIC, nzi_console_worker, nzi_console_auth;

COMMIT;
