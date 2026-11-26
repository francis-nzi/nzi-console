-- 0237 A drift check after a bring-in (Datasets Part 2, increment 2: "After bring-in, run a drift check on the job").
--
-- 0236's checks run from the Admin list, just before a publish, and nightly. A job brought in from the previous system is now checked
-- straight after, so its banner and the publish gate read a check made against what was just brought in. The check is stored as
-- 0236 stores every check; only its trigger is new: 'bring-in'.
--
-- One CHECK widened; no row is touched, and the table stays append-only.

BEGIN;

ALTER TABLE nzi_console.v7_drift_checks DROP CONSTRAINT v7_drift_checks_trigger_check;
ALTER TABLE nzi_console.v7_drift_checks ADD CONSTRAINT v7_drift_checks_trigger_check
  CHECK (trigger IN ('admin', 'publish', 'nightly', 'bring-in'));

COMMIT;
