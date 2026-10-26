-- 0184 The house email signature, in Organisation settings (email programme phase 5-1, BUILD-email-branded-frame-phase5-1, R3).
--
-- ## Why
--
-- Phase 5-1 closes every templated email with the fixed house signature chrome — Net Zero International, the NZI and CPD
-- Member logos side by side, the website, and the GDPR confidentiality block. Those values belong in Organisation settings —
-- one place, changed without a code change — with the house values as built-in defaults so it is right out of the box. The
-- company name and the website already live on the profile (0142); three are new.
--
-- ## What it adds, to `organisation_profiles`
--
-- - **`email_logo_url`** — the NZI logo, an absolute **https** URL a mail client can fetch with no session. Null: the built-in
--   NZI logo, served publicly from the console's own `/brand/` path. (The logo uploaded for documents is served only to
--   signed-in staff, so a client's mail app could never load it — hence a URL, not that asset.)
-- - **`email_badge_url`** — the badge beside it (the CPD Member badge), likewise https. Null: no badge — it is left out, never
--   drawn as a broken image.
-- - **`email_confidentiality_notice`** — the GDPR confidentiality block that closes every email. Null: the house wording.
--
-- All nullable, nothing backfilled. The application role's UPDATE on the table (0142) covers them.

BEGIN;

ALTER TABLE nzi_console.organisation_profiles
  ADD COLUMN email_logo_url text CHECK (email_logo_url IS NULL OR (email_logo_url ~ '^https://[^\s"<>]+$' AND length(email_logo_url) <= 500)),
  ADD COLUMN email_badge_url text CHECK (email_badge_url IS NULL OR (email_badge_url ~ '^https://[^\s"<>]+$' AND length(email_badge_url) <= 500)),
  ADD COLUMN email_confidentiality_notice text CHECK (email_confidentiality_notice IS NULL
    OR (btrim(email_confidentiality_notice) <> '' AND length(email_confidentiality_notice) <= 1000));

COMMENT ON COLUMN nzi_console.organisation_profiles.email_logo_url IS 'The house email signature''s NZI logo, an absolute https URL fetchable with no session. Null: the built-in NZI logo.';
COMMENT ON COLUMN nzi_console.organisation_profiles.email_badge_url IS 'The badge beside it in the signature (the CPD Member badge), an absolute https URL. Null: no badge.';
COMMENT ON COLUMN nzi_console.organisation_profiles.email_confidentiality_notice IS 'The GDPR confidentiality block that closes every templated email. Null: the house wording.';

COMMIT;
