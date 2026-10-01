-- 0144 The trainee's own record can show a pending sign-in change (a narrow, column-level read).
--
-- ## The defect
--
-- `getTraineePortal` — behind `/api/trainee/training` (the trainee's record page) and `/api/trainee/export` (their
-- data export) — runs as `nzi_console_app` and reads the person's pending sign-in change from
-- `trainee_email_changes`. 0072 deliberately revoked every privilege on that table from the app role ("credentials
-- and sessions belong to the auth role alone"), and 0002's blanket grant predates the table, so the read is refused
-- with "permission denied for table trainee_email_changes" on every database: the record page and the export fail
-- as built. Found while testing D3b.
--
-- ## The fix, and why it is column-level
--
-- 0072's reason for the revoke still holds for most of the row: `token_hash` is what confirms a change (holding it
-- is half of proving the address), and `current_email` and the sealed / blind-index columns are the auth realm's to
-- handle. What the record page needs is narrower than the row — "you have asked to change your sign-in to X, and it
-- is not confirmed yet". So the grant is `SELECT` on exactly the columns that read uses:
--
--   organisation_id   the tenant policy's column
--   trainee_id        whose change it is
--   new_email         the address shown to the person ("pending: X")
--   confirmed_at, cancelled_at, expires_at, requested_at   whether it is still pending, and the latest one
--
-- ## And a change the person cancelled is not pending
--
-- The read also excluded only confirmed and expired changes, so a change the person cancelled went on showing as
-- "pending" until it expired. The read now requires `cancelled_at IS NULL` too, which is why `cancelled_at` is the
-- seventh column here.
--
-- No `INSERT`, `UPDATE` or `DELETE` — a change is still requested, confirmed and cancelled only through the auth
-- role. No access to `token_hash`, `current_email`, `change_id` or the sealed and index columns. Row-level
-- security (0072, FORCE) is unchanged, so the read stays confined to the tenant.
--
-- `new_email` is still plaintext ("awaiting-auth-bridge" in the PII inventory); when it moves to its sealed column,
-- this grant moves with the read.

BEGIN;

GRANT SELECT (organisation_id, trainee_id, new_email, confirmed_at, cancelled_at, expires_at, requested_at)
  ON nzi_console.trainee_email_changes TO nzi_console_app;

COMMIT;
