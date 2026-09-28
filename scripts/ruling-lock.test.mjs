// The governed-path lock, proved against real git repositories and a stand-in for GitHub's artifact list.
//
// The property it exists for: a pull request touching a governed path cannot go green unless its current head is the
// head that was ruled — so a squash merge takes the ruled tree. The case that proves it is the push after a ruling:
// ruled at one head, a commit pushed on top, and the lock red again until the new head is ruled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { decideLock, runLock } from "./ruling-lock.mjs";
import { ARTIFACT_PREFIX } from "./ruling-verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, "../.github/workflows/ruling-gate.yml");
const MIGRATION = "packages/isolated-backend/migrations/0999_example.sql";
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sha = (digit) => digit.repeat(40);

describe("the decision", () => {
  const base = { prNumber: "9", headSha: sha("a"), ruledSha: null, action: "synchronize", labelName: "", labels: ["ruled"] };

  it("skips a pull request that touches no governed path — ordinary work merges as before", () => {
    const decision = decideLock({ ...base, changedFiles: ["apps/console/app/page.tsx", "docs/README.md"] });
    assert.deepEqual([decision.pass, decision.skipped], [true, true]);
  });

  it("locks a governed pull request with no ruling, naming what it touches", () => {
    const decision = decideLock({ ...base, changedFiles: [MIGRATION, "README.md"] });
    assert.equal(decision.pass, false);
    assert.match(decision.reason, /no ruling is recorded.*governed path\(s\): packages\/isolated-backend\/migrations\/0999_example\.sql\./);
  });

  it("unlocks exactly at the ruled head, and nowhere else", () => {
    assert.equal(decideLock({ ...base, changedFiles: [MIGRATION], ruledSha: sha("a") }).pass, true);
    const moved = decideLock({ ...base, changedFiles: [MIGRATION], ruledSha: sha("b") });
    assert.equal(moved.pass, false);
    assert.match(moved.reason, /head aaaaaaa is not the ruled head bbbbbbb — it moved after the ruling/);
  });

  it("unlocks only while 'ruled' is on the pull request — removing the label withdraws the ruling", () => {
    const withdrawn = decideLock({ ...base, changedFiles: [MIGRATION], ruledSha: sha("a"), action: "unlabeled", labelName: "ruled", labels: ["urgent"] });
    assert.equal(withdrawn.pass, false, "ruled at this very head, but the label has been taken off");
    assert.match(withdrawn.reason, /'ruled' is not on it — the ruling was withdrawn/);
    assert.equal(decideLock({ ...base, changedFiles: [MIGRATION], ruledSha: sha("a"), labels: ["urgent", "ruled"] }).pass, true);
    assert.equal(decideLock({ ...base, changedFiles: ["README.md"], labels: [] }).skipped, true, "an ordinary pull request needs no label");
  });

  it("treats the ruling event itself as the ruling of its head; any other label is not one", () => {
    assert.equal(decideLock({ ...base, changedFiles: [MIGRATION], action: "labeled", labelName: "ruled" }).pass, true);
    assert.equal(decideLock({ ...base, changedFiles: [MIGRATION], action: "labeled", labelName: "urgent" }).pass, false);
  });
});

