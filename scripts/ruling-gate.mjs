#!/usr/bin/env node
// The ruling gate (NZC-163, hardened): a pull request that adds or changes a migration cannot go green until it is
// ruled, and a branch named hold/ cannot go green at all.
//
// ## Why it no longer trusts the branch name alone
//
// The first gate failed on `hold/*` and nothing else, so a migration on a branch nobody remembered to name hold/
// passed — #290's failure by a different route. A gate built for the moment somebody forgets has to fail closed: here
// a migration in the diff is itself the hold, and `hold/` stays as a manual hold for anything else.
//
// ## What a ruling is, and why the author cannot forge one
//
// A ruling is the **`ruled` label being applied** — the `labeled` event for that label, which GitHub binds to the pull
// request's head SHA at that moment. It is not the label's presence: every other event on a pull request carrying a
// migration fails, whatever its labels, and that includes every push. So a commit pushed after the ruling is held
// again, and re-ruling it means removing and re-applying the label. Nothing here reads a commit's author or committer
// date, which whoever pushes can set to anything; the property rests only on which event ran.
//
// It runs under `pull_request_target`, from the default branch's copy of the workflow and of this script, so a pull
// request cannot edit the gate that judges it. The pull request's own code is never executed — its commits are fetched
// and diffed by name only.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MIGRATIONS_DIR = "packages/isolated-backend/migrations/";
export const RULED_LABEL = "ruled";

/**
 * The decision, as a pure function of the event: which branch, what happened, which label it happened to, the labels
 * the pull request carries, and the files its diff touches.
 */
export function decide({ branch, action, labelName, labels, changedFiles }) {
  if (branch.startsWith("hold/")) {
    return { pass: false, reason: `'${branch}' is on hold (NZC-163). Rename it without the hold/ prefix once ruled.` };
  }
  const migrations = changedFiles.filter((file) => file.startsWith(MIGRATIONS_DIR));
  if (migrations.length === 0) return { pass: true, reason: "No migration in this diff, and the branch is not on hold." };
  // Only the act of applying the label is a ruling. Its mere presence on any other event is not: that is what makes
  // a push after the ruling fail again.
  if (action === "labeled" && labelName === RULED_LABEL && labels.includes(RULED_LABEL)) {
    return { pass: true, reason: `Ruled: '${RULED_LABEL}' applied to this head, which carries ${migrations.join(", ")}.` };
  }
  const why = action === "synchronize" && labels.includes(RULED_LABEL)
    ? `A commit was pushed after the ruling, so it no longer covers this head. Remove and re-apply '${RULED_LABEL}' to rule it again.`
    : `Apply the '${RULED_LABEL}' label once it is ruled.`;
  return { pass: false, reason: `This pull request carries ${migrations.join(", ")}, which needs a ruling (NZC-163). ${why}` };
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** The files a pull request's head changes relative to where it left its base — names only, nothing executed. */
export function changedFilesBetween(cwd, baseSha, headSha) {
  const out = git(cwd, ["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`]);
  return out ? out.split("\n") : [];
}

/** In CI: read the event from the environment the workflow passes, fetch the head it names, and decide. */
function main() {
  const env = process.env;
  const cwd = process.cwd();
  const prNumber = env.PR_NUMBER, headSha = env.HEAD_SHA, baseSha = env.BASE_SHA;
  if (!prNumber || !headSha || !baseSha) throw new Error("PR_NUMBER, HEAD_SHA and BASE_SHA are required.");
  // Fetch the pull request's head as data, and refuse to judge any head but the one this event names.
  git(cwd, ["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${prNumber}/head:refs/remotes/pr/head`, baseSha]);
  const fetched = git(cwd, ["rev-parse", "refs/remotes/pr/head"]);
  let decision;
  if (fetched !== headSha) {
    decision = { pass: false, reason: `The pull request moved to ${fetched} after this event (${headSha}); the newer event's run decides.` };
  } else {
    decision = decide({
      branch: env.BRANCH ?? "",
      action: env.ACTION ?? "",
      labelName: env.LABEL_NAME ?? "",
      labels: JSON.parse(env.LABELS ?? "[]"),
      changedFiles: changedFilesBetween(cwd, baseSha, headSha),
    });
  }
  console.log(`${decision.pass ? "✓" : "✗"} ${decision.reason} [head ${headSha}]`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `**Ruling gate** — ${decision.pass ? "pass" : "held"}: ${decision.reason}\n\nHead: \`${headSha}\`\n`);
  }
  if (!decision.pass) {
    console.log(`::error title=Ruling gate (NZC-163)::${decision.reason}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
