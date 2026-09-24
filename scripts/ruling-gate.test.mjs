// The ruling gate, proved against real git repositories rather than described (NZC-163, hardened).
//
// Each end-to-end case builds a bare "origin" holding `main` and a pull request's head at `refs/pull/1/head`, clones
// the default branch as the gate's trusted checkout, and runs scripts/ruling-gate.mjs exactly as the workflow does:
// in that checkout, with the event in the environment. The case that proves the property the gate exists for is the
// backdated push — ruled, then a commit whose author and committer dates claim to precede the ruling, and red anyway.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { decide, MIGRATIONS_DIR, RULED_LABEL } from "./ruling-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "ruling-gate.mjs");
const WORKFLOW = resolve(HERE, "../.github/workflows/ruling-gate.yml");

// ── The decision ────────────────────────────────────────────────────────────────────────────────────────────────

describe("the decision", () => {
  const migration = [`${MIGRATIONS_DIR}0999_example.sql`];
  const base = { branch: "feat/x", action: "synchronize", labelName: "", labels: [], changedFiles: migration };

  it("holds a hold/ branch whatever it carries and however it is labelled", () => {
    assert.equal(decide({ ...base, branch: "hold/x", changedFiles: [] }).pass, false);
    assert.equal(decide({ ...base, branch: "hold/x", action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] }).pass, false);
  });

  it("passes a diff with no migration, on any event", () => {
    for (const action of ["opened", "synchronize", "reopened", "labeled", "unlabeled"]) {
      assert.equal(decide({ ...base, action, changedFiles: ["apps/console/app/page.tsx"] }).pass, true, action);
    }
  });

  it("holds a migration on every event but the ruled label being applied", () => {
    for (const action of ["opened", "synchronize", "reopened", "unlabeled"]) {
      assert.equal(decide({ ...base, action, labels: [RULED_LABEL] }).pass, false, `${action} with the label present`);
    }
    assert.equal(decide({ ...base, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] }).pass, true);
  });

  it("is not satisfied by applying some other label while ruled is present", () => {
    assert.equal(decide({ ...base, action: "labeled", labelName: "documentation", labels: [RULED_LABEL, "documentation"] }).pass, false);
  });

  it("names what to do when a push has outrun the ruling", () => {
    assert.match(decide({ ...base, labels: [RULED_LABEL] }).reason, /pushed after the ruling.*re-apply 'ruled'/);
  });

  it("reads no date of any kind — the property rests on the event alone", () => {
    // Comments explain why dates are ignored; the code must not consult one. No Date, no git date format or filter,
    // and no git log, the command that would read one.
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /\bDate\b|%[ac][dDrtiIs]\b|--date|--since|--until|--after|--before|"log"/);
  });
});

// ── End to end, against real repositories ───────────────────────────────────────────────────────────────────────

const temp = mkdtempSync(join(tmpdir(), "ruling-gate-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let cases = 0;

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, args, env = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY, ...env } }).trim();
const write = (root, file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };

/** origin with `main` (one existing migration), a work repo for the pull request, and the gate's trusted checkout. */
function repos() {
  cases += 1;
  const root = join(temp, `case-${cases}`);
  const origin = join(root, "origin.git"), work = join(root, "work"), gate = join(root, "gate");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--quiet", "--initial-branch=main", work]);
  write(work, `${MIGRATIONS_DIR}0001_existing.sql`, "SELECT 1;\n");
  write(work, "README.md", "base\n");
  git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]); git(work, ["push", "--quiet", "origin", "main"]);
  const baseSha = git(work, ["rev-parse", "HEAD"]);
  git(work, ["switch", "--quiet", "-c", "feat/pr"]);
  git(root, ["clone", "--quiet", origin, gate]);
  /** Commit in the pull request, optionally with forged dates, and publish it as GitHub does: refs/pull/1/head. */
  const commit = (file, text, dates = {}) => {
    write(work, file, text);
    git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", `change ${file}`], dates);
    git(work, ["push", "--quiet", "--force", "origin", "HEAD:refs/pull/1/head"]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  /** The workflow's step: the trusted checkout, the event in the environment. */
  const run = ({ headSha, action, labelName = "", labels = [], branch = "feat/pr" }) => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: gate, encoding: "utf8",
      env: { ...process.env, PR_NUMBER: "1", HEAD_SHA: headSha, BASE_SHA: baseSha, BRANCH: branch, ACTION: action,
        LABEL_NAME: labelName, LABELS: JSON.stringify(labels), GITHUB_STEP_SUMMARY: "" },
    });
    return { pass: result.status === 0, out: `${result.stdout}${result.stderr}` };
  };
  return { commit, run };
}

