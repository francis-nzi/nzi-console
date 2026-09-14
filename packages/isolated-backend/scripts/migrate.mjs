// The migration runner.
//
// Replaces hand-applying SQL, which failed three separate ways before this existed: a
// merged migration never applied at all (drift), a file edited after it had been applied
// (a stale 0072), and a 26 KB paste that corrupted mid-file and threw a parse error the
// file never contained. All three are invisible to a process that has no record of what
// the database actually holds.
//
//   node scripts/migrate.mjs status      — read-only: what is applied, what is pending
//   node scripts/migrate.mjs up          — apply pending migrations, in order
//   node scripts/migrate.mjs baseline <filename>
//                                        — record files up to <filename> as already
//                                          applied, without running them. For a database
//                                          that predates the ledger.
//
// Environment: NZI_ISOLATED_DATABASE_URL, and the same boundary guard every other script
// carries — this can only ever point at the isolated non-production database.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LEDGER = "nzi_console.schema_migrations";

/* ── Guards ──────────────────────────────────────────────────────────────────────────── */

function connectionString() {
  if (process.env.NEXT_PUBLIC_APP_ENV === "production" || process.env.NZI_DATABASE_BOUNDARY !== "isolated-non-production") {
    throw new Error("Only the confirmed isolated non-production database is allowed.");
  }
  const url = process.env.NZI_ISOLATED_DATABASE_URL;
  if (!url) throw new Error("NZI_ISOLATED_DATABASE_URL is required.");
  return url;
}

/**
 * A database that may be dropped and rebuilt.
 *
 * Lives here rather than in the test that needs it so there is one implementation, not a
 * copy in the test asserting that a different copy is correct. The migrations test DROPs the
 * schema: correct for a throwaway database, catastrophic for any other, and one mistyped
 * environment variable apart. A wiped staging would look like a passing test.
 */
export function assertDisposable(url, isolatedUrl) {
  const name = new URL(url).pathname.replace(/^\//, "");
  // Word-bounded, so 'latest' and 'precise' do not qualify on a substring.
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(
      `Refusing to run: this drops the nzi_console schema, and '${name}' is not named as a disposable database. ` +
      `Name it something containing 'ci', 'test', 'tmp' or 'throwaway'.`,
    );
  }
  if (isolatedUrl && isolatedUrl === url) {
    throw new Error("Refusing to run: the test database is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

/* ── Files ───────────────────────────────────────────────────────────────────────────── */

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * Every migration, in apply order.
 *
 * Sorted by filename, NOT by parsed number: the numbering has real gaps (61 and 65 are
 * unused), so "the next number" is not a thing that exists. Order is the sequence the files
 * sort into, and nothing else.
 */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      return {
        filename,
        sql,
        checksum: sha256(sql),
        // A file with its own BEGIN/COMMIT runs as-is; one without gets wrapped by the
        // runner, which is what lets its ledger row be written in the same transaction.
        selfTransacting: /^\s*BEGIN\s*;/im.test(sql) && /^\s*COMMIT\s*;/im.test(sql),
      };
    });
}

/* ── Ledger ──────────────────────────────────────────────────────────────────────────── */

