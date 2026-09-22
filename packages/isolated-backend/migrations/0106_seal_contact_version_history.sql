-- 0106 Ciphertext for the history of a contact, so that one shred reaches every version of them
-- (NZC-120).
--
-- ## The hole this closes
--
-- 0100 and 0101 sealed the live `client_contacts` row. `client_contact_versions` holds a full snapshot
-- of the same four fields — name, address, job title, phone — one row per edit, in the clear. So
-- shredding a subject's key today would make their *current* details unreadable and leave every
-- previous value of those details sitting beside them. An erasure that reaches the latest version of
-- a person and not the earlier ones has not erased anybody.
--
-- ## Under the live record's key, deliberately
--
-- The snapshot is sealed under the **same subject key as the contact it is a history of**, not a key
-- of its own. One shred then covers the live row and all of its history at once, which is the only
-- arrangement where erasure is a single act rather than a list of places to remember. A per-version
-- key would mean an erasure had to enumerate them, and an enumeration is a thing that can be
-- incomplete.
--
-- ## The whole snapshot, not the personal fields inside it
--
-- `snapshot_json` is one value and nothing in the application reads it — it is written by
-- `recordContactVersion` and never selected — so there is no reader to break by making it opaque, and
-- picking the personal keys out of the blob would mean a second place that has an opinion about which
-- of a contact's fields are personal. The columns that make the row useful as an audit trail —
-- `version`, `changed_by`, `changed_at`, `correlation_id` — stay in the clear. After a shred the row
-- still says that somebody changed this contact, when, and under which correlation; it stops saying
-- what they changed it to. That is what NZC-117 means by history staying intact.
--
-- ## Nullable, and the plaintext stays for now
--
-- Same shape as 0100: the sealed column admits nulls until the backfill has been through, and
-- `snapshot_json` keeps its NOT NULL and keeps being written. Dropping it here would make this the
-- migration that broke the audit trail. It goes in the final step, with the other plaintext columns.

BEGIN;

ALTER TABLE nzi_console.client_contact_versions ADD COLUMN snapshot_sealed jsonb;

COMMENT ON COLUMN nzi_console.client_contact_versions.snapshot_sealed IS
  'The version snapshot, encrypted under the same subject key as the contact it is a history of — so one shred covers the live record and every earlier version of it, rather than leaving the history readable behind an erased present.';

COMMIT;
