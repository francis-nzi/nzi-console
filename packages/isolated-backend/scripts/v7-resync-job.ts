/**
 * Re-sync one v7 job's migrated rows to v7's current records (RULING-v7-resync-job v2; 0225), or revert a re-sync.
 *
 *   npm run v7:resync -w @nzi/isolated-backend -- --extract <dir> --job J000669 --reason "<why>" [--organisation <id>] [--commit]
 *   npm run v7:resync -w @nzi/isolated-backend -- --revert <runId> --job J000669 --reason "<why>" [--organisation <id>] [--commit]
 *
 * `--extract` is a current live-v7 extract (scripts/v7-extract-sql.mjs + v7-extract-manifest.mjs), planned by the importer exactly
 * as the client load plans it; only the named job's rows are taken (R5: one job, named by its J number). A dry run unless
 * `--commit`, and a dry run is the whole re-sync, its post-condition included, rolled back. Afterwards the job's existing
 * re-ingest is re-planned from the refreshed rows and re-run. Fail-closed on the boundary; verified TLS off-machine. Prints row
 * ids and counts only — no figures, no client data.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport } from "../src/v7ClientImport";
import { resyncV7JobInTransaction, revertV7ResyncInTransaction, runInResyncTransaction, V7_RESYNC_ACTOR, v7ResyncContext } from "../src/v7Resync";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const jobNumber = argument("--job"), reason = argument("--reason")?.trim(), extract = argument("--extract"), revertRun = argument("--revert");
  if (!jobNumber || !/^J\d{6}$/.test(jobNumber)) throw new Error("--job <one J number, e.g. J000669> is required: a re-sync is one named job.");
  if (!reason) throw new Error("--reason \"<why>\" is required.");
  if (!!extract === !!revertRun) throw new Error("Give exactly one of --extract <dir> (re-sync) or --revert <runId>.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const context = v7ResyncContext(organisationId, reason);
  const mode = commit ? "COMMIT" : "dry run: the whole run, rolled back";

  if (revertRun) {
    log(`\nv7 re-sync revert of ${revertRun} on ${jobNumber} for ${organisationId} — ${mode}`);
    log(`  connection: ${tls.description} · as ${V7_RESYNC_ACTOR} (system) · reason: ${reason}`);
    const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-resync" });
    try {
      const result = await runInResyncTransaction(pool, organisationId, commit, async (db) => {
        const found = (await db.query<{ job_id: string }>(
          `SELECT job_id FROM nzi_console.jobs WHERE organisation_id = $1 AND legacy_job_number = $2 AND source_system = 'nzi-pro-v7'`, [organisationId, jobNumber])).rows;
        if (found.length !== 1) throw new Error(`${jobNumber} names ${found.length} v7 jobs here; nothing is reverted.`);
        return revertV7ResyncInTransaction(db, { jobId: found[0]!.job_id, runId: revertRun }, context);
      });
      log(`\n${commit ? "Reverted" : "Would revert"}: ${result.restored.length} superseded row(s) current again · ${result.switchedOff.length} re-synced row(s) off · ${result.reenabled.length} withdrawn row(s) back on`);
      if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
    } finally {
      await pool.end();
    }
    return;
  }

  const read = readV7Extract(extract!);
  const plan = planV7ClientImport({ extract: read.extract, headers: read.headers, extractSha256: read.extractSha256, organisationId, extractProblems: read.problems });
  if (plan.refusals.length) {
    log(`\nThe extract's plan carries ${plan.refusals.length} refusal(s); nothing runs:`);
    for (const finding of plan.refusals) log(`  ${finding.code} ×${finding.count} — ${finding.message}`);
    process.exitCode = 1;
    return;
  }
  const jobs = plan.clients.flatMap((client) => client.jobs).filter((job) => job.legacyJobNumber === jobNumber);
  if (jobs.length !== 1) throw new Error(`${jobNumber} is ${jobs.length === 0 ? "not in the extract" : `in the extract ${jobs.length} times`}; nothing runs.`);
  const job = jobs[0]!;
  const runId = `v7-resync-${randomUUID()}`;
  log(`\nv7 re-sync of ${jobNumber} (${job.jobId}) for ${organisationId} — ${mode}`);
  log(`  connection: ${tls.description} · as ${V7_RESYNC_ACTOR} (system) · reason: ${reason}`);
  log(`  run ${runId} · extract sha256 ${read.extractSha256} · ${job.rows.length} v7 row(s) in v7 now`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-resync" });
  try {
    const result = await runInResyncTransaction(pool, organisationId, commit, (db) =>
      resyncV7JobInTransaction(db, { jobId: job.jobId, runId, extractSha256: read.extractSha256, rows: job.rows }, context));
    log(`\n${commit ? "Re-synced" : "Would re-sync"} — post-condition met (every v7 record has one current row, equal to v7's)`);
    log(`  unchanged ${result.unchanged} · superseded ${result.superseded.length} · added ${result.added.length} · withdrawn ${result.withdrawn.length}`);
    for (const row of result.superseded) log(`  ${row.rowId} → ${row.replacedBy}`);
    for (const rowId of result.added) log(`  + ${rowId}`);
    for (const rowId of result.withdrawn) log(`  − ${rowId} (gone from v7: switched off)`);
    log(`\nNext: re-plan ${jobNumber} from its current v7 rows, then the re-ingest dry run.${commit ? "" : " (Dry run complete: nothing written. Re-run with --commit to write.)"}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-resync-job failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
