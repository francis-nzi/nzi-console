/**
 * Rehearse the v7 re-sync routine for one job — revert the standing re-ingest → re-sync → re-plan → re-ingest — in ONE
 * transaction that is always rolled back (src/v7ResyncRehearsal.ts). It never writes: there is no --commit, and passing one is
 * refused. Use it to see the re-sync's counts and Σ live against Σ v7 per scope before running the real steps one by one.
 *
 *   npm run v7:resync-rehearse -w @nzi/isolated-backend -- --extract <one-job extract dir> --job J000669 --reason "<why>" \
 *       [--plan <plan.json>] [--organisation <id>]
 *
 * `--extract` is a one-job extract of this job (v7-extract-sql.mjs and v7-extract-manifest.mjs with the same --job); `--plan` is the
 * job's committed crosswalk plan, `data/v7-crosswalk-v1/plan-<job>.json` by default. Fail-closed on the boundary; verified TLS
 * off-machine. Prints row ids and tCO2e only — no quantities, no labels beyond the plan's, no client data.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { V7ReingestJobInput } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport } from "../src/v7ClientImport";
import { rehearseV7Resync, type V7RehearsalReport } from "../src/v7ResyncRehearsal";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const t = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

function printRehearsal(report: V7RehearsalReport, jobNumber: string): void {
  log(`\n1. revert the standing re-ingest: ${report.revert ? `${report.revert.runId} — live rows off ${report.revert.liveRowsSwitchedOff} · v7 rows on ${report.revert.v7RowsSwitchedOn}` : report.refusal?.stage === "revert" ? "REFUSED" : "none standing"}`);
  if (report.resync) {
    const r = report.resync;
    log(`2. re-sync: unchanged ${r.unchanged} · superseded ${r.superseded.length} · added ${r.added.length} · withdrawn ${r.withdrawn.length}`);
    for (const row of r.superseded) log(`     ${row.rowId} → ${row.replacedBy}`);
    for (const id of r.added) log(`     + ${id}`);
    for (const id of r.withdrawn) log(`     − ${id} (gone from v7)`);
  } else if (report.refusal?.stage === "resync") log("2. re-sync: REFUSED");
  if (report.replan) {
    const p = report.replan;
    log(`3. re-plan onto the current rows: ${p.rows.length} plan rows — unchanged ${p.unchanged} · carried to v7's current figures ${p.carried.length} · dropped ${p.dropped.length} · need the crosswalk ${p.needsCrosswalk.length}`);
    for (const row of p.carried) log(`     ${row.from} → ${row.to}`);
    for (const id of p.dropped) log(`     − ${id} (off or gone in v7)`);
    for (const row of p.needsCrosswalk) log(`     ? ${row.rowId}: ${row.why}`);
  }
  if (report.reingest) {
    const d = report.reingest;
    log(`4. re-ingest: would commit — D7 met · Σ v7 ${t(d.v7TotalTco2e)} t · Σ live ${t(d.nativeTotalTco2e)} t · v7 rows switched off ${d.v7RowsSwitchedOff}`);
    for (const [scope, totals] of Object.entries(d.scopeTotals)) log(`     scope ${scope}: Σ v7 ${t(totals.v7)} t · Σ live ${t(totals.native)} t`);
    log(`     rows: ${Object.entries(d.rowsByDisposition).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  } else if (report.refusal?.stage === "reingest") log("4. re-ingest: REFUSED");
  if (report.v7ScopeTotals) {
    log(`\nΣ v7 per scope over ${jobNumber}'s current, enabled v7 rows after the re-sync (what the re-ingest must reconcile to):`);
    for (const [scope, totals] of Object.entries(report.v7ScopeTotals).sort()) log(`     scope ${scope}: ${totals.rows} rows · Σ v7 ${t(totals.v7)} t`);
  }
  if (report.refusal) {
    log(`\nRefused at ${report.refusal.stage}; the steps after it did not run:`);
    for (const issue of report.refusal.issues) log(`     ${issue.code} — ${issue.message}`);
  }
  log("\nRehearsal: the whole routine in one transaction, rolled back. Nothing was written.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--commit")) throw new Error("The rehearsal never writes: there is no --commit. Run the real steps one by one to write.");
  const jobNumber = argument("--job"), reason = argument("--reason")?.trim(), extract = argument("--extract");
  if (!jobNumber || !/^J\d{6}$/.test(jobNumber)) throw new Error("--job <one J number, e.g. J000669> is required.");
  if (!reason) throw new Error("--reason \"<why>\" is required.");
  if (!extract) throw new Error("--extract <one-job extract dir> is required.");
  const planFile = argument("--plan") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "v7-crosswalk-v1", `plan-${jobNumber}.json`);
  if (!existsSync(planFile)) throw new Error(`${planFile}: no crosswalk plan for ${jobNumber}.`);
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Omit<V7ReingestJobInput, "runId">;
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;

  const read = readV7Extract(extract, { job: jobNumber });
  const planned = planV7ClientImport({ extract: read.extract, headers: read.headers, extractSha256: read.extractSha256, organisationId, extractProblems: read.problems });
  if (planned.refusals.length) {
    log(`\nThe extract's plan carries ${planned.refusals.length} refusal(s); nothing runs:`);
    for (const finding of planned.refusals) log(`  ${finding.code} ×${finding.count} — ${finding.message}`);
    process.exitCode = 1;
    return;
  }
  const jobs = planned.clients.flatMap((client) => client.jobs).filter((job) => job.legacyJobNumber === jobNumber);
  if (jobs.length !== 1) throw new Error(`${jobNumber} is ${jobs.length === 0 ? "not in the extract" : `in the extract ${jobs.length} times`}; nothing runs.`);
  const job = jobs[0]!;
  if (plan.jobId !== job.jobId) throw new Error(`${planFile} is the plan of ${plan.jobId}, not ${job.jobId}; nothing runs.`);

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 re-sync REHEARSAL of ${jobNumber} (${job.jobId}) for ${organisationId} — one transaction, always rolled back`);
  log(`  connection: ${tls.description} · reason: ${reason}`);
  log(`  extract sha256 ${read.extractSha256} · ${job.rows.length} v7 row(s) in v7 now · plan ${plan.crosswalkVersion} (${plan.rows.length} rows)`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-resync-rehearse" });
  try {
    const report = await rehearseV7Resync(pool, { organisationId, jobId: job.jobId, reason, resyncRunId: `v7-resync-${randomUUID()}`,
      extractSha256: read.extractSha256, rows: job.rows, plan, reingestRunId: `v7-reingest-${randomUUID()}` });
    printRehearsal(report, jobNumber);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-resync-rehearse failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
