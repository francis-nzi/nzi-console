#!/usr/bin/env node
// The post-merge half of the ruling gate: what merged is what was ruled.
//
// ## Why this exists
//
// "Merged SHA == ruled SHA" was never a check: a squash merge always mints a new SHA, so it could not match and nobody
// compared anything. Twice a required change that was ruled did not reach main — #342 merged the head *before* the
// ruled commit. The check that catches that is a tree comparison, run on main after the merge.
//
// ## What it compares
//
// The ruled head is recorded at ruling time: when `ruled` is applied, ruling-gate.yml uploads an artifact named
// `ruled-head-pr-<N>-<sha>` — the head the label was applied to. After the merge, for every path the pull request
// touched (as merged, and as ruled):
//
//   - the merged tree must equal the ruled tree at that path; or, where main also changed the same file concurrently
//     (another pull request merged in between), the merged change to that path must be the ruled change — the same
//     `git patch-id`, which ignores line numbers and context but not content;
//   - the set of paths must be the same: nothing ruled left out, nothing unruled added.
//
// Anything else fails, naming the paths. A merge with no ruling recorded fails only if it touches a governed path
// (GOVERNED_PATHS); otherwise it is skipped, neutrally — never red for an ordinary un-ruled merge. It runs under
// pull_request_target from the default branch, with a read-only token; the pull request's code is never executed.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ARTIFACT_PREFIX = "ruled-head-pr-";

const git = (cwd, args, input) => execFileSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 }).trim();
const lines = (text) => (text ? text.split("\n") : []);
const patchId = (cwd, diff) => (diff ? git(cwd, ["patch-id", "--stable"], diff).split(" ")[0] ?? "" : "");

/** Compare a merge commit on main with the ruled head. Pure git; nothing from the pull request is executed. */
export function verifyMerge({ cwd, ruledSha, mergeSha }) {
  const parent = git(cwd, ["rev-parse", `${mergeSha}^1`]);
  const base = git(cwd, ["merge-base", ruledSha, parent]);
  const merged = new Set(lines(git(cwd, ["diff", "--name-only", "--no-renames", parent, mergeSha])));
  const ruled = new Set(lines(git(cwd, ["diff", "--name-only", "--no-renames", base, ruledSha])));
  const problems = [];
  // A ruled path the merge did not touch is a problem only if main still differs from the ruled content there. A ruled
  // head on a branch whose earlier commits were already squash-merged (#343's shape) carries paths main already has.
  const already = [];
  for (const path of ruled) {
    if (merged.has(path)) continue;
    if (git(cwd, ["diff", "--no-renames", ruledSha, mergeSha, "--", path]) === "") already.push(path);
    else problems.push(`${path}: ruled, but not in the merge`);
  }
  for (const path of merged) if (!ruled.has(path)) problems.push(`${path}: merged, but not in what was ruled`);
  const concurrent = [];
  for (const path of [...merged].filter((candidate) => ruled.has(candidate)).sort()) {
    const sameTree = git(cwd, ["diff", "--no-renames", ruledSha, mergeSha, "--", path]) === "";
    if (sameTree) continue;
    const ruledChange = patchId(cwd, git(cwd, ["diff", "--no-renames", base, ruledSha, "--", path]));
    const mergedChange = patchId(cwd, git(cwd, ["diff", "--no-renames", parent, mergeSha, "--", path]));
    if (ruledChange && ruledChange === mergedChange) concurrent.push(path);
    else problems.push(`${path}: the merged content differs from what was ruled`);
  }
  const pass = problems.length === 0;
  const reason = pass
    ? `Merged tree matches the ruled head ${ruledSha.slice(0, 7)} on all ${merged.size} path(s)` +
      (concurrent.length ? `; ${concurrent.join(", ")} also carry changes merged concurrently, and the ruled change to each is applied exactly.` : ".")
    : `The merge does not match the ruled head ${ruledSha.slice(0, 7)}: ${problems.join("; ")}. Do not apply 'ruled' as done; re-land the ruled change.`;
  return { pass, reason, problems, concurrent, paths: [...merged].sort() };
}

/** The newest ruled head recorded for a pull request, from the artifact names alone (content may have expired). */
export async function findRuledHead({ repository, prNumber, token, fetchImpl = fetch, maxPages = 50 }) {
  const prefix = `${ARTIFACT_PREFIX}${prNumber}-`;
  let newest = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`listing artifacts failed: ${response.status}`);
    const body = await response.json();
    for (const artifact of body.artifacts ?? []) {
      if (!artifact.name?.startsWith(prefix)) continue;
      const sha = artifact.name.slice(prefix.length);
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      if (!newest || artifact.created_at > newest.createdAt) newest = { sha, createdAt: artifact.created_at };
    }
    if ((body.artifacts ?? []).length < 100) break;
  }
  return newest?.sha ?? null;
}

/**
 * The paths whose merge must be ruled (ruled 28 Sep 2026). A pull request touching none of them and never ruled is
 * skipped, not failed — an alarm that goes red on every ordinary merge is tuned out within a week. `prefix: true`
 * governs everything under the path.
 */