async function ledgerExists(client) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS present`, [LEDGER],
  );
  return rows[0].present === true;
}

async function appliedRows(client) {
  if (!await ledgerExists(client)) return new Map();
  const { rows } = await client.query(
    `SELECT filename, checksum, applied_at, applied_by, baselined FROM ${LEDGER}`,
  );
  return new Map(rows.map((row) => [row.filename, row]));
}

/**
 * What the ledger and the files say about each other.
 *
 * Two refusals live here, and both exist because the alternative is a database whose real
 * state nobody can state:
 *
 *   A **gap** — an unapplied file that sorts before an applied one. Migrations are ordered
 *   because later ones assume earlier ones ran; filling a hole afterwards runs it against a
 *   schema it was never written for.
 *
 *   A **checksum mismatch** — the file changed after it was applied. The runner cannot know
 *   whether the database holds the old version or the new, so it refuses rather than
 *   guessing. This is the 0072 case.
 */
export function reconcile(files, applied) {
  const pending = files.filter((file) => !applied.has(file.filename));
  const drifted = files
    .filter((file) => applied.has(file.filename) && applied.get(file.filename).checksum !== file.checksum)
    .map((file) => ({ filename: file.filename, recorded: applied.get(file.filename).checksum, actual: file.checksum }));

  const lastAppliedIndex = files.reduce((last, file, index) => applied.has(file.filename) ? index : last, -1);
  const gaps = pending.filter((file) => files.indexOf(file) < lastAppliedIndex).map((file) => file.filename);

  // A row in the ledger with no file behind it: the file was deleted or renamed after it
  // was applied, which is the same unanswerable question as a checksum mismatch.
  const known = new Set(files.map((file) => file.filename));
  const orphans = [...applied.keys()].filter((filename) => !known.has(filename));

  return { pending, drifted, gaps, orphans };
}

/**
 * Is this an existing database that has never been baselined?
 *
 * The one-time adoption case. A database that predates the ledger has every object already
 * and no history recorded, so the runner would try to apply from `0001` and fail on
 * "relation already exists" — safe, but the error says nothing about what to actually do.
 * It happened on staging, and the next person to hit it deserves the answer rather than the
 * symptom.
 *
 * `0000` is discounted because the ledger migration creates itself: its presence says
 * nothing about whether the rest of the schema was recorded.
 */
export function needsBaseline(recordedFilenames, existingTableCount) {
  const realHistory = [...recordedFilenames].filter((name) => !name.startsWith("0000_"));
  return realHistory.length === 0 && existingTableCount > 0;
}

export function refuseOn({ drifted, gaps, orphans }) {
  const problems = [];
  if (gaps.length) {
    problems.push(
      `Out-of-order migrations. These are unapplied but sort before something that IS applied:\n` +
      gaps.map((name) => `    ${name}`).join("\n") +
      `\n  Later migrations assume earlier ones ran, so filling the hole now would run them against a schema they were not written for.`,
    );
  }
  if (drifted.length) {
    problems.push(
      `Migration files changed after they were applied:\n` +
      drifted.map((entry) => `    ${entry.filename}\n      recorded ${entry.recorded}\n      on disk  ${entry.actual}`).join("\n") +
      `\n  The database may hold either version and there is no way to tell from here. A migration is frozen once applied — the change belongs in a new one.`,
    );
  }
  if (orphans.length) {
    problems.push(
      `Applied migrations with no file on disk (deleted or renamed):\n` +
      orphans.map((name) => `    ${name}`).join("\n"),
    );
  }
  if (problems.length) throw new Error(`Refusing to run.\n\n  ${problems.join("\n\n  ")}\n`);
}

/* ── Commands ────────────────────────────────────────────────────────────────────────── */

async function status(client) {
  const files = migrationFiles();
  const applied = await appliedRows(client);
  const { pending, drifted, gaps, orphans } = reconcile(files, applied);

  if (!await ledgerExists(client)) {
    console.log(`No ledger yet (${LEDGER} does not exist).`);
    console.log(`  ${files.length} migrations on disk, none recorded.`);
    console.log(`  A database that predates the ledger needs 'baseline <last-applied>' first,`);
    console.log(`  so that already-applied files are not run a second time.`);
    return;
  }

  // Said here too, because status is where someone looks before they run anything.
  if (needsBaseline([...applied.keys()], await schemaTableCount(client))) {
    console.log("This looks like an existing database that has never been baselined.");
    console.log(`  ${files.length} migrations on disk; the schema has tables, but the ledger records none.`);
    console.log(`  Record its history first:  npm run migrate:baseline ${files[files.length - 1].filename}`);
    return;
  }

  console.log(`${applied.size} applied, ${pending.length} pending, ${files.length} on disk.`);
  const baselined = [...applied.values()].filter((row) => row.baselined).length;
  if (baselined) console.log(`  ${baselined} of the applied rows are baselined (asserted, not run by this runner).`);

  if (pending.length) {
    console.log(`\nPending:`);
    for (const file of pending) console.log(`  ${file.filename}`);
  }
  for (const [label, list] of [["Out of order", gaps], ["Checksum mismatch", drifted.map((d) => d.filename)], ["No file on disk", orphans]]) {
    if (list.length) console.log(`\n${label}:\n${list.map((name) => `  ${name}`).join("\n")}`);
  }
  if (!pending.length && !gaps.length && !drifted.length && !orphans.length) console.log(`\nUp to date.`);
}

/** Tables in the schema other than the ledger itself. */
async function schemaTableCount(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS present FROM information_schema.tables
     WHERE table_schema = 'nzi_console' AND table_name <> 'schema_migrations'`);
  return rows[0].present;
}

