-- 0088 — Which tours a person has already been shown.
--
-- A tour runs itself once, the first time someone opens a page, and is replayable on demand
-- from the help drawer. This is the "already seen it" record that makes the first half true.
--
-- ── WHY THE SERVER AND NOT THE BROWSER ───────────────────────────────────────────────────
--
-- Per-viewer conveniences live in `localStorage` in this app, and deliberately so. This one
-- cannot: it is per *person*, not per device. A consultant who saw the client-workspace tour
-- on their laptop should not be taught it again on their tablet, and browser storage clears.
-- That is the whole reason this table exists — cross-device, not governance.
--
-- ── KEYED ON THE TOUR **AND ITS VERSION** ────────────────────────────────────────────────
--
-- The primary key includes `tour_version`, which is the point: a materially revised tour has
-- no row for anyone, so it surfaces again for people who saw the old one. Keying on the tour
-- alone would silently suppress a rewritten tour for exactly the people who most need the
-- new version — the ones already using the page.
--
-- Bumping the version is therefore a deliberate act meaning "this is worth showing again".
-- A typo fix does not need one; a changed workflow does.
--
-- ── SCOPE AND PERMISSION ─────────────────────────────────────────────────────────────────
--
-- Scoped to the NZI organisation like everything else, and to the user within it. There is
-- no capability: this is a person's own UI state, and recording that you have seen something
-- is not an act anyone needs permission for. It is written through a narrow route that takes
-- the user from the verified session and never from the request body, so one person can only
-- ever record their own. See NZC-082 for why this sits outside the command layer.

BEGIN;

CREATE TABLE nzi_console.help_tour_seen (
  organisation_id text NOT NULL REFERENCES nzi_console.organisations(organisation_id),
  /* The staff user, from the session. Never supplied by a caller. */
  user_id text NOT NULL,
  tour_id text NOT NULL,
  /* Part of the key on purpose: a bumped version has no row, so the tour runs again. */
  tour_version integer NOT NULL CHECK (tour_version > 0),
  seen_at timestamptz NOT NULL DEFAULT now(),
  /* Whether they asked not to be shown it again, as opposed to simply having finished it.
     Both suppress the auto-run; only one of them is a preference, and a future "reset my
     tours" needs to be able to tell them apart. */
  dismissed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organisation_id, user_id, tour_id, tour_version)
);

CREATE INDEX help_tour_seen_user_idx ON nzi_console.help_tour_seen (organisation_id, user_id);

COMMENT ON TABLE nzi_console.help_tour_seen IS
  'Which product tours a person has been shown. Per user rather than per device, which is why it is here and not in browser storage. Keyed on tour AND version, so a materially revised tour surfaces again instead of being silently suppressed for the people who saw the old one.';
COMMENT ON COLUMN nzi_console.help_tour_seen.dismissed IS
  'True when the person asked not to see it again, false when they simply reached the end. Both stop the auto-run; only one is a preference.';

ALTER TABLE nzi_console.help_tour_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE nzi_console.help_tour_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nzi_console.help_tour_seen
  USING (organisation_id = current_setting('app.organisation_id', true))
  WITH CHECK (organisation_id = current_setting('app.organisation_id', true));

/* Recorded and read. UPDATE is granted for the one legitimate change — finishing a tour you
   had previously dismissed, or dismissing one you had finished — which is an upsert on the
   same key rather than a second row. DELETE is revoked: nothing here needs removing, and a
   future "show me the tours again" is a new version, not an erased record. */
GRANT SELECT, INSERT, UPDATE ON nzi_console.help_tour_seen TO nzi_console_app;
REVOKE DELETE ON nzi_console.help_tour_seen FROM nzi_console_app;
REVOKE DELETE ON nzi_console.help_tour_seen FROM PUBLIC, nzi_console_worker, nzi_console_auth;

COMMIT;
