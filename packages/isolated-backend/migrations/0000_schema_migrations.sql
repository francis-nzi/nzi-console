-- 0000 — the migration ledger.
--
-- Numbered 0000 so it sorts first and is simply the first pending migration: no bootstrap
-- special case, no chicken-and-egg. It creates the schema too, because `0001` does that and
-- this has to be able to run before it on an empty database.
--
-- Deliberately has NO `BEGIN`/`COMMIT` of its own. The runner wraps a file that does not
-- manage its own transaction, which lets it create this table and record the row that says
-- so in **one** transaction — the only way the ledger's very first entry can be atomic.
--
-- Entirely idempotent, so it is safe against staging, which already has every object
-- through 0077 and needs only the ledger and a baseline.
--
-- Why this table is not tenant data: a migration is a fact about the *database*, not about
-- any organisation in it. There is no `organisation_id` to scope by and no RLS policy to
-- write. It is also granted to nobody: the application roles have no business reading or
-- writing deployment history, and the runner connects as the owner.

CREATE SCHEMA IF NOT EXISTS nzi_console;

CREATE TABLE IF NOT EXISTS nzi_console.schema_migrations (
  filename text PRIMARY KEY,
  /* sha256 of the file as applied. A migration edited after it was applied is then
     detectable — which is exactly the drift that put a stale 0072 on staging and went
     unnoticed until the objects it should have created turned out to be missing. */
  checksum text NOT NULL CHECK (nullif(trim(checksum), '') IS NOT NULL),
  applied_at timestamptz NOT NULL DEFAULT now(),
  /* Who or what applied it: a person, or `migrate:<command>`. */
  applied_by text NOT NULL,
  /* True for rows written by `migrate baseline` — an assertion that the file had already
     been applied by hand before the ledger existed, rather than evidence that this runner
     applied it. Weaker provenance, and said so rather than blurred into the same thing. */
  baselined boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE nzi_console.schema_migrations IS
  'One row per applied migration. Not tenant data: a migration is a fact about the database, not about an organisation in it. Written only by the migrate runner.';
COMMENT ON COLUMN nzi_console.schema_migrations.checksum IS
  'sha256 of the migration file as applied. A mismatch means the file changed after it ran — the runner refuses rather than guessing which version the database holds.';
COMMENT ON COLUMN nzi_console.schema_migrations.baselined IS
  'True where the row asserts a pre-ledger hand-apply rather than recording one this runner performed.';
