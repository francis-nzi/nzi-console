/**
 * The batch bring-in for spanning jobs (BRIEF-v7-import-spanning-batch): every imported job over two calendar years, through the fast
 * path with the previous system's own row figures (endpoint 2).
 *
 *   NZI_V7_VIEW_URL=… NZI_V7_FIGURES_URL=… NZI_V7_FIGURES_TOKEN=… \
 *     npm run v7:import-spanning-batch -w @nzi/isolated-backend -- --as <Admin user id> [--jobs <J000265,… | file>] \
 *       [--report <file.csv>] [--organisation <id>] [--behind-only] [--commit]
 *
 * A dry run unless `--commit`: each job's preview, rolled back — the jobs that would come in, with before and after per scope beside
 * the previous system's own, and the jobs skipped, each with its reasons (one per row the refusal names). A clean job (already brought
 * in, nothing changed since) is NOTHING TO BRING IN with its latest drift check — or, behind, NEEDS RE-PRICING (BACKFILL) with its
 * per-scope gaps. `--behind-only` takes only the spanning jobs whose latest drift check says behind. `--commit` brings in each job
 * the fast path takes, then runs its drift check. One job at a time, endpoint 2 through the 2 s floor. `--as` is the Admin it runs as
 * (their grant re-derived per job). `--report` writes the same list as CSV: ids, codes and tCO2e, never a label. The log and the CSV
 * both end with the jobs per outcome.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { v7FiguresClientFromEnv, v7RowFiguresClientFromEnv } from "../src/v7Drift";
import { v7ImportViewSource } from "../src/v7ImportRefresh";
import { runV7SpanningBatch, v7SpanningBatchCsv, v7SpanningBatchLines, v7SpanningBatchTotalsLines } from "../src/v7ImportSpanningBatch";
import { v7ImportViewPoolConfig } from "../src/v7ImportView";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const listOf = (value: string) => (existsSync(value) ? readFileSync(value, "utf8").split(/\r?\n/) : value.split(",")).map((item) => item.trim()).filter(Boolean);

async function main(): Promise<void> {
  const actorId = argument("--as");
  if (!actorId) throw new Error("--as <the Admin's user id> is required: the batch runs as them.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const jobNumbers = argument("--jobs") ? listOf(argument("--jobs")!) : undefined;
  const report = argument("--report");
  const commit = process.argv.includes("--commit");
  const behindOnly = process.argv.includes("--behind-only");
  const view = v7ImportViewPoolConfig();
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nBatch bring-in of spanning jobs for ${organisationId} — ${commit ? "COMMIT, job by job" : "dry run: each job's preview, rolled back"}`);
  log(`  source: the view set · ${view.description}`);
  log(`  console: ${tls.description}`);
  const sourcePool = new Pool(view);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-spanning-batch" });
  try {
    const runId = randomUUID();
    const result = await runV7SpanningBatch(pool, organisationId, {
      runId, actorId, commit, jobNumbers, behindOnly, source: v7ImportViewSource(sourcePool),
      rowFigures: v7RowFiguresClientFromEnv(process.env), figures: v7FiguresClientFromEnv(process.env),
      onJob: (outcome) => { for (const line of v7SpanningBatchLines(outcome, commit)) log(line); },
    });
    log(`\n${commit ? "Committed" : "Dry run"} (run ${runId})${behindOnly ? " · behind only" : ""}${result.stopped === "source-unresponsive" ? " · STOPPED: the source stopped answering" : ""}`);
    for (const line of v7SpanningBatchTotalsLines(result.outcomes, commit)) log(line);
    if (report) { writeFileSync(report, v7SpanningBatchCsv(result.outcomes, commit)); log(`  report: ${report}`); }
    if (!commit) log("  Nothing was written. Re-run with --commit to bring them in.");
  } finally {
    await sourcePool.end();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-import-spanning-batch failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
