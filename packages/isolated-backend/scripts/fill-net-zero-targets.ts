/**
 * The one-time net-zero target fill (NET-ZERO follow-ups, Part B): each active client with a baseline in force and no
 * net-zero target gets one in `client_targets`, through client.targets.set — year from the client record where set,
 * else 2050; 90%. Fill-blank-only; other targets carried forward.
 *
 *   npm run fill:net-zero-targets -w @nzi/isolated-backend -- [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole run, rolled back. Reads and writes only the console (staging).
 * The report names each client (a business, not a person), the year and its source, the benchmark year, the version, the
 * targets carried forward, and the outcome; it lists every client left out, by class. Fail-closed on the boundary;
 * verified TLS off-machine.
 */
import { Pool } from "pg";
import { loadNetZeroFill } from "../src/netZeroTargetBackfill";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const bucket = (year: number) => year === 2050 ? "2050" : year >= 2030 && year < 2050 ? "2030–2049" : String(year);

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nNet-zero target fill for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-net-zero-fill" });
  try {
    const { plan, results, runId } = await loadNetZeroFill(pool, organisationId, { commit });
    const written = results.filter((r) => r.result === "written"), refused = results.filter((r) => r.result === "refused");
    const count = <T,>(items: readonly T[], key: (item: T) => string) => {
      const map = new Map<string, number>();
      for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
      return [...map].sort().map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
    };
    log(`  run ${runId}`);
    log(`\nPopulation: ${plan.population.clients} clients`);
    log(`  a net-zero target held already (never replaced): ${plan.held}`);
    log(`  to fill: ${plan.fill.length} — year source: ${count(plan.fill, (p) => p.yearSource)} — year: ${count(plan.fill, (p) => bucket(p.year))}`);
    log(`  left out, not active: ${plan.notActive.length}`);
    log(`  left out, no baseline in force (client.targets.set would refuse BASELINE_REQUIRED): ${plan.noBaseline.length}`);
    log(`\n${commit ? "Written" : "Would write"}: ${written.length} · refused: ${refused.length}${refused.length ? ` (${count(refused, (r) => r.refusal ?? "?")})` : ""}`);
    log(`  replaced a held net-zero target: 0 by construction — a held target is never planned`);
    log(`  first targets version: ${written.filter((r) => r.expectedVersion === 0).length} · a later version, other targets carried forward: ${written.filter((r) => r.expectedVersion > 0).length}`);
    const misses = written.filter((r) => r.postConditionMisses.length > 0);
    log(`  post-condition misses (latest version not exactly the intended net-zero pair, other targets unchanged): ${misses.length}`);
    for (const r of misses) log(`    ${r.clientId} ${r.clientName}: ${r.postConditionMisses.join(", ")}`);

    log("\nPer client — client · net-zero year (source) · % · benchmark year · targets version · carried forward · outcome");
    for (const r of results) {
      log(`  ${r.clientId} | ${r.clientName} | ${r.year} (${r.yearSource}) | ${r.pct}% | benchmark ${r.benchmarkYear} | v${r.expectedVersion} → v${r.expectedVersion + 1}`
        + ` | ${r.carried.length ? r.carried.join(", ") : "—"} | ${r.result === "written" ? "written" : `REFUSED ${r.refusal}`}`);
    }
    log(`\nLeft out — not active (${plan.notActive.length}):`);
    for (const n of plan.notActive) log(`  ${n.clientId} | ${n.clientName} | ${n.status}`);
    log(`\nLeft out — no baseline in force (${plan.noBaseline.length}):`);
    for (const n of plan.noBaseline) log(`  ${n.clientId} | ${n.clientName}`);
    if (refused.length || misses.length) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nfill-net-zero-targets failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
