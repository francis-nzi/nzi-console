/**
 * The import workbench, Phase 3: ingest one job from its resolved decisions (src/v7ImportIngest.ts; R-A option 1 — run here,
 * where the one-job extract is; the service never sees it).
 *
 *   npm run v7:import-ingest -w @nzi/isolated-backend -- --extract <one-job extract dir> --job J000669 --reason "<why>" \
 *       [--plan <plan.json>] [--organisation <id>] [--commit] [--attest]
 *
 * 1. Reads the job's decisions from the console and checks it is ready to ingest now: the latest summary is of this extract, it
 *    still describes the job's rows, and every row that differs is resolved (a carried pair, a valid mapping, a confirmed
 *    withdrawal). Refused otherwise, with nothing written.
 * 2. Rehearses the whole chain — revert → re-sync → re-plan (the committed plan, completed from the decisions) → re-ingest, D7
 *    the floor — in one transaction that is always rolled back, prints it, and records it for the import view.
 * 3. With --commit, and only if the rehearsal would commit: runs the same chain, kept, through `import.ingest` (a reason is
 *    required; audited by the job with run ids and counts).
 * 4. With --attest (and --commit), SEED_ACTOR_ID — the PERSON attesting, holding snapshot.review — attests the run through the
 *    governed batch attest; a run with a flagged emission delta is skipped and stays a per-job attest.
 *
 * `--plan` is the job's committed crosswalk plan, `data/v7-crosswalk-v1/plan-<job>.json` by default; a job with none is planned
 * from its decisions alone. Fail-closed on the boundary; verified TLS off-machine. Prints ids, counts and tCO2e only.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { commandGrantForRole, V7_IMPORT_INGEST_ACTOR, type V7ReingestJobInput } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport } from "../src/v7ClientImport";
import { batchAttestReingestRuns } from "../src/v7BatchAttest";
import { ingestV7ImportJob, recordV7ImportRehearsal, rehearseV7ImportIngest } from "../src/v7ImportIngest";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const t = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

async function main(): Promise<void> {
  const jobNumber = argument("--job"), reason = argument("--reason")?.trim(), extract = argument("--extract");
  if (!jobNumber || !/^J\d{6}$/.test(jobNumber)) throw new Error("--job <one J number, e.g. J000669> is required.");
  if (!reason) throw new Error("--reason \"<why>\" is required.");
  if (!extract) throw new Error("--extract <one-job extract dir> is required.");
  const commit = process.argv.includes("--commit"), attest = process.argv.includes("--attest");
  if (attest && !commit) throw new Error("--attest attests the committed run: pass --commit with it.");
  if (attest && !process.env.SEED_ACTOR_ID) throw new Error("--attest needs SEED_ACTOR_ID, the person attesting.");
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
  const planFile = argument("--plan") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "v7-crosswalk-v1", `plan-${jobNumber}.json`);
  const basePlan: Omit<V7ReingestJobInput, "runId"> = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8"))
    : { jobId: job.jobId, crosswalkVersion: "none", crosswalkSha256: createHash("sha256").update("").digest("hex"), vintageDatasetIds: [], rows: [] };
  if (basePlan.jobId !== job.jobId) throw new Error(`${planFile} is the plan of ${basePlan.jobId}, not ${job.jobId}; nothing runs.`);

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nImport ingest of ${jobNumber} (${job.jobId}) for ${organisationId} — ${commit ? "rehearse, then COMMIT" : "rehearsal only (rolled back)"}`);
  log(`  connection: ${tls.description} · reason: ${reason}`);
  log(`  extract sha256 ${read.extractSha256} · ${job.rows.length} row(s) in the previous system now · committed plan: ${existsSync(planFile) ? `${basePlan.crosswalkVersion} (${basePlan.rows.length} rows)` : "none — the decisions alone"}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-import-ingest" });
  const context = (key: string, withReason: boolean) => ({ organisationId, actorId: V7_IMPORT_INGEST_ACTOR, principal: "system" as const, idempotencyKey: key, correlationId: key,
    ...(withReason ? { reason } : {}), grant: commandGrantForRole("admin", organisationId, V7_IMPORT_INGEST_ACTOR) });
  try {
    const run = { organisationId, jobId: job.jobId, legacyJobNumber: jobNumber, reason, extractSha256: read.extractSha256, rows: job.rows, basePlan };
    const { report, record } = await rehearseV7ImportIngest(pool, run);
    log("\nRehearsal (one transaction, rolled back):");
    if (report.refusal?.stage === "ready") log("  0. ready to ingest: REFUSED");
    if (report.revert) log(`  1. revert the standing re-ingest ${report.revert.runId}: live rows off ${report.revert.liveRowsSwitchedOff} · rows on ${report.revert.v7RowsSwitchedOn}`);
    if (report.resync) log(`  2. re-sync: unchanged ${report.resync.unchanged} · superseded ${report.resync.superseded.length} · added ${report.resync.added.length} · withdrawn ${report.resync.withdrawn.length}`);
    if (record?.counts.plan) log(`  3. plan: ${record.counts.plan.committed} row(s) from the committed plan · ${record.counts.plan.decided} from the decisions`);
    if (report.reingest) {
      log(`  4. re-ingest: would commit — D7 met · Σ v7 ${t(report.reingest.v7TotalTco2e)} t · Σ live ${t(report.reingest.nativeTotalTco2e)} t`);
      for (const [scope, totals] of Object.entries(report.reingest.scopeTotals)) log(`     scope ${scope}: Σ v7 ${t(totals.v7)} t · Σ live ${t(totals.native)} t`);
    }
    if (report.refusal) {
      log(`\n  Refused at ${report.refusal.stage}; the steps after it did not run:`);
      for (const issue of report.refusal.issues) log(`     ${issue.code} — ${issue.message}`);
    }
    if (record) {
      const key = `v7-import-rehearsal-${randomUUID()}`;
      const recorded = await recordV7ImportRehearsal(pool, { jobId: job.jobId, rehearsal: record }, context(key, false));
      log(`  recorded for the import view: ${recorded.data.ingestId} (${record.outcome})`);
    }
    if (!commit) { log("\nRehearsal only. Re-run with --commit to ingest."); return; }
    if (!record || record.outcome !== "would-commit") { log("\nThe rehearsal did not reconcile, so nothing is committed."); process.exitCode = 1; return; }

    const key = `v7-import-ingest-${randomUUID()}`;
    const outcome = await ingestV7ImportJob(pool, { jobId: job.jobId, sessionId: record.sessionId, extractSha256: read.extractSha256, decisionsSha256: record.decisionsSha256 },
      run, context(key, true));
    const d = outcome.data;
    log(`\nIngested: ${d.ingestId} · re-sync ${d.resyncRunId} · re-ingest ${d.reingestRunId}`);
    log(`  re-sync: superseded ${d.resync.superseded} · added ${d.resync.added} · withdrawn ${d.resync.withdrawn} · plan ${d.plan.committed} committed + ${d.plan.decided} decided`);
    if (!attest) { log("\nNot attested: a reviewer attests the run (or re-run with --attest and SEED_ACTOR_ID)."); return; }
    const attested = await batchAttestReingestRuns(pool, { organisationId, actorId: process.env.SEED_ACTOR_ID!, reason, commit: true, jobNumbers: [jobNumber] });
    for (const entry of attested.runs) log(`  attest ${entry.runId}: ${entry.status} · approved ${entry.approved} · gaps resolved ${entry.gapsResolved}${entry.flagged ? ` · ${entry.flagged} flagged — attest per job` : ""}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-import-ingest failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
