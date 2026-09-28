// The post-merge ruling check, proved against real git repositories rather than described.
//
// Each case builds `main` and a pull request branch, squash-merges the way GitHub does (one new commit on main, a new
// SHA), and asks ruling-verify whether what merged is what was ruled. The two cases it exists for are the incidents:
// #342 (the head merged before the ruled commit — must fail) and #345 (another merge changed a shared file in between —
// must pass).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ARTIFACT_PREFIX, decidePostMerge, findRuledHead, GOVERNED_PATHS, governedFiles, verifyMerge } from "./ruling-verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, "ruling-gate.mjs");
const VERIFY_WORKFLOW = resolve(HERE, "../.github/workflows/ruling-verify.yml");
const GATE_WORKFLOW = resolve(HERE, "../.github/workflows/ruling-gate.yml");

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ruling-verify-"));
  roots.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
  const write = (files) => { for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text); };
  const commit = (files, message) => { write(files); git(["add", "-A"]); git(["commit", "--quiet", "-m", message]); return git(["rev-parse", "HEAD"]); };
  git(["init", "--quiet", "--initial-branch=main"]);
  const doc = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  commit({ "a.txt": "a0\n", "doc.md": doc }, "base");
  /** Squash-merge `ref` onto main as GitHub does, optionally editing the result before it is committed. */
  const squash = (ref, extra = {}) => {
    git(["switch", "--quiet", "main"]);
    git(["merge", "--squash", "--quiet", ref]);
    write(extra);
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", `squash ${ref}`]);
    return git(["rev-parse", "HEAD"]);
  };
  return { dir, git, commit, squash, doc };
}

describe("what merged, against what was ruled", () => {
  it("passes a squash merge of the ruled head: new SHA, same tree", () => {
    const repo = repository();
    repo.git(["switch", "--quiet", "-c", "feat"]);
    const ruled = repo.commit({ "a.txt": "a1\n", "b.txt": "new\n" }, "change");
    const merge = repo.squash("feat");
    assert.notEqual(merge, ruled, "a squash merge mints a new SHA — which is why SHAs were never the check");
    const result = verifyMerge({ cwd: repo.dir, ruledSha: ruled, mergeSha: merge });
    assert.equal(result.pass, true, result.reason);
    assert.deepEqual(result.paths, ["a.txt", "b.txt"]);
  });

  it("fails #342: the head merged before the ruled commit reached it", () => {
    const repo = repository();
    repo.git(["switch", "--quiet", "-c", "feat"]);
    const earlier = repo.commit({ "a.txt": "a1 — no read-only wrapper\n" }, "first");
    const ruled = repo.commit({ "a.txt": "a2 — BEGIN READ ONLY … COMMIT\n" }, "the ruled change");
    const merge = repo.squash(earlier);
    const result = verifyMerge({ cwd: repo.dir, ruledSha: ruled, mergeSha: merge });
    assert.equal(result.pass, false);
    assert.deepEqual(result.problems, ["a.txt: the merged content differs from what was ruled"]);
    assert.match(result.reason, /re-land the ruled change/);
  });

  it("passes #345: another merge changed the same file meanwhile, and the ruled change is applied exactly", () => {
    const repo = repository();
    repo.git(["switch", "--quiet", "-c", "feat"]);
    const ruled = repo.commit({ "a.txt": "a1\n", "doc.md": repo.doc.replace("line 3\n", "line 3 — ruled edit\n") }, "ruled");
    repo.git(["switch", "--quiet", "main"]);
    repo.commit({ "doc.md": repo.doc.replace("line 35\n", "line 35 — merged first by someone else\n") }, "concurrent merge");
    const merge = repo.squash("feat");
    const result = verifyMerge({ cwd: repo.dir, ruledSha: ruled, mergeSha: merge });
    assert.equal(result.pass, true, result.reason);
    assert.deepEqual(result.concurrent, ["doc.md"]);
    assert.match(result.reason, /doc\.md also carry changes merged concurrently/);
  });

  it("fails a merge that slipped an unruled edit into a ruled file — a web-editor conflict fix, say", () => {
    const repo = repository();
    repo.git(["switch", "--quiet", "-c", "feat"]);
    const ruled = repo.commit({ "a.txt": "a1\n" }, "ruled");
    const merge = repo.squash("feat", { "a.txt": "a1\nand one more line nobody ruled\n" });
    const result = verifyMerge({ cwd: repo.dir, ruledSha: ruled, mergeSha: merge });
    assert.equal(result.pass, false);
    assert.deepEqual(result.problems, ["a.txt: the merged content differs from what was ruled"]);
  });

  it("fails a merge that adds a file nobody ruled, or drops one that was", () => {
    const added = repository();
    added.git(["switch", "--quiet", "-c", "feat"]);
    const ruledA = added.commit({ "a.txt": "a1\n" }, "ruled");
    const mergeA = added.squash("feat", { "extra.txt": "unruled\n" });
    assert.deepEqual(verifyMerge({ cwd: added.dir, ruledSha: ruledA, mergeSha: mergeA }).problems, ["extra.txt: merged, but not in what was ruled"]);

    const dropped = repository();
    dropped.git(["switch", "--quiet", "-c", "feat"]);
    const partial = dropped.commit({ "a.txt": "a1\n" }, "first");
    const ruledB = dropped.commit({ "b.txt": "ruled too\n" }, "second");
    const mergeB = dropped.squash(partial);
    assert.deepEqual(verifyMerge({ cwd: dropped.dir, ruledSha: ruledB, mergeSha: mergeB }).problems, ["b.txt: ruled, but not in the merge"]);
  });
});

