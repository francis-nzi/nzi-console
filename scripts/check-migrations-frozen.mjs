#!/usr/bin/env node
/**
 * A migration on main is frozen. Fix forward (NZC-148).
 *
 * ## The rule
 *
 * Once a migration file is on `main`, its bytes never change again. Not the SQL, not a typo, **not a
 * comment**. Something to correct means a new migration, or nothing.
 *
 * ## Why a comment counts, which is the part people get wrong
 *
 * The runner's ledger records a sha256 over the **raw file text**, and refuses to proceed when a file's
 * checksum no longer matches what was applied. It has no notion of "only a comment changed", and should
 * not: a checksum that skipped comments would be a checksum of something other than the file, and the
 * question it answers — *is this the thing that ran?* — would stop having a truthful answer.
 *
 * This is not hypothetical. #263 improved a comment in `0110_factor_category_variants.sql` describing the
 * capability that governs the registry. The file had already been applied to staging. The next deploy
 * refused on the checksum, correctly, and #264 restored the bytes. Nothing was wrong with the sentence;
 * the file was simply no longer ours to edit. That is the incident this gate exists to make impossible,
 * and it was the third of its kind.
 *
 * ## What it compares, and what it deliberately allows
 *
 * Every migration present on the base ref is compared against the working tree, by git rather than by
 * reading bytes (see below). A file that differs fails; a file that has been **deleted** fails, because
 * deleting is the most complete way to change something. A file that exists only in the working tree is a
 * **new** migration and is exactly what fixing forward looks like — those are listed, never refused.
 *
 * The base is `main` rather than "any branch it has appeared on". A migration still open in its own pull
 * request is not yet frozen, and must not be: that is the window in which review comments get addressed.
 * The rule bites the moment it merges. (The standing convention is stricter — a migration applied
 * *anywhere*, staging included, is frozen even before it merges — but nothing this script can read knows
 * what staging has applied, and a gate that guesses would either block legitimate work or report a
 * confidence it does not have.)
 *
 * ## Why it counts what it compared
 *
 * A bad glob, a base ref that resolves to nothing, a rename of the migrations directory: each would make
 * this script compare zero files and exit 0, and the check would be green for the rest of its life having
 * never looked at anything. So the number of files actually compared is asserted against a floor. Because
 * migrations are append-only the floor only ever rises, which means it never needs maintaining — and
 * unlike a count read from the repository at runtime, it cannot agree with itself about a mistake.
 */

import { execFileSync } from "node:child_process";

const DIRECTORY = "packages/isolated-backend/migrations";
const BASE = process.env.MIGRATIONS_FROZEN_BASE ?? "origin/main";

/**
 * The number of migrations that must be compared for this run to mean anything.
 *
 * 109 were on main when this gate was written. Migrations are append-only, so this can only be an
 * understatement — which is the right direction for a floor. Lower it for nothing.
 */
const FLOOR = 109;

const gitText = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const fail = (lines) => {
  console.error(`✗ frozen migrations: ${lines[0]}`);
  for (const line of lines.slice(1)) console.error(`  ${line}`);
  process.exit(1);
};

// ── The base has to exist, and a missing one is a failure rather than a pass ──────────────────────
//
// A shallow clone without the base ref is the shape of problem that would otherwise turn this gate into
// a no-op: nothing to compare against, nothing compared, green.
try {
  gitText("rev-parse", "--verify", `${BASE}^{commit}`);
} catch {
  fail([
    `cannot resolve '${BASE}', so there is nothing to compare against.`,
    "This is a failure and not a skip: a gate that cannot see the base would pass every change.",
    "In CI, fetch it first — `git fetch --no-tags --depth=1 origin main`.",
  ]);
}

const onBase = gitText("ls-tree", "-r", "--name-only", BASE, "--", DIRECTORY)
  .split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".sql"));

/**
 * The comparison is git's, not a byte comparison of what is on disk.
 *
 * The first version of this script read the file with `readFileSync` and compared it to
 * `git show BASE:path`. That is wrong on any checkout where the two legitimately differ, and it fired
 * immediately: `.gitattributes` declares `* text=auto eol=lf`, one file had drifted to CRLF on disk, and
 * so 819 bytes on disk were compared against 804 in the blob for a file `git status` correctly called
 * unmodified. The question this gate asks is "would committing this change the file?", and the only
 * thing that can answer it without reimplementing checkout filters is git.
 */
const status = gitText("diff", "--name-status", "--no-renames", BASE, "--", DIRECTORY)
  .split("\n").map((line) => line.trim()).filter(Boolean);

const changed = [];
const deleted = [];

for (const line of status) {
  const [code, path] = line.split("\t");
  if (!path?.endsWith(".sql")) continue;
  if (code.startsWith("D")) { deleted.push(path); continue; }
  if (code.startsWith("A")) continue; // A new migration is the whole point of fixing forward.
  changed.push({
    path,
    before: gitText("rev-parse", `${BASE}:${path}`).trim().slice(0, 12),
    after: gitText("hash-object", path).trim().slice(0, 12),
  });
}

// Everything on the base that git did not report as changed or deleted was compared and matched.
const compared = onBase.length - deleted.length;

if (deleted.length > 0 || changed.length > 0) {
  const lines = [`${changed.length + deleted.length} migration(s) on ${BASE} were altered.`, ""];
  for (const { path, before, after } of changed) {
    lines.push(`changed: ${path}`, `         ${BASE} blob ${before}… → working tree ${after}…`);
  }
  for (const path of deleted) lines.push(`deleted: ${path}`);
  lines.push(
    "",
    "A migration on main is frozen — its bytes are what the ledger recorded and what staging applied,",
    "and the runner refuses the next deploy on the checksum. That includes comments: the checksum is",
    "over the whole file, which is the only way it can answer whether this is the thing that ran.",
    "",
    "Restore these files and put the change in a NEW migration:",
    `  git checkout ${BASE} -- ${DIRECTORY}`,
    "",
    "If what you wanted to fix was only prose, the places allowed to keep up are the module docblock",
    "and docs/DECISIONS.md — not the applied file.",
  );
  fail(lines);
}

// ── The run has to have examined something ───────────────────────────────────────────────────────
if (compared < FLOOR) {
  fail([
    `only ${compared} migration(s) compared, expected at least ${FLOOR}.`,
    `That is how many '${DIRECTORY}' holds on ${BASE}.`,
    "Migrations are append-only, so this number cannot legitimately fall: the directory has moved, the",
    "glob is wrong, or the base is not what it claims to be. Green here would be meaningless.",
  ]);
}

const added = gitText("ls-files", "--others", "--cached", "--exclude-standard", "--", DIRECTORY)
  .split("\n").map((line) => line.trim())
  .filter((line) => line.endsWith(".sql") && !onBase.includes(line));

const forward = added.length > 0 ? ` · ${added.length} new: ${added.map((p) => p.split("/").pop()).join(", ")}` : "";
console.log(`✓ frozen migrations: ${compared} unchanged since ${BASE}${forward}`);
