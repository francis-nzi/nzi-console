/**
 * The v7 re-ingest across the book (RULING-v7-book-runner): `v7.reingest.job` for each job in order, from its crosswalk-v1 plan.
 *
 *   npm run v7:reingest-book -w @nzi/isolated-backend -- --plans <dir> --jobs <J000052,J000163,… | file> \
 *       --residuals <residuals-for-francis.csv> [--signed-off <file>] --report <dir> [--organisation <id>] [--commit]
 *
 * `--plans` holds one `plan-<job number>.json` per job (`V7ReingestJobInput` without `runId`, as `v7-reingest-job` reads). `--jobs`
 * is the order — Kinetics first, then the READY jobs — as a comma list or a file of one job number per line. `--residuals` is
 * Francis's list; `--signed-off` (optional) is the scope_row_ids he has released, one per line. A job naming an open residual is
 * skipped and says so; J000663 is held; a job with no edition of its reporting year gets the preferred one, or is flagged.
 *
 * A dry run unless `--commit`. Each job is its own transaction: a dry run is every job's whole run, rolled back; a commit writes
 * each job that passes its quantity gate and rolls back any that does not, then goes on. `--report` receives `book.csv` (one
 * line per job) and `deltas-<job number>.csv` for every job with a flagged emission delta (the row-by-row diff). Ids and tCO2e
 * only — never a label or money. Fail-closed on the boundary; verified TLS off-machine.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { withTenantWrite } from "../src/postgres";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { openV7Residuals, runV7BookJobInTransaction, type V7BookJobOutcome, type V7BookPlan, type V7BookSkip } from "../src/v7ReingestBook";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const required = (name: string) => { const value = argument(name); if (!value) throw new Error(`${name} is required.`); return value; };
const listOf = (value: string) => (existsSync(value) ? readFileSync(value, "utf8").split(/\r?\n/) : value.split(",")).map((item) => item.trim()).filter(Boolean);
const round3 = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
class Rollback extends Error {}

async function main(): Promise<void> {
  const plansDir = required("--plans"), reportDir = required("--report");
  const jobNumbers = listOf(required("--jobs"));
  const signedOff = new Set(argument("--signed-off") ? listOf(argument("--signed-off")!) : []);
  const openResiduals = openV7Residuals(readFileSync(required("--residuals"), "utf8"), signedOff);
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 re-ingest of the book for ${organisationId} — ${commit ? "COMMIT, job by job" : "dry run: every job's whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  log(`  ${jobNumbers.length} jobs in order · ${openResiduals.size} residual rows open (${signedOff.size} signed off)`);
  mkdirSync(reportDir, { recursive: true });
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-reingest-book" });
  const book: string[] = ["job,job_id,status,rows,v7_tco2e,calc_tco2e,delta_tco2e,delta_pct,flagged,year_edition_added,detail"];
  const tally: Record<string, number> = {};
  try {
    for (const jobNumber of jobNumbers) {
      const file = join(plansDir, `plan-${jobNumber}.json`);
      if (!existsSync(file)) {
        book.push(`${jobNumber},,NO_PLAN,,,,,,,,no plan file (a row the crosswalk could not plan — for Francis)`);
        tally.NO_PLAN = (tally.NO_PLAN ?? 0) + 1;
        log(`  ${jobNumber}: NO_PLAN — no plan-${jobNumber}.json`);
        continue;
      }
      const plan = JSON.parse(readFileSync(file, "utf8")) as V7BookPlan;
      const runId = `v7-reingest-${randomUUID()}`;
      const context = { organisationId, actorId: V7_REINGEST_ACTOR, principal: "system" as const, idempotencyKey: runId, correlationId: runId,
        reason: `v7 re-ingest of ${jobNumber} by the book runner (crosswalk ${plan.crosswalkVersion})${commit ? "" : " — dry run"}`,
        grant: commandGrantForRole("admin", organisationId, V7_REINGEST_ACTOR) };
      const held: { outcome: V7BookJobOutcome | null } = { outcome: null };
      try {
        await withTenantWrite(pool, organisationId, async (db) => {
          held.outcome = await runV7BookJobInTransaction(db, plan, runId, openResiduals, context);
          // Only a committed pass or flag is kept; everything else — and everything in a dry run — is rolled back.
          if (!commit || (held.outcome.status !== "PASS" && held.outcome.status !== "FLAGGED")) throw new Rollback();
        });
      } catch (error) { if (!(error instanceof Rollback)) throw error; }
      const outcome = held.outcome;
      if (!outcome) throw new Error(`${jobNumber}: the job's run returned no outcome.`);
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      if (outcome.status === "PASS" || outcome.status === "FLAGGED") {
        const { result } = outcome, job = result.deltas.job;
        const pct = job.relative === null ? "" : (job.relative * 100).toFixed(2);
        book.push([jobNumber, plan.jobId, outcome.status, plan.rows.length, round3(job.v7Tco2e), round3(job.calcTco2e), round3(job.deltaTco2e), pct,
          result.deltas.flagged.length, outcome.yearEditionAdded ?? "", `run ${result.runId}`].join(","));
        log(`  ${jobNumber}: ${outcome.status}${commit ? "" : " (would commit)"} — ${plan.rows.length} rows · v7 ${round3(job.v7Tco2e)} t · calc ${round3(job.calcTco2e)} t`
          + `${pct ? ` (${pct}%)` : ""} · ${result.deltas.flagged.length} flagged${outcome.yearEditionAdded ? ` · year edition ${outcome.yearEditionAdded} added` : ""}`);
        if (result.deltas.flagged.length) {
          const lines = ["v7_row_id,live_row_id,scope,site_id,v7_tco2e,calc_tco2e,delta_tco2e,delta_pct,flag"];
          for (const row of result.deltas.rows)
            lines.push([row.v7RowId, commit ? row.liveRowId : "", row.scope, row.siteId ?? "unallocated", round3(row.v7Tco2e), round3(row.calcTco2e), round3(row.deltaTco2e),
              row.relative === null ? "" : (row.relative * 100).toFixed(2), row.flag ?? ""].join(","));
          writeFileSync(join(reportDir, `deltas-${jobNumber}.csv`), `${lines.join("\n")}\n`);
        }
      } else if (outcome.status === "REFUSED") {
        const codes = [...new Set(outcome.issues.map((issue) => issue.code))].join(" ");
        book.push(`${jobNumber},${plan.jobId},REFUSED,${plan.rows.length},,,,,,,${codes}`);
        log(`  ${jobNumber}: REFUSED — nothing written · ${outcome.issues.length} issue(s): ${codes}`);
        for (const issue of outcome.issues.slice(0, 5)) log(`      ${issue.code}: ${issue.message}`);
      } else {
        const skip = outcome as { jobId: string } & V7BookSkip;
        book.push(`${jobNumber},${plan.jobId},${skip.status},${plan.rows.length},,,,,,,"${skip.reason.replace(/"/g, "'")}"`);
        log(`  ${jobNumber}: ${skip.status} — ${skip.reason}`);
      }
    }
  } finally {
    await pool.end();
    writeFileSync(join(reportDir, "book.csv"), `${book.join("\n")}\n`);
  }
  log(`\n${commit ? "Committed" : "Dry run"}: ${Object.entries(tally).map(([status, n]) => `${status} ${n}`).join(" · ")}`);
  log(`  report: ${join(reportDir, "book.csv")}${commit ? "" : " — re-run with --commit to write"}`);
  log("  Each PASS or FLAGGED run is then attested by a person (scope.review.attest_reingest) — flagged deltas investigated first.");
}

main().catch((error) => {
  process.stderr.write(`\nv7-reingest-book failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
