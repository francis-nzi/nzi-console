/**
 * The v7 re-ingest of one job (DESIGN-v7-reingest-commit-phase, ruled): `v7.reingest.job` from a plan the crosswalk produced.
 *
 *   npm run v7:reingest -w @nzi/isolated-backend -- --plan <plan.json> [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole run, rolled back: the per-row plan, the totals (in total and per
 * scope) and the post-conditions, exactly as the commit would meet them, with nothing written. The plan file is
 * `V7ReingestJobInput` without `runId` (each run is given its own). Reads and writes only the console (staging). Fail-closed on
 * the boundary; verified TLS off-machine. Prints tCO2e only.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type V7ReingestJobInput } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { withTenantWrite } from "../src/postgres";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { reingestV7JobInTransaction } from "../src/v7Reingest";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const planFile = argument("--plan");
  if (!planFile) throw new Error("--plan <file> is required.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Omit<V7ReingestJobInput, "runId">;
  const input: V7ReingestJobInput = { ...plan, runId: `v7-reingest-${randomUUID()}` };
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 re-ingest of ${input.jobId} for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  log(`  run ${input.runId} · crosswalk ${input.crosswalkVersion} (${input.crosswalkSha256}) · ${input.rows.length} plan rows · vintages ${input.vintageDatasetIds.join(", ")}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-reingest" });
  const context = { organisationId, actorId: V7_REINGEST_ACTOR, principal: "system" as const, idempotencyKey: input.runId, correlationId: input.runId,
    reason: `v7 re-ingest of ${input.jobId} (crosswalk ${input.crosswalkVersion})${commit ? "" : " — dry run"}`, grant: commandGrantForRole("admin", organisationId, V7_REINGEST_ACTOR) };
  let outcome: Awaited<ReturnType<typeof reingestV7JobInTransaction>> | null = null;
  let siteNames = new Map<string, string>();
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      outcome = await reingestV7JobInTransaction(db, input, context);
      // The client's own site names, for the per-site table (the run's record keeps ids only).
      siteNames = new Map((await db.query<{ site_id: string; name: string }>(
        `SELECT site_id, name FROM nzi_console.client_sites WHERE organisation_id = $1 AND site_id = ANY($2::text[])`,
        [organisationId, Object.keys(outcome.data.siteTotals)])).rows.map((row) => [row.site_id, row.name]));
      if (!commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    await pool.end();
  }
  const data = outcome!.data;
  log(`\n${commit ? "Committed" : "Would commit"} — post-conditions met (D7: total, each scope, each site, each row and its carried fields, every v7 row switched off)`);
  log(`  v7 ${data.v7TotalTco2e} t · native ${data.nativeTotalTco2e} t`);
  for (const [scope, totals] of Object.entries(data.scopeTotals)) log(`  scope ${scope}: v7 ${totals.v7} t · native ${totals.native} t`);
  for (const [site, totals] of Object.entries(data.siteTotals))
    log(`  site ${site === "unallocated" ? "Unallocated (v7 named no site)" : `${siteNames.get(site) ?? "?"} (${site})`}: ${totals.rows} rows · v7 ${totals.v7} t · native ${totals.native} t`);
  log(`  carried from each v7 row: site ${data.carried.site} · data confidence ${data.carried.dataConfidence} · column text ${data.carried.columnText} · monthly activity ${data.carried.months}`);
  log(`  rows: ${Object.entries(data.rowsByDisposition).map(([d, n]) => `${d} ${n}`).join(" · ")} · v7 rows switched off ${data.v7RowsSwitchedOff}`);
  log(`  vintages added to the selection: ${data.datasetsAdded.join(", ") || "none (already selected)"} · carried factors created: ${data.clientFactorsCreated}`);
  log("\nPer row — v7 row · disposition · native category · v7 tCO2e (rule)");
  for (const row of input.rows) log(`  ${row.v7RowId} | ${row.disposition} | ${row.categoryCode} | ${row.v7Tco2e} (${row.rule})`);
  if (!commit) log("\nDry run complete. Re-run with --commit to write.");
}

main().catch((error) => {
  process.stderr.write(`\nv7-reingest-job failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