describe("a ruled head on a branch whose earlier work was already squash-merged", () => {
  it("does not count work main already has — and still fails what main lacks", () => {
    const repo = repository();
    repo.git(["switch", "--quiet", "-c", "feat"]);
    const first = repo.commit({ "b.txt": "helper\n" }, "first, merged on its own");
    repo.squash(first);
    repo.git(["switch", "--quiet", "feat"]);
    const ruled = repo.commit({ "a.txt": "a1 — the ruled follow-up\n" }, "follow-up");
    // The follow-up re-landed as its own change onto main (the #344 shape): only a.txt merges now.
    repo.git(["switch", "--quiet", "main"]);
    repo.git(["cherry-pick", "--no-commit", ruled]);
    repo.git(["commit", "--quiet", "-m", "re-land"]);
    const merge = repo.git(["rev-parse", "HEAD"]);
    const result = verifyMerge({ cwd: repo.dir, ruledSha: ruled, mergeSha: merge });
    assert.equal(result.pass, true, result.reason);

    // Same shape, but the earlier work never reached main: now it is missing, and says so.
    const other = repository();
    other.git(["switch", "--quiet", "-c", "feat"]);
    other.commit({ "b.txt": "helper\n" }, "first, never merged");
    const ruledB = other.commit({ "a.txt": "a1\n" }, "follow-up");
    other.git(["switch", "--quiet", "main"]);
    other.git(["cherry-pick", "--no-commit", ruledB]);
    other.git(["commit", "--quiet", "-m", "only the follow-up"]);
    const mergeB = other.git(["rev-parse", "HEAD"]);
    assert.deepEqual(verifyMerge({ cwd: other.dir, ruledSha: ruledB, mergeSha: mergeB }).problems, ["b.txt: ruled, but not in the merge"]);
  });
});

