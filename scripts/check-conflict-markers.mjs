#!/usr/bin/env node
/**
 * Fail the build if a merge-conflict marker is committed to a tracked file.
 *
 * ## Why this exists — the #194 incident
 *
 * During a rebase on `feat/grounded-answering`, conflict markers were resolved in
 * `docs/DECISIONS.md` but left in place in `docs/CLIENT_WORKSPACE_BACKLOG.md`, then staged by a
 * `git add -A` and committed. **The full gate passed anyway** — typecheck, build and 964 tests
 * all green — because a conflict marker in Markdown is simply text. Nothing parses it, nothing
 * imports it, nothing asserts on it. It survived a green gate, a push, and a PR, and was only
 * caught when the next rebase produced a duplicated table row.
 *
 * That is the shape of the problem worth designing out: not a bug the tests missed, but a class
 * of damage the tests **cannot** see. Every check in this repo answers "does the code work?" and
 * a corrupted document answers that question with a confident yes. So the guard cannot be a test;
 * it has to be a scan over the files themselves.
 *
 * Documents are load-bearing here — DECISIONS.md is the governance record, the backlog is the
 * delivery state — and a half-merged one is worse than a broken build, because a broken build
 * announces itself.
 *
 * NZC-086.
 *
 * ## What it matches, and the one thing it is careful about
 *
 * A start or end marker is unambiguous: seven `<` or seven `>` at the start of a line is not
 * something anyone writes on purpose, so those fail on sight.
 *
 * The middle separator — a row of seven `=` — is **not** unambiguous. It is also a valid
 * Markdown setext heading underline, and this repo is mostly Markdown. Failing on it everywhere
 * would eventually reject a legitimate document, and a check that cries wolf gets switched off;
 * a check that is switched off protects nothing. So a separator only counts when the same file
 * also carries a start or end marker — which a real conflict always writes. The strictness is
 * spent where it is free and withheld where it would cost credibility.
 */

import { execFileSync } from "node:child_process";

/** Runs `git grep`, treating "no matches" as a result rather than a failure. */
function gitGrep(pattern) {
  try {
    const out = execFileSync("git", ["grep", "-nIE", pattern], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (error) {
    // git grep exits 1 for "nothing found", which is the good case. Anything else is a real
    // failure — a broken repo or no git — and must not be swallowed into a silent pass.
    if (error.status === 1) return [];
    throw error;
  }
}

const fileOf = (hit) => hit.slice(0, hit.indexOf(":"));

const starts = gitGrep("^<{7}( |$)");
const ends = gitGrep("^>{7}( |$)");
const suspectFiles = new Set([...starts, ...ends].map(fileOf));

// Only in a file already known to hold a conflict; elsewhere a row of equals signs is a heading.
const separators = gitGrep("^={7}$").filter((hit) => suspectFiles.has(fileOf(hit)));

const hits = [...starts, ...separators, ...ends].sort();

if (hits.length > 0) {
  console.error("\nMerge-conflict markers are committed in tracked files:\n");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    "\nResolve the conflict in the file, not in the GitHub web editor, and commit the result." +
    "\nNothing else in the gate can catch this: a marker in Markdown compiles, builds and tests" +
    "\nclean, which is exactly how one reached main's PR queue (NZC-086).\n",
  );
  process.exit(1);
}

console.log(`No conflict markers in tracked files (${starts.length + ends.length} start/end markers found).`);