async function up(client, actor) {
  const files = migrationFiles();
  const applied = await appliedRows(client);

  // Before anything else: an existing database that was never baselined would otherwise be
  // "applied" from 0001 and fail on "already exists". That is safe but unhelpful.
  if (needsBaseline([...applied.keys()], await schemaTableCount(client))) {
    const last = files[files.length - 1].filename;
    throw new Error(
      `This looks like an existing database that has never been baselined.\n\n` +
      `  The schema already has tables, but the ledger records no migrations — so applying\n` +
      `  from the start would fail on objects that are already there.\n\n` +
      `  If this database is up to date, record its history first:\n` +
      `    npm run migrate:baseline ${last}\n\n` +
      `  Then 'npm run migrate' will apply only what is genuinely pending.\n`,
    );
  }

  const state = reconcile(files, applied);
  refuseOn(state);

  if (state.pending.length === 0) {
    console.log("Up to date — nothing to apply.");
    return;
  }
  console.log(`Applying ${state.pending.length} migration(s).`);

  for (const file of state.pending) {
    const record = `INSERT INTO ${LEDGER} (filename, checksum, applied_by) VALUES ($1, $2, $3)`;
    if (file.selfTransacting) {
      // The file opens and commits its own transaction, so the ledger row cannot join it.
      // If the process dies in the gap between the two, the migration is applied but
      // unrecorded — so say exactly how to repair it rather than leaving a puzzle.
      await client.query(file.sql);
      try {
        await client.query(record, [file.filename, file.checksum, actor]);
      } catch (error) {
        throw new Error(
          `${file.filename} APPLIED but the ledger row failed to write: ${error.message}\n` +
          `  Repair with:\n    INSERT INTO ${LEDGER} (filename, checksum, applied_by) VALUES ('${file.filename}', '${file.checksum}', '${actor}');\n` +
          `  Do not re-run the migration — it has already been applied.`,
        );
      }
    } else {
      // No transaction control of its own: the runner wraps it, so the change and the row
      // that records it land together or not at all.
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query(record, [file.filename, file.checksum, actor]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`${file.filename} failed and was rolled back: ${error.message}`);
      }
    }
    console.log(`  Applied ${file.filename}`);
  }
  console.log("Done.");
}

/**
 * Record history for a database that predates the ledger.
 *
 * Asserts that every file up to and including `through` has already been applied. It runs
 * none of them — that is the whole point — so it is only ever correct if someone has
 * actually verified the database matches. Refuses if the ledger already has rows, because
 * baselining twice would paper over exactly the drift this is meant to expose.
 */
async function baseline(client, through, actor) {
  const files = migrationFiles();
  const index = files.findIndex((file) => file.filename === through);
  if (index === -1) throw new Error(`No migration named ${through}. Pass the filename of the last one already applied.`);

  const applied = await appliedRows(client);
  const recordable = files.slice(0, index + 1).filter((file) => !applied.has(file.filename));
  if (applied.size > 0 && recordable.length === files.slice(0, index + 1).length) {
    throw new Error("The ledger already has rows. Baselining is for a database that predates it; use 'status' to see where things stand.");
  }
  if (recordable.length === 0) {
    console.log("Nothing to baseline — every migration up to that point is already recorded.");
    return;
  }

  // The ledger itself has to exist before anything can be written into it.
  if (!await ledgerExists(client)) {
    const ledgerFile = files[0];
    await client.query(ledgerFile.sql);
    console.log(`  Created the ledger (${ledgerFile.filename}).`);
  }

  await client.query("BEGIN");
  try {
    for (const file of recordable) {
      await client.query(
        `INSERT INTO ${LEDGER} (filename, checksum, applied_by, baselined) VALUES ($1, $2, $3, true)
         ON CONFLICT (filename) DO NOTHING`,
        [file.filename, file.checksum, actor],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  console.log(`Baselined ${recordable.length} migration(s), ${files[0].filename} through ${through}.`);
  console.log("These are recorded as asserted, not as run by this runner.");
}

/* ── Entry ───────────────────────────────────────────────────────────────────────────── */

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await runCli();

async function runCli() {
const [command = "status", argument] = process.argv.slice(2);
const actor = `migrate:${command}${process.env.USER || process.env.USERNAME ? ` (${process.env.USER ?? process.env.USERNAME})` : ""}`;
const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  if (command === "status") await status(client);
  else if (command === "up") await up(client, actor);
  else if (command === "baseline") {
    if (!argument) throw new Error("baseline needs the filename of the last already-applied migration, e.g. 0077_report_compositions.sql");
    await baseline(client, argument, actor);
  } else throw new Error(`Unknown command '${command}'. Use status, up, or baseline <filename>.`);
} finally {
  await client.end();
}
}