export const GOVERNED_PATHS = [
  // The existing gate's set.
  { path: "packages/isolated-backend/migrations/", prefix: true, why: "migrations" },
  // Contracts.
  { path: "packages/contracts/src/", prefix: true, why: "contracts" },
  // The v7 importer, and the report sealing it writes through.
  ...["v7ClientExtract.ts", "v7ClientImport.ts", "v7ClientLoad.ts", "v7EmissionsFormula.ts", "legacyReportSeal.ts"]
    .map((file) => ({ path: `packages/isolated-backend/src/${file}`, why: "the v7 importer" })),
  // The extract helpers and the contract they read.
  { path: "packages/isolated-backend/scripts/v7-extract-sql.mjs", why: "the extract helpers" },
  { path: "packages/isolated-backend/scripts/v7-extract-manifest.mjs", why: "the extract helpers" },
  { path: "packages/isolated-backend/src/v7ExtractContract.json", why: "the extract contract" },
  // The loader, and the TLS it connects over.
  { path: "packages/isolated-backend/scripts/load-v7-clients.ts", why: "the loader" },
  { path: "packages/isolated-backend/src/databaseTls.ts", why: "the TLS helper" },
  // The job spine (NZC-007, NZC-025): job header, numbering, the scope-row commands and the freeze; and the one tool
  // that renumbers jobs, with the live-organisation guard it rests on.
  { path: "packages/isolated-backend/src/postgresCommands.ts", why: "the job spine" },
  { path: "packages/isolated-backend/src/demoJobNumberRetirement.ts", why: "the job spine" },
  { path: "packages/isolated-backend/scripts/retire-demo-job-numbers.ts", why: "the job spine" },
  { path: "packages/isolated-backend/src/liveOrganisation.ts", why: "the job spine" },
  // The enforcement machinery itself (ruled 28 Sep 2026): the gate, the lock and the post-merge check. Otherwise an
  // unruled pull request could weaken the rule that judges every other one. The workflows run from main's copy, so a
  // pull request cannot weaken its own judgment; this stops it merging the weakening unruled.
  { path: ".github/workflows/ruling-gate.yml", why: "the enforcement machinery" },
  { path: ".github/workflows/ruling-verify.yml", why: "the enforcement machinery" },
  { path: "scripts/ruling-gate.mjs", why: "the enforcement machinery" },
  { path: "scripts/ruling-lock.mjs", why: "the enforcement machinery" },
  { path: "scripts/ruling-verify.mjs", why: "the enforcement machinery" },
];

export const governedFiles = (files) =>
  files.filter((file) => GOVERNED_PATHS.some((entry) => (entry.prefix ? file.startsWith(entry.path) : file === entry.path)));

/**
 * The post-merge decision. `skipped` is the neutral outcome: nothing ruled, and nothing governed to require it.
 * A failure is reserved for a ruled merge whose tree does not match, and for a governed merge that was never ruled.
 */
export function decidePostMerge({ prNumber, ruledSha, changedFiles, verify }) {
  if (!ruledSha) {
    const governed = governedFiles(changedFiles);
    if (governed.length === 0) {
      return { pass: true, skipped: true, reason: `No ruling recorded, and #${prNumber} touches no governed path — nothing to verify.` };
    }
    return { pass: false, reason: `#${prNumber} merged with no ruling recorded, and it touches governed path(s): ${governed.join(", ")}. 'ruled' was never applied to any head of it.` };
  }
  return verify();
}

async function main() {
  const env = process.env;
  const cwd = process.cwd();
  const { PR_NUMBER: prNumber, MERGE_SHA: mergeSha, REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (!prNumber || !mergeSha || !repository || !token) throw new Error("PR_NUMBER, MERGE_SHA, REPOSITORY and GITHUB_TOKEN are required.");
  const ruledSha = await findRuledHead({ repository, prNumber, token });
  git(cwd, ["fetch", "--no-tags", "--quiet", "origin", ...(ruledSha ? [ruledSha] : []), mergeSha]);
  const changedFiles = lines(git(cwd, ["diff", "--name-only", "--no-renames", `${mergeSha}^1`, mergeSha]));
  const decision = decidePostMerge({ prNumber, ruledSha, changedFiles, verify: () => verifyMerge({ cwd, ruledSha, mergeSha }) });
  const outcome = decision.skipped ? "skipped" : decision.pass ? "match" : "MISMATCH";
  console.log(`${decision.skipped ? "–" : decision.pass ? "✓" : "✗"} #${prNumber}: ${decision.reason} [merge ${mergeSha}]`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `**Ruling verified after merge** — ${outcome}: ${decision.reason}\n\nMerge: \`${mergeSha}\`${ruledSha ? `, ruled: \`${ruledSha}\`` : ""}\n`);
  }
  if (decision.skipped) console.log(`::notice title=Ruling not required::${decision.reason}`);
  if (!decision.pass) {
    console.log(`::error title=Merged tree does not match the ruling::${decision.reason}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.log(`::error title=Ruling verification::${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
