// The nightly real-DB sweep (Francis, 26 Nov 2026): every real-Postgres suite CI's `migrations` job runs, run again on main each
// night, one at a time, so a suite that goes red without a change — a date, a season, a slow drift — is found the next morning,
// not on the next pull request that happens to touch it.
//
// The suite list is read from .github/workflows/ci.yml's `migrations` job (each `npx tsx --test <file>` in order), never kept
// here: a suite added to CI is in the nightly sweep the same day. A suite is green only on `fail 0` AND `cancelled 0` with its
// counts present — a broken before-hook cancels its tests silently, and a crash prints no counts at all.
//
//   node scripts/nightly-real-db.mjs [--report <file.md>]
//
// Exits 1 when any suite is red. The workflow (nightly-real-db.yml) then opens an issue, or comments on the one already open.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The suites the `migrations` job runs, in its order, each once. */
export function realDbSuites(ciYaml) {
  const lines = ciYaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}migrations:\s*$/.test(line));
  if (start < 0) throw new Error("ci.yml has no `migrations` job.");
  const end = lines.findIndex((line, at) => at > start && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line));
  const suites = [];
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    // A step may name more than one file (`npx tsx --test a.test.ts b.test.ts`): each is a suite of its own here.
    const found = /^\s+run:\s+npx tsx --test ((?:\S+\.test\.ts\s*)+)$/.exec(line);
    for (const file of found ? found[1].trim().split(/\s+/) : []) if (!suites.includes(file)) suites.push(file);
  }
  if (!suites.length) throw new Error("ci.yml's `migrations` job names no suites.");
  return suites;
}

/** One suite's counts from node's test reporter, and whether it is green. */
export function suiteVerdict(output, exitCode = 0) {
  const count = (name) => { const all = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm"))]; return all.length ? Number(all.at(-1)[1]) : null; };
  const tests = count("tests"), pass = count("pass"), fail = count("fail"), cancelled = count("cancelled");
  const green = tests !== null && fail === 0 && cancelled === 0 && exitCode === 0;
  return { tests, pass, fail, cancelled, green };
}

/** The report: a line of totals, then every red suite with its counts. Markdown, for the issue and the run summary. */
export function report(results, { sha = "", runUrl = "" } = {}) {
  const red = results.filter((entry) => !entry.green);
  const sum = (key) => results.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  const head = `${red.length ? `**${red.length} of ${results.length} real-DB suites red**` : `All ${results.length} real-DB suites green`} on main${sha ? ` at \`${sha.slice(0, 8)}\`` : ""}`
    + ` — tests ${sum("tests")} · pass ${sum("pass")} · fail ${sum("fail")} · cancelled ${sum("cancelled")}.`;
  const rows = red.map((entry) => `| \`${entry.suite}\` | ${entry.tests ?? "—"} | ${entry.fail ?? "—"} | ${entry.cancelled ?? "—"} |${entry.tests === null ? " no counts: it crashed |" : " |"}`);
  return [head, ...(red.length ? ["", "| Suite | tests | fail | cancelled | |", "|---|---|---|---|---|", ...rows] : []), ...(runUrl ? ["", `Run: ${runUrl}`] : [])].join("\n") + "\n";
}

function main() {
  const at = process.argv.indexOf("--report");
  const out = at > 0 ? process.argv[at + 1] : null;
  const suites = realDbSuites(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const results = [];
  for (const suite of suites) {
    const run = spawnSync("npx", ["tsx", "--test", suite], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
    const verdict = suiteVerdict(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, run.status ?? 1);
    results.push({ suite, ...verdict });
    process.stdout.write(`${verdict.green ? "green" : "RED  "}  ${suite}  tests ${verdict.tests ?? "—"} fail ${verdict.fail ?? "—"} cancelled ${verdict.cancelled ?? "—"}\n`);
    if (!verdict.green) process.stdout.write(`${(run.stdout ?? "").split("\n").filter((line) => /^\s*not ok|error:/.test(line)).slice(0, 20).join("\n")}\n`);
  }
  const text = report(results, { sha: process.env.GITHUB_SHA ?? "", runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "" });
  if (out) writeFileSync(out, text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.stdout.write(`\n${text}`);
  process.exitCode = results.every((entry) => entry.green) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
