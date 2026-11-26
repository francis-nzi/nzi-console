// The nightly real-DB sweep (scripts/nightly-real-db.mjs, .github/workflows/nightly-real-db.yml): it sweeps exactly what CI's
// `migrations` job runs, calls a suite green only on fail 0 and cancelled 0 with its counts present, and on a red opens or
// comments on one issue — on main, on a schedule, never on a pull request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { realDbSuites, report, suiteVerdict } from "./nightly-real-db.mjs";

const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/nightly-real-db.yml", import.meta.url), "utf8");

describe("the suites: ci.yml's migrations job, in its order", () => {
  it("every `npx tsx --test` step of the migrations job, once each, and nothing from another job", () => {
    const suites = realDbSuites(CI);
    const lines = CI.split(/\r?\n/);
    const start = lines.findIndex((line) => line === "  migrations:");
    const end = lines.findIndex((line, at) => at > start && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line));
    const inJob = [...new Set(lines.slice(start, end).flatMap((line) => /run:\s+npx tsx --test (.+)$/.exec(line)?.[1].trim().split(/\s+/) ?? []))];
    assert.deepEqual(suites, inJob);
    assert.ok(suites.includes("packages/isolated-backend/tests/v7Desnz2019Real.test.ts"), "a step naming two files: both swept");
    assert.equal(suites[0], "packages/isolated-backend/tests/migrationsRun.test.ts", "the migrations apply first, as in CI");
    assert.ok(suites.includes("packages/isolated-backend/tests/v7ReingestRevertReal.test.ts"));
    assert.ok(suites.length > 100, `${suites.length} suites`);
  });
  it("a ci.yml without the job, or naming no suite, is refused rather than swept as nothing", () => {
    assert.throws(() => realDbSuites("jobs:\n  checks:\n    steps: []\n"), /no `migrations` job/);
    assert.throws(() => realDbSuites("jobs:\n  migrations:\n    steps:\n      - run: npm ci\n  other:\n"), /names no suites/);
  });
});

describe("a suite's verdict", () => {
  const out = (tests, fail, cancelled) => `# tests ${tests}\n# suites 1\n# pass ${tests - fail - cancelled}\n# fail ${fail}\n# cancelled ${cancelled}\n`;
  it("green only on fail 0 and cancelled 0, with its counts, and a clean exit", () => {
    assert.deepEqual(suiteVerdict(out(6, 0, 0)), { tests: 6, pass: 6, fail: 0, cancelled: 0, green: true });
    assert.equal(suiteVerdict(out(6, 1, 0)).green, false);
    assert.equal(suiteVerdict(out(6, 0, 6)).green, false, "a broken before-hook cancels silently: red");
    assert.equal(suiteVerdict("Error: cannot find module\n", 1).green, false, "a crash prints no counts: red");
    assert.equal(suiteVerdict(out(6, 0, 0), 1).green, false);
  });
  it("the reporter's final counts, not a nested suite's", () => {
    assert.equal(suiteVerdict(`# tests 2\n# fail 1\n# cancelled 0\n${out(9, 0, 0)}`).fail, 0);
  });
});

describe("the report", () => {
  it("totals, then each red suite with its counts; a crash says so", () => {
    const text = report([{ suite: "a.test.ts", tests: 3, pass: 3, fail: 0, cancelled: 0, green: true },
      { suite: "b.test.ts", tests: 5, pass: 3, fail: 1, cancelled: 1, green: false }, { suite: "c.test.ts", tests: null, pass: null, fail: null, cancelled: null, green: false }],
      { sha: "0123456789abcdef", runUrl: "https://example.invalid/run/1" });
    assert.match(text, /^\*\*2 of 3 real-DB suites red\*\* on main at `01234567` — tests 8 · pass 6 · fail 1 · cancelled 1\./);
    assert.match(text, /\| `b\.test\.ts` \| 5 \| 1 \| 1 \|/);
    assert.match(text, /\| `c\.test\.ts` \| — \| — \| — \| no counts: it crashed \|/);
    assert.ok(!text.includes("a.test.ts"), "a green suite is not listed");
    assert.match(text, /Run: https:\/\/example\.invalid\/run\/1/);
  });
});

describe("the workflow", () => {
  it("nightly and by hand, never on a pull request or a push", () => {
    assert.match(WORKFLOW, /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/);
    assert.match(WORKFLOW, /workflow_dispatch:/);
    assert.ok(!/pull_request|^\s*push:/m.test(WORKFLOW));
  });
  it("sweeps main on a throwaway Postgres with throwaway keys, and may only read code and write issues", () => {
    assert.match(WORKFLOW, /ref: main/);
    assert.match(WORKFLOW, /image: postgres:16/);
    assert.match(WORKFLOW, /NZI_SUBJECT_MASTER_KEY=\$\(openssl rand -base64 32\)/);
    assert.match(WORKFLOW, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n/);
    assert.match(WORKFLOW, /run: node scripts\/nightly-real-db\.mjs --report nightly-report\.md/);
  });
  it("on red: one open issue — a comment while it stays open, a new one only when none is", () => {
    assert.match(WORKFLOW, /if: failure\(\)/);
    assert.match(WORKFLOW, /gh issue list --label nightly-real-db --state open/);
    assert.match(WORKFLOW, /gh issue comment "\$open" --body-file nightly-report\.md/);
    assert.match(WORKFLOW, /gh issue create .*--label nightly-real-db --body-file nightly-report\.md/);
  });
});