describe("end to end, as the workflow runs it", () => {
  it("proves the property: ruled, then a backdated push, and red anyway", () => {
    const { commit, run } = repos();
    const head = commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 2;\n");
    assert.equal(run({ headSha: head, action: "opened" }).pass, false, "an unruled migration went green on opening");
    assert.equal(run({ headSha: head, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] }).pass, true,
      "applying the ruled label did not turn it green");

    // A commit claiming, in both of its dates, to have been written years before the ruling.
    const forged = { GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" };
    const pushed = commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 2; -- changed after the ruling\n", forged);
    const afterPush = run({ headSha: pushed, action: "synchronize", labels: [RULED_LABEL] });
    assert.equal(afterPush.pass, false, "a backdated push after the ruling kept the check green");
    assert.match(afterPush.out, /pushed after the ruling/);

    // Re-ruling is the label applied again, to this head.
    assert.equal(run({ headSha: pushed, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] }).pass, true);
  });

  it("re-holds after the ruling even when the later push does not touch the migration", () => {
    const { commit, run } = repos();
    const head = commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 2;\n");
    assert.equal(run({ headSha: head, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] }).pass, true);
    const pushed = commit("README.md", "changed\n", { GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" });
    assert.equal(run({ headSha: pushed, action: "synchronize", labels: [RULED_LABEL] }).pass, false);
  });

  it("holds a change to an existing migration, not only a new one", () => {
    const { commit, run } = repos();
    const head = commit(`${MIGRATIONS_DIR}0001_existing.sql`, "SELECT 1; -- edited\n");
    const result = run({ headSha: head, action: "synchronize" });
    assert.equal(result.pass, false);
    assert.match(result.out, /0001_existing\.sql/);
  });

  it("holds when the label is removed", () => {
    const { commit, run } = repos();
    const head = commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 2;\n");
    assert.equal(run({ headSha: head, action: "unlabeled", labelName: RULED_LABEL, labels: [] }).pass, false);
  });

  it("passes a pull request that carries no migration", () => {
    const { commit, run } = repos();
    const head = commit("apps/console/app/page.tsx", "export {};\n");
    assert.equal(run({ headSha: head, action: "synchronize" }).pass, true);
  });

  it("holds a hold/ branch with no migration, and does not let a ruling release it", () => {
    const { commit, run } = repos();
    const head = commit("README.md", "import seed\n");
    assert.equal(run({ headSha: head, action: "synchronize", branch: "hold/import-seed" }).pass, false);
    assert.equal(run({ headSha: head, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL], branch: "hold/import-seed" }).pass, false);
  });

  it("judges only the head its event names: a run for a head the pull request has moved past does not pass", () => {
    const { commit, run } = repos();
    const ruledHead = commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 2;\n");
    commit(`${MIGRATIONS_DIR}0999_new.sql`, "SELECT 3;\n");
    const stale = run({ headSha: ruledHead, action: "labeled", labelName: RULED_LABEL, labels: [RULED_LABEL] });
    assert.equal(stale.pass, false, "a ruling event for an older head passed after the pull request moved");
    assert.match(stale.out, /moved to/);
  });
});

// ── The workflow's shape: the rules that make pull_request_target safe here ────────────────────────────────────

describe("the workflow", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const code = yml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

  it("runs from the default branch, on exactly the events a ruling turns on", () => {
    assert.match(code, /pull_request_target:\s*\n\s*types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
    assert.doesNotMatch(code, /^\s*pull_request:/m, "a pull_request trigger would run a copy of the gate the pull request can edit");
  });

  it("holds a read-only token and leaves no credentials in the checkout", () => {
    assert.match(code, /permissions:\s*\n\s*contents: read\s*\n/);
    assert.doesNotMatch(code, /write/);
    assert.match(code, /persist-credentials: false/);
  });

  it("checks out the default branch, never the pull request's head", () => {
    assert.match(code, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.doesNotMatch(code, /ref: \$\{\{ github\.event\.pull_request\.head/);
    assert.doesNotMatch(code, /refs\/pull\/.*\/merge/);
  });

  it("passes the event through the environment, never into a shell line", () => {
    const runLines = code.split("\n").filter((line) => /^\s*run:/.test(line));
    assert.deepEqual(runLines.map((line) => line.trim()), ["run: node scripts/ruling-gate.mjs"]);
  });
});