describe("when a merge with no ruling matters", () => {
  const verify = () => { throw new Error("verify must not run without a ruled head"); };

  it("skips, neutrally, an un-ruled merge that touches nothing governed — the alarm stays quiet on ordinary work", () => {
    const decision = decidePostMerge({ prNumber: "400", ruledSha: null, verify,
      changedFiles: ["apps/console/app/page.tsx", "docs/CLIENT_WORKSPACE_BACKLOG.md", "packages/isolated-backend/src/readModels.ts"] });
    assert.deepEqual([decision.pass, decision.skipped], [true, true]);
    assert.match(decision.reason, /touches no governed path — nothing to verify/);
    // This very change touches only the gate's own files: its post-merge check will skip, as ruled.
    const gateOnly = decidePostMerge({ prNumber: "346", ruledSha: null, verify,
      changedFiles: [".github/workflows/ruling-gate.yml", ".github/workflows/ruling-verify.yml", "package.json", "scripts/ruling-gate.mjs", "scripts/ruling-verify.mjs", "scripts/ruling-verify.test.mjs"] });
    assert.equal(gateOnly.skipped, true);
  });

  it("fails an un-ruled merge that touches a governed path, naming it", () => {
    for (const file of [
      "packages/isolated-backend/migrations/0137_example.sql", "packages/contracts/src/commands.ts",
      "packages/isolated-backend/src/v7ClientImport.ts", "packages/isolated-backend/src/v7ExtractContract.json",
      "packages/isolated-backend/scripts/v7-extract-sql.mjs", "packages/isolated-backend/scripts/load-v7-clients.ts",
      "packages/isolated-backend/src/databaseTls.ts", "packages/isolated-backend/src/postgresCommands.ts",
    ]) {
      const decision = decidePostMerge({ prNumber: "401", ruledSha: null, verify, changedFiles: ["README.md", file] });
      assert.equal(decision.pass, false, file);
      assert.equal(decision.skipped, undefined);
      assert.match(decision.reason, new RegExp(`governed path\\(s\\): ${file.replace(/[.]/g, "\\.")}\\.`), file);
    }
  });

  it("verifies a ruled merge by tree, whatever it touches", () => {
    const mismatch = { pass: false, reason: "differs" };
    assert.equal(decidePostMerge({ prNumber: "402", ruledSha: "a".repeat(40), changedFiles: ["README.md"], verify: () => mismatch }), mismatch);
  });

  it("governs files that exist — a rename cannot quietly leave the list governing nothing", () => {
    const root = resolve(HERE, "..");
    for (const entry of GOVERNED_PATHS) assert.ok(existsSync(join(root, entry.path)), `${entry.path} (${entry.why}) no longer exists`);
    assert.deepEqual(governedFiles(["packages/contracts/src/nested/x.ts", "packages/contracts/README.md", "packages/isolated-backend/src/v7ClientImport.tsx"]),
      ["packages/contracts/src/nested/x.ts"], "prefixes govern beneath them; exact paths match exactly");
  });
});

