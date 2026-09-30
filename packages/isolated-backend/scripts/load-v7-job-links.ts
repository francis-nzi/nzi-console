/**
 * Link imported jobs to their job types and milestone templates, and check the template mapping on real jobs (admin
 * Phase C5).
 *
 *   npm run load:v7-job-links -- <extract directory> [--organisation <id>] [--commit]
 *
 * Runs on the jobs-configuration extract (C4's, which carries `jobs` and `job_plan` — ruled plan §4.4), after
 * `load:v7-jobs-config` has committed: the links resolve to the job types and templates it loaded, by v7 id.
 *
 * A dry run unless `--commit`, and a dry run is the run rolled back. Per link: filled, already linked, conflicts,
 * blank, and v7 ids the console does not carry. Then the milestone parity check: jobs compared, agreement by kind and
 * by template, the first differences (job number, kind, generated, imported, days apart), and the jobs not compared
 * — frozen plans, no template, no anchor, no plan. Job numbers only; no client names. It changes no milestone.
 * Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7JobLinks } from "../src/v7JobLinkLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const LABEL = { jobType: "job type → job_types", milestoneTemplate: "milestone template → milestone_templates" } as const;

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-job-links <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: ["jobs", "job_plan"] });
  log(`\nv7 job links into ${organisationId} — ${commit ? "COMMIT" : "dry run: the run, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  log(`  v7: jobs ${read.extract.jobs.length} · job plans ${read.extract.job_plan.length}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-job-links" });
  try {
    const outcome = await loadV7JobLinks(pool, organisationId, { jobs: read.extract.jobs, job_plan: read.extract.job_plan }, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}): ${outcome.jobsChanged} of ${outcome.jobsInScope} imported jobs changed — each version-bumped, one audit event each`);
    if (outcome.v7JobsNotInConsole) log(`  ${outcome.v7JobsNotInConsole} v7 job(s) in the extract are not in the console (the client import excluded them)`);
    for (const field of ["jobType", "milestoneTemplate"] as const) {
      const t = outcome.tally[field];
      log(`\n  ${LABEL[field]}`);
      log(`    +${t.filled} filled · =${t.alreadyLinked} already linked · ${t.conflicts} conflicts · ${t.blank} blank in v7 · ${t.notLoaded} not loaded here`);
      for (const missing of outcome.notLoaded[field]) log(`    v7 id ${missing.legacyId} is not loaded here — ${missing.jobs} job(s) left unlinked`);
    }
    if (outcome.conflicts.length) {
      log(`\nCONFLICTS — a link already set differs from v7's; reported, not overwritten (${outcome.conflicts.length}):`);
      for (const conflict of outcome.conflicts) log(`  ${conflict.jobNumber} ${conflict.field}: set to ${conflict.current}, v7 names ${conflict.v7}`);
      process.exitCode = 1;
    }

    const p = outcome.parity;
    log(`\nMilestone parity — PR 3's generation (anchor + each included item's offset, by kind) against the dates imported from v7`);
    log(`  compared ${p.compared} job(s) · not compared: ${p.frozen} frozen (override_dates) · ${p.noTemplate} no template · ${p.templateNotLoaded} template not loaded · ${p.noAnchor} no anchor · ${p.noPlan} no plan (never edited in v7)`);
    for (const [kind, k] of Object.entries(p.byKind)) log(`    ${kind.padEnd(16)} ${k.agree} agree · ${k.differ} differ · ${k.v7Undated} undated in v7`);
    for (const template of p.byTemplate) log(`    template "${template.template}": ${template.jobs} job(s) · ${template.agree} agree · ${template.differ} differ`);
    if (p.differenceCount) {
      log(`  differences (${p.differenceCount}; the first ${p.differences.length}):`);
      for (const d of p.differences) log(`    ${d.jobNumber} ${d.template} ${d.kind}: generated ${d.generated}, imported ${d.imported} (${d.days > 0 ? "+" : ""}${d.days}d)`);
    }
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-job-links failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
