-- 0243 A drift check after the reviewed backfill (DESIGN-backfill-reprice-and-reselect, BF-3, ruled 27 Nov 2026).
--
-- The backfill (R2) re-reads an imported job's months by calendar month, re-prices it, re-derives its datasets and corrects its
-- country, and writes a job only on the owner's approval. Each job it writes is checked against V7 straight after, as a bring-in is
-- (0237). The check is stored as 0236 stores every check; only its trigger is new: 'backfill', so the job's history tells a backfill's
-- check from a person's.
--
-- One CHECK widened; no row is touched, and the table stays append-only.

BEGIN;

ALTER TABLE nzi_console.v7_drift_checks DROP CONSTRAINT v7_drift_checks_trigger_check;
ALTER TABLE nzi_console.v7_drift_checks ADD CONSTRAINT v7_drift_checks_trigger_check
  CHECK (trigger IN ('admin', 'publish', 'nightly', 'bring-in', 'backfill'));

COMMIT;
