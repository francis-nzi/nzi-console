/**
 * The job-derived baseline (kickoff `BASELINE-derive-build-kickoff.md`): each client with no baseline in force takes
 * its benchmark from one of its own v7 jobs, through client.update — the audited re-baseline path.
 *
 *   npm run derive:baselines -w @nzi/isolated-backend -- [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole run, rolled back. Reads only the console (staging): the
 * migrated jobs and scope rows. The report names each client (a business, not a person), its chosen job, the rule
 * step, the period with the console's FY label, the figures, and the net-zero year for the AFTER_BENCHMARK check; and
 * lists the held clients (a stated period no candidate matches) for the manual pass. Fail-closed on the boundary;
 * verified TLS off-machine.
 */
import { Pool } from "pg";
import { consoleFyLabel, loadBaselineDerive } from "../src/baselineDerive";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const t = (value: number | null) => value === null ? "—" : value.toFixed(2);

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nJob-derived baselines for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-baseline-derive" });
  try {
    const { plan, results, runId } = await loadBaselineDerive(pool, organisationId, { commit });
    const written = results.filter((r) => r.result === "written"), refused = results.filter((r) => r.result === "refused");
    const steps = new Map<string, number>();
    for (const r of plan.derive) steps.set(r.ruleStep, (steps.get(r.ruleStep) ?? 0) + 1);
    log(`  run ${runId}`);
    log(`\nPopulation: ${plan.population.noBaselineInForce} clients with no baseline in force · ${plan.population.withCandidate} with a usable candidate job`);
    log(`  to derive: ${plan.derive.length} (${[...steps].map(([step, n]) => `${step} ${n}`).join(" · ")})`);
    log(`  held for the manual pass (a stated period no candidate matches): ${plan.held.length}`);
    log(`  left out (candidate rows, but no usable total): ${plan.noUsableTotal.length}`);
    log(`\n${commit ? "Written" : "Would write"}: ${written.length} · refused: ${refused.length} · governed re-baselines (a stated period was held): ${written.filter((r) => r.governed).length}`
      + ` · initial baselines: ${written.filter((r) => !r.governed).length}`);
    log(`  AFTER_BENCHMARK collisions (period start year ≥ net-zero year): ${results.filter((r) => r.afterBenchmarkCollision).length}`);
    const others = written.filter((r) => r.otherChanges.length > 0);
    log(`  saves that changed anything besides the baseline: ${others.length}`);
    for (const r of others) log(`    ${r.clientId} ${r.clientName}: ${r.otherChanges.join(", ")}`);
    const normalised = new Map<string, number>();
    for (const r of written) for (const column of r.emptyNormalised) normalised.set(column, (normalised.get(column) ?? 0) + 1);
    log(`  empty columns the save writes as "" rather than NULL (client.update's own normalisation, as on any drawer save): `
      + (normalised.size ? [...normalised].map(([column, n]) => `${column} ${n}`).join(" · ") : "none"));

    log("\nPer client — client · job · rule step · period (console FY label; v7 year = end year) · Scope 1 / 2 / 3 · total tCO2e · net-zero year · outcome");
    for (const r of results) {
      const period = r.job.periodStart && r.job.periodEnd ? `${r.job.periodStart} – ${r.job.periodEnd} (${consoleFyLabel(r.job.periodStart)}; v7 ${r.job.periodEnd.slice(0, 4)})` : "no complete period";
      log(`  ${r.clientId} | ${r.clientName} | ${r.job.jobNumber} | ${r.ruleStep}${r.candidates > 1 ? ` of ${r.candidates}` : ""} | ${period} | ${t(r.job.scope1)} / ${t(r.job.scope2)} / ${t(r.job.scope3)} | ${t(r.job.total)} | NZ ${r.netZeroYear}`
        + ` | ${r.result === "written" ? `${r.governed ? "re-baseline" : "initial"} v${r.version}` : `REFUSED ${r.refusal}`}`);
    }
    log(`\nHeld for Francis's manual pass — stated benchmark period, matched by no candidate (${plan.held.length}):`);
    for (const h of plan.held) log(`  ${h.clientId} | ${h.clientName} | stated period start ${h.statedStart} | ${h.candidates} candidate job(s)`);
    log(`\nLeft out — no usable total (${plan.noUsableTotal.length}):`);
    for (const n of plan.noUsableTotal) log(`  ${n.clientId} | ${n.clientName}`);
    if (refused.length) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nderive-baselines failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