describe("where the ruled head comes from", () => {
  const sha = (digit) => digit.repeat(40);
  const page = (artifacts) => ({ ok: true, json: async () => ({ artifacts }) });

  it("takes the newest ruling recorded for the pull request, from artifact names alone", async () => {
    const pages = [page([
      { name: `${ARTIFACT_PREFIX}342-${sha("a")}`, created_at: "2026-09-28T10:00:00Z" },
      { name: `${ARTIFACT_PREFIX}342-${sha("b")}`, created_at: "2026-09-28T12:00:00Z" },
      { name: `${ARTIFACT_PREFIX}3421-${sha("c")}`, created_at: "2026-09-29T00:00:00Z" },
      { name: `${ARTIFACT_PREFIX}342-not-a-sha`, created_at: "2026-09-30T00:00:00Z" },
      { name: "playwright-report", created_at: "2026-09-30T00:00:00Z" },
    ])];
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return pages.shift() ?? page([]); };
    assert.equal(await findRuledHead({ repository: "o/r", prNumber: "342", token: "t", fetchImpl }), sha("b"), "not #3421's, not a malformed name");
    assert.equal(calls[0].url, "https://api.github.com/repos/o/r/actions/artifacts?per_page=100&page=1");
    assert.equal(calls[0].auth, "Bearer t");
  });

  it("pages through a long list, and reports no ruling as none", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}`, created_at: "2026-09-28T00:00:00Z" }));
    const pages = [page(full), page([{ name: `${ARTIFACT_PREFIX}7-${sha("d")}`, created_at: "2026-09-28T00:00:00Z" }])];
    const fetchImpl = async () => pages.shift() ?? page([]);
    assert.equal(await findRuledHead({ repository: "o/r", prNumber: "7", token: "t", fetchImpl }), sha("d"), "found on the second page");
    assert.equal(await findRuledHead({ repository: "o/r", prNumber: "8", token: "t", fetchImpl: async () => page([]) }), null);
    await assert.rejects(findRuledHead({ repository: "o/r", prNumber: "8", token: "t", fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/);
  });

  it("is recorded by the gate only when 'ruled' is applied to the head the event names", () => {
    const root = mkdtempSync(join(tmpdir(), "ruling-record-"));
    roots.push(root);
    const origin = join(root, "origin.git"), work = join(root, "work"), gate = join(root, "gate");
    const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
    git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    git(root, ["init", "--quiet", "--initial-branch=main", work]);
    writeFileSync(join(work, "README.md"), "base\n");
    git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", "base"]);
    git(work, ["remote", "add", "origin", origin]); git(work, ["push", "--quiet", "origin", "main"]);
    const base = git(work, ["rev-parse", "HEAD"]);
    writeFileSync(join(work, "README.md"), "change\n");
    git(work, ["commit", "--quiet", "-am", "change"]);
    git(work, ["push", "--quiet", "origin", "HEAD:refs/pull/1/head"]);
    const head = git(work, ["rev-parse", "HEAD"]);
    git(root, ["clone", "--quiet", origin, gate]);
    const run = (event) => {
      rmSync(join(gate, "ruled-head.json"), { force: true });
      spawnSync(process.execPath, [GATE], { cwd: gate, encoding: "utf8", env: {
        ...process.env, PR_NUMBER: "1", BASE_SHA: base, BRANCH: "feat/x", LABELS: "[]", GITHUB_STEP_SUMMARY: "", ...event } });
      return existsSync(join(gate, "ruled-head.json")) ? JSON.parse(readFileSync(join(gate, "ruled-head.json"), "utf8")) : null;
    };
    assert.deepEqual(run({ HEAD_SHA: head, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: '["ruled"]' }), { pr: 1, head, base },
      "a ruling of a pull request with no migration is recorded too — #342 had none");
    assert.equal(run({ HEAD_SHA: head, ACTION: "synchronize", LABEL_NAME: "" }), null, "a push is not a ruling");
    assert.equal(run({ HEAD_SHA: head, ACTION: "labeled", LABEL_NAME: "other" }), null);
    assert.equal(run({ HEAD_SHA: base, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: '["ruled"]' }), null, "a stale head records nothing");
  });
});

describe("the workflows", () => {
  const code = (path) => readFileSync(path, "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

  it("verifies after a merge, from the default branch, with a read-only token and the event only in the environment", () => {
    const yml = code(VERIFY_WORKFLOW);
    assert.match(yml, /pull_request_target:\s*\n\s*types: \[closed\]/);
    assert.doesNotMatch(yml, /^\s*pull_request:/m);
    assert.match(yml, /if: github\.event\.pull_request\.merged == true/);
    assert.match(yml, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read\s*\n/);
    assert.doesNotMatch(yml, /write/);
    assert.match(yml, /persist-credentials: false/);
    assert.match(yml, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.doesNotMatch(yml, /ref: \$\{\{ github\.event\.pull_request\.head/);
    const runLines = yml.split("\n").filter((line) => /^\s*run:/.test(line)).map((line) => line.trim());
    assert.deepEqual(runLines, ["run: node scripts/ruling-verify.mjs"]);
  });

  it("has the gate upload the ruled head, named by PR and SHA, only when 'ruled' is applied", () => {
    const yml = code(GATE_WORKFLOW);
    assert.match(yml, /if: \$\{\{ always\(\) && github\.event\.action == 'labeled' && github\.event\.label\.name == 'ruled' \}\}/);
    assert.match(yml, /uses: actions\/upload-artifact@v4/);
    assert.match(yml, new RegExp(`name: ${ARTIFACT_PREFIX}\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\$\\{\\{ github\\.event\\.pull_request\\.head\\.sha \\}\\}`));
    assert.match(yml, /if-no-files-found: ignore/);
  });
});
