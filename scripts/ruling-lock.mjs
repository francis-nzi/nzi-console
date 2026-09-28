#!/usr/bin/env node
// The governed-path lock: the pre-merge half of "what merged is what was ruled" (ruled 28 Sep 2026).
//
// ## Why
//
// Three times a ruled change did not reach main: each merge took an earlier head of the pull request than the one that
// was ruled (#342, #346). The post-merge check (ruling-verify.mjs) finds that after the fact. This stops it before:
// a required status check on main that blocks the merge of a pull request touching a governed path unless
//
//   (a) a ruling is recorded for it,
//   (b) its current head is exactly the head that was ruled, and
//   (c) the `ruled` label is on it now — removing the label withdraws the ruling and re-locks it.
//
// A squash merge of that head is then the ruled tree by construction; the post-merge check stays as confirmation.
// A pull request touching no governed path passes as a skip — ordinary work merges exactly as before.
//
// ## Where the ruling comes from
//
// The gate job before this one records every ruling as an artifact, `ruled-head-pr-<N>-<sha>`. On the event that *is*
// a ruling (the `ruled` label applied to this head) the head is the ruled head by definition — the gate job has just
// recorded it; on any other event the newest recorded ruling is read from the artifact list. Nothing here trusts the
// label's mere presence: a push after a ruling moves the head away from the ruled one, and the lock goes red until the
// label is applied again.
//
// Runs as a job of ruling-gate.yml under pull_request_target, from the default branch's copy, with a read-only token;
// the pull request's code is fetched as data and diffed by name, never executed.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RULED_LABEL } from "./ruling-gate.mjs";
import { findRuledHead, governedFiles } from "./ruling-verify.mjs";

/** The decision, pure: what the pull request touches, its head, the ruled head (if any), and the event. */
export function decideLock({ prNumber, changedFiles, headSha, ruledSha, action, labelName, labels = [] }) {
  const governed = governedFiles(changedFiles);
  if (governed.length === 0) {
    return { pass: true, skipped: true, reason: `#${prNumber} touches no governed path — not locked; merge as usual.` };
  }
  const ruledNow = action === "labeled" && labelName === RULED_LABEL;
  const ruled = ruledNow ? headSha : ruledSha;
  const touched = `It touches governed path(s): ${governed.join(", ")}.`;
  if (!ruled) {
    return { pass: false, reason: `#${prNumber} is locked: no ruling is recorded for it. ${touched} Apply '${RULED_LABEL}' once it is ruled.` };
  }
  // The label is the revocable control surface (ruled 28 Sep 2026): removing it withdraws the ruling, and the
  // unlabeled event re-runs this, so the lock closes again until the label is re-applied.
  if (!labels.includes(RULED_LABEL)) {
    return { pass: false, reason: `#${prNumber} is locked: '${RULED_LABEL}' is not on it — the ruling was withdrawn. ${touched} Re-apply '${RULED_LABEL}' to this head to rule it.` };
  }
  if (ruled !== headSha) {
    return { pass: false, reason: `#${prNumber} is locked: its head ${headSha.slice(0, 7)} is not the ruled head ${ruled.slice(0, 7)} — ` +
      `it moved after the ruling. ${touched} Rule this head (remove and re-apply '${RULED_LABEL}'), or merge only what was ruled.` };
  }
  return { pass: true, reason: `#${prNumber} may merge: its head ${headSha.slice(0, 7)} is the ruled head. ${touched}` };
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** The run, with the environment and GitHub's API injected so it is testable end to end. */
export async function runLock({ env, cwd, fetchImpl = fetch }) {
  const { PR_NUMBER: prNumber, HEAD_SHA: headSha, BASE_SHA: baseSha, REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (!prNumber || !headSha || !baseSha || !repository || !token) throw new Error("PR_NUMBER, HEAD_SHA, BASE_SHA, REPOSITORY and GITHUB_TOKEN are required.");
  git(cwd, ["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${prNumber}/head:refs/remotes/pr/head`, baseSha]);
  const fetched = git(cwd, ["rev-parse", "refs/remotes/pr/head"]);
  if (fetched !== headSha) {
    return { pass: false, reason: `#${prNumber} moved to ${fetched} after this event (${headSha}); the newer event's run decides.` };
  }
  const changed = git(cwd, ["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`]);
  const changedFiles = changed ? changed.split("\n") : [];
  // Only look a ruling up when it can matter: a governed change on an event that is not itself the ruling.
  const ruledNow = env.ACTION === "labeled" && env.LABEL_NAME === RULED_LABEL;
  const ruledSha = governedFiles(changedFiles).length && !ruledNow ? await findRuledHead({ repository, prNumber, token, fetchImpl }) : null;
  return decideLock({ prNumber, changedFiles, headSha, ruledSha, action: env.ACTION ?? "", labelName: env.LABEL_NAME ?? "", labels: JSON.parse(env.LABELS ?? "[]") });
}

async function main() {
  const decision = await runLock({ env: process.env, cwd: process.cwd() });
  const mark = decision.skipped ? "–" : decision.pass ? "✓" : "✗";
  console.log(`${mark} ${decision.reason} [head ${process.env.HEAD_SHA}]`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Governed-path lock** — ${decision.skipped ? "not locked" : decision.pass ? "may merge" : "LOCKED"}: ${decision.reason}\n`);
  }
  if (decision.skipped) console.log(`::notice title=Governed-path lock::${decision.reason}`);
  if (!decision.pass) {
    console.log(`::error title=Governed-path lock::${decision.reason}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.log(`::error title=Governed-path lock::${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
