// The auto-merge enabler: its decision, and the shape of the workflow that runs it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { decide, governedFiles } from "./auto-merge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(resolve(HERE, "../.github/workflows/auto-merge.yml"), "utf8");
const code = yml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
const ready = { draft: false, fromFork: false, changedFiles: ["apps/console/app/page.tsx"] };

describe("the decision", () => {
  it("enables auto-merge on a ready, same-repo, ungoverned pull request", () => assert.equal(decide(ready).enable, true));
  it("never on a draft or a fork", () => {
    assert.equal(decide({ ...ready, draft: true }).enable, false);
    assert.equal(decide({ ...ready, fromFork: true }).enable, false);
  });
  it("leaves CI config, the gates, the decision register and the deploy config to a human", () => {
    for (const file of [".github/workflows/ci.yml", ".github/workflows/auto-merge.yml", "scripts/ruling-gate.mjs", "scripts/check-terminology.mjs", "scripts/auto-merge.mjs", "docs/DECISIONS.md", "render.yaml"]) {
      assert.equal(decide({ ...ready, changedFiles: ["apps/console/app/page.tsx", file] }).enable, false, file);
    }
    assert.deepEqual(governedFiles(["docs/ARCHITECTURE.md", "packages/ui/src/styles.css"]), []);
  });
  it("does not exempt a migration — that is the ruling gate's job, as a required check", () => {
    assert.equal(decide({ ...ready, changedFiles: ["packages/isolated-backend/migrations/0999_x.sql"] }).enable, true);
  });
});

describe("the workflow", () => {
  it("runs on opened / reopened / ready_for_review only, and skips drafts", () => {
    assert.match(code, /pull_request_target:\s*\n\s*types: \[opened, reopened, ready_for_review\]/);
    assert.match(code, /if: github\.event\.pull_request\.draft == false/);
  });
  it("uses the built-in token with only the two permissions auto-merge needs", () => {
    assert.match(code, /permissions:\s*\n\s*contents: write[^\n]*\n\s*pull-requests: write[^\n]*\n\s*\n/);
    assert.doesNotMatch(code, /secrets\./);
    assert.match(code, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  });
  it("enables squash auto-merge — and does not approve, bypass or merge directly", () => {
    assert.match(code, /gh pr merge "\$PR_NUMBER" --repo "\$REPO" --auto --squash/);
    assert.doesNotMatch(code, /--admin|gh pr review|--approve|--body|--delete-branch|enablePullRequestAutoMerge.*bypass/);
    assert.doesNotMatch(code, /gh pr merge(?![^\n]*--auto)/, "every merge call is the auto form");
  });
  it("is idempotent: already enabled is not a failure", () => assert.match(code, /grep -qi "already"[\s\S]*?Auto-merge was already enabled/));
  it("keeps the pull_request_target rules: trusted checkout, no PR code, event values through env", () => {
    assert.match(code, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(code, /persist-credentials: false/);
    assert.doesNotMatch(code, /github\.event\.pull_request\.head\.(sha|ref)/, "the head is never checked out or fetched");
    const shell = [...code.matchAll(/run: \|\n((?:\s{10,}.*\n?)+)/g)].map((m) => m[1]);
    assert.equal(shell.length, 2, "both shell steps found");
    for (const block of shell) assert.doesNotMatch(block, /\$\{\{/, "no expression inside a shell block");
  });
});