describe("end to end, as the workflow runs it", () => {
  const roots = [];
  after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "ruling-lock-"));
    roots.push(root);
    const origin = join(root, "origin.git"), work = join(root, "work"), gate = join(root, "gate");
    const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
    git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    git(root, ["init", "--quiet", "--initial-branch=main", work]);
    writeFileSync(join(work, "README.md"), "base\n");
    git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", "base"]);
    git(work, ["remote", "add", "origin", origin]); git(work, ["push", "--quiet", "origin", "main"]);
    const baseSha = git(work, ["rev-parse", "HEAD"]);
    git(root, ["clone", "--quiet", origin, gate]);
    const commit = (file, text) => {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
      git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", `change ${file}`]);
      git(work, ["push", "--quiet", "--force", "origin", "HEAD:refs/pull/1/head"]);
      return git(work, ["rev-parse", "HEAD"]);
    };
    let artifacts = [];
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ artifacts }) }; };
    const run = (event) => runLock({ cwd: gate, fetchImpl, env: { PR_NUMBER: "1", BASE_SHA: baseSha, REPOSITORY: "o/r", GITHUB_TOKEN: "t", ACTION: "synchronize", LABEL_NAME: "", LABELS: "[]", ...event } });
    const record = (head, at) => { artifacts = [...artifacts, { name: `${ARTIFACT_PREFIX}1-${head}`, created_at: at }]; };
    return { commit, run, record, calls: () => calls };
  }

  it("skips an ordinary pull request without asking GitHub anything", async () => {
    const pr = setup();
    const head = pr.commit("apps/console/app/page.tsx", "export {};\n");
    const decision = await pr.run({ HEAD_SHA: head });
    assert.equal(decision.skipped, true);
    assert.equal(pr.calls(), 0);
  });

  it("proves the property: locked, ruled, a push on top, locked again — until the new head is ruled", async () => {
    const pr = setup();
    const head = pr.commit(MIGRATION, "SELECT 1;\n");
    assert.equal((await pr.run({ HEAD_SHA: head })).pass, false, "a governed change with no ruling");

    const RULED = '["ruled"]';
    assert.equal((await pr.run({ HEAD_SHA: head, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: RULED })).pass, true, "the ruling event");
    pr.record(head, "2026-09-28T10:00:00Z"); // what the gate job uploads on that event
    assert.equal((await pr.run({ HEAD_SHA: head, ACTION: "reopened", LABELS: RULED })).pass, true, "a later event at the ruled head");
    assert.equal((await pr.run({ HEAD_SHA: head, ACTION: "unlabeled", LABEL_NAME: "ruled", LABELS: "[]" })).pass, false,
      "the label taken off: the ruling is withdrawn, the lock closes again");
    assert.equal((await pr.run({ HEAD_SHA: head, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: RULED })).pass, true, "and re-applied, it opens");

    const pushed = pr.commit("README.md", "a harmless-looking follow-up\n");
    const after = await pr.run({ HEAD_SHA: pushed, LABELS: RULED }); // the label stays on through a push
    assert.equal(after.pass, false, "the head moved past the ruling — exactly #342 and #346");
    assert.match(after.reason, /is not the ruled head/);

    assert.equal((await pr.run({ HEAD_SHA: pushed, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: RULED })).pass, true, "ruled again at the new head");
  });

  it("judges only the head its event names: a run for a head the pull request has moved past does not pass", async () => {
    const pr = setup();
    const ruled = pr.commit(MIGRATION, "SELECT 1;\n");
    pr.commit(MIGRATION, "SELECT 2;\n");
    const stale = await pr.run({ HEAD_SHA: ruled, ACTION: "labeled", LABEL_NAME: "ruled", LABELS: '["ruled"]' });
    assert.equal(stale.pass, false);
    assert.match(stale.reason, /moved to/);
  });
});

describe("the workflow job", () => {
  const code = readFileSync(WORKFLOW, "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const job = code.slice(code.indexOf("\n  lock:"));

  it("runs after the gate job records the ruling, and decides even when that job holds a migration", () => {
    assert.match(job, /name: governed paths merge only at the ruled head/, "the required check's name — branch protection keys on it");
    assert.match(job, /needs: ruling/);
    assert.match(job, /if: \$\{\{ always\(\) \}\}/);
  });

  it("holds a read-only token plus the artifact list, from the default branch, the event only via environment", () => {
    assert.match(job, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read\s*\n/);
    assert.doesNotMatch(job, /write/);
    assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /run: node scripts\/ruling-lock\.mjs/);
    assert.match(job, /LABELS: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/, "the current labels, so removing 'ruled' re-locks");
  });
});
