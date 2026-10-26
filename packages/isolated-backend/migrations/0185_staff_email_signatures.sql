-- 0185 A member of staff's email signature (email programme phase 5-2, BUILD-email-signatures-phase5-2, R1–R4).
--
-- ## Why
--
-- 5-1 closes every templated email with the organisation's fixed house chrome. 5-2 adds the personal lines above it on an
-- email attributed to a member — Kind regards · name · title · Email · Mobile UK — from that member's record, which the
-- member edits themselves on their account page. The name is the record's own (`display_name`); the rest is new.
--
-- ## What it adds, to `memberships` (the staff record — Team & access's roster, 0141)
--
-- - **`signature_title`** — their title as it should read. Null: their position's label.
-- - **`signature_email`** — the address the signature shows. Null: their work email.
-- - **`signature_mobile`** — shown as "Mobile UK". Null: no mobile line.
-- - **`signature_sign_off`** — null: "Kind regards". Not personal data: a phrase, not a fact about the person.
--
-- The title, address and mobile are personal data, so each has its ciphertext beside it (NZC-119), sealed under the
-- member's own key in the same transaction as the write (`sealMembershipRow`), and is in the PII inventory — so export and
-- erasure reach them like the record's name and email. No photos (Francis, 26 Oct), so no image column.
--
-- All nullable, nothing backfilled. The application role's table-level UPDATE on `memberships` (0002) covers the columns;
-- the member's own edit goes through `updateOwnStaffSignature`, which writes only the signed-in member's row, bumps the
-- record's `version` and is audited by field name — never a value.

BEGIN;

ALTER TABLE nzi_console.memberships
  ADD COLUMN signature_title text CHECK (signature_title IS NULL OR (btrim(signature_title) <> '' AND length(signature_title) <= 120)),
  ADD COLUMN signature_title_sealed jsonb,
  ADD COLUMN signature_email text CHECK (signature_email IS NULL OR (length(signature_email) <= 254 AND signature_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  ADD COLUMN signature_email_sealed jsonb,
  ADD COLUMN signature_mobile text CHECK (signature_mobile IS NULL OR signature_mobile ~ '^[0-9+() .-]{5,30}$'),
  ADD COLUMN signature_mobile_sealed jsonb,
  ADD COLUMN signature_sign_off text CHECK (signature_sign_off IS NULL
    OR (btrim(signature_sign_off) <> '' AND length(signature_sign_off) <= 60 AND signature_sign_off !~ '[\r\n]'));

COMMENT ON COLUMN nzi_console.memberships.signature_title IS 'The email signature''s title line (5-2). Null: the position''s label. Sealed beside it.';
COMMENT ON COLUMN nzi_console.memberships.signature_email IS 'The email signature''s Email line (5-2). Null: the work email. Sealed beside it.';
COMMENT ON COLUMN nzi_console.memberships.signature_mobile IS 'The email signature''s Mobile UK line (5-2). Null: no mobile line. Sealed beside it.';
COMMENT ON COLUMN nzi_console.memberships.signature_sign_off IS 'The email signature''s sign-off (5-2). Null: Kind regards.';

COMMIT;
