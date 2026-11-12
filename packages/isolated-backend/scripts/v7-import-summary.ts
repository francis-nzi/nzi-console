/**
 * The import workbench, Phase 1: make one job's reconciliation summary on this machine, and optionally upload it
 * (src/v7ImportSummary.ts; diff-at-the-edge). The extract is read here and never leaves this machine — only the summary does.
 *
 *   npm run v7:import-summary -w @nzi/isolated-backend -- --extract <one-job extract dir> --job J000669 --out <summary.json> \
 *       [--upload] [--organisation <id>]
 *
 * Without --upload it reads the console and writes the summary file. A job already re-ingested is compared as the ingest will see
 * it — its standing run reverted under a savepoint that is rolled back — so nothing of the console is kept. With
 * --upload it also stores that summary through `import.summary.upload` as the system principal `policy:v7-import`, so the
 * import view shows it. It never writes a job's rows. Fail-closed on the boundary; verified TLS off-machine. Prints counts and
 * the verdict only.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { commandGrantForRole, v7ImportSummaryIssues } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { withTenantWrite } from "../src/postgres";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport } from "../src/v7ClientImport";
import { summariseV7JobAsTheChainSees } from "../src/v7ImportIngest";
import { uploadV7ImportSummary, V7_IMPORT_ACTOR } from "../src/v7ImportSummary";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const jobNumber = argument("--job"), extract = argument("--extract"), out = argument("--out");
  if (!jobNumber || !/^J\d{6}$/.test(jobNumber)) throw new Error("--job <one J number, e.g. J000669> is required.");
  if (!extract) throw new Error("--extract <one-job extract dir> is required.");
  if (!out) throw new Error("--out <summary.json> is required.");
  const upload = process.argv.includes("--upload");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;

  const read = readV7Extract(extract, { job: jobNumber });
  const planned = planV7ClientImport({ extract: read.extract, headers: read.headers, extractSha256: read.extractSha256, organisationId, extractProblems: read.problems });
  if (planned.refusals.length) {
    log(`\nThe extract's plan carries ${planned.refusals.length} refusal(s); no summary is made:`);
    for (const finding of planned.refusals) log(`  ${finding.code} ×${finding.count} — ${finding.message}`);
    process.exitCode = 1;
    return;
  }
  const jobs = planned.clients.flatMap((client) => client.jobs).filter((job) => job.legacyJobNumber === jobNumber);
  if (jobs.length !== 1) throw new Error(`${jobNumber} is ${jobs.length === 0 ? "not in the extract" : `in the extract ${jobs.length} times`}; no summary is made.`);
  const job = jobs[0]!;

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nImport summary of ${jobNumber} (${job.jobId}) for ${organisationId} · ${tls.description}`);
  log(`  extract sha256 ${read.extractSha256} · ${job.rows.length} row(s) in the previous system now`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-import-summary" });
  try {
    // As the ingest will see it: a standing re-ingest reverted first, under a savepoint rolled back — nothing is kept.
    const summary = await withTenantWrite(pool, organisationId, (db) => summariseV7JobAsTheChainSees(db, {
      organisationId, jobId: job.jobId, legacyJobNumber: jobNumber, extractSha256: read.extractSha256, rows: job.rows }));
    const issues = v7ImportSummaryIssues(summary);
    if (issues.length) throw new Error(`The summary is not well formed: ${JSON.stringify(issues)}`);
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
    const c = summary.counts;
    log(`  matched ${c.matched} · changed ${c.changed} · needs mapping ${c.needsMapping} · new ${c.new} · withdrawn ${c.withdrawn} · linked pair changed ${c.linkedPairChanged}`);
    log(`  verdict: ${summary.verdict} · written to ${out}`);
    if (!upload) { log("\nNot uploaded (pass --upload to store it for the import view)."); return; }
    const key = `v7-import-upload-${randomUUID()}`;
    const outcome = await uploadV7ImportSummary(pool, { jobId: job.jobId, summary }, {
      organisationId, actorId: V7_IMPORT_ACTOR, principal: "system", idempotencyKey: key, correlationId: key,
      grant: commandGrantForRole("admin", organisationId, V7_IMPORT_ACTOR) });
    log(`\nUploaded: session ${outcome.data.sessionId} (${outcome.data.rows} rows). The job's rows were not touched.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-import-summary failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
