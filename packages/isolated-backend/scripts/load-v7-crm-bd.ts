/**
 * Reconcile one of v7's CRM / business-development lookups into the console (admin Phase F2; ruled plan
 * `phaseF-comms-crm-plan.md`, F-Q4). One loader per v7 table:
 *
 *   npm run load:v7-crm-tags          -- <extract directory> [--organisation <id>] [--commit]   (v7 crm_tags)
 *   npm run load:v7-bd-service-lines  -- <extract directory> [--organisation <id>] [--commit]   (v7 bd_service_lines)
 *   npm run load:v7-bd-funnel-stages  -- <extract directory> [--organisation <id>] [--commit]   (v7 bd_funnel_stages)
 *
 * Each extract is its one table:
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-<name> --tables <table> --file C:/v7-extract-<name>/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-<name>/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-<name> --tables <table>
 *
 * None of these tables holds personal data, so the report can go to `_handoff`. A dry run unless `--commit`, and a dry
 * run is the load rolled back. Delete the extract once committed and verified. Fail-closed on the boundary; verified TLS
 * off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import {
  loadV7CrmBdLookup, loadV7FunnelStages, planV7CrmBdLookup, planV7FunnelStages, v7LookupTableFor, V7_FUNNEL_TABLES, type CrmBdLookupKind, type Skip,
} from "../src/v7CrmBdLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const KINDS = ["crm-tags", "bd-service-lines", "bd-funnel-stages"] as const;
type Kind = (typeof KINDS)[number];

async function main(): Promise<void> {
  const kind = process.argv[2] as Kind;
  const directory = process.argv[3];
  if (!KINDS.includes(kind) || !directory || directory.startsWith("--")) throw new Error(`Usage: load-v7-crm-bd <${KINDS.join("|")}> <extract directory> [--organisation <id>] [--commit]`);
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const tables = kind === "bd-funnel-stages" ? V7_FUNNEL_TABLES : [v7LookupTableFor(kind as CrmBdLookupKind)];
  const read = readV7Extract(directory, { tables });
  log(`\nv7 ${tables.join(", ")} into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const leftOut = (skipped: Skip[]) => {
    if (!skipped.length) return;
    log(`  left out (${skipped.length}):`);
    for (const skip of skipped) log(`      ${tables[0]} ${skip.legacyDbId}: ${skip.reason}`);
  };
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: `nzi-v7-${kind}-load` });
  try {
    let problems = 0;
    let summary: { inserted: number; stamped: number; updated: number; unchanged: number; refused: string[]; notes: string[]; hereOnly: string[]; parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number }; runId: string };
    if (kind === "bd-funnel-stages") {
      const plan = planV7FunnelStages(read.extract);
      log(`  v7: ${read.extract.bd_funnel_stages?.length ?? 0} stage(s) → ${plan.values.length} to reconcile: ${plan.values.map((value) => `${value.key} (${value.sortOrder}, ${value.probabilityPct}%)`).join(", ")}`);
      leftOut(plan.skipped);
      const outcome = await loadV7FunnelStages(pool, organisationId, plan, { commit });
      summary = outcome;
      log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
      log(`  entry stage after the load: ${outcome.entry ?? "none — the funnel would have no active stage"}`);
      if (outcome.entry === null) problems += 1;
    } else {
      const plan = planV7CrmBdLookup(kind, read.extract);
      log(`  v7: ${read.extract[tables[0]!]?.length ?? 0} row(s) → ${plan.values.length} to reconcile into the ${plan.category} lookup: ${plan.values.map((value) => value.code ? `${value.label} [${value.code}]` : value.label).join(", ")}`);
      leftOut(plan.skipped);
      const outcome = await loadV7CrmBdLookup(pool, organisationId, plan, { commit });
      summary = outcome;
      log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    }
    log(`  +${summary.inserted} inserted · ${summary.stamped} matched and stamped · ${summary.updated} updated from v7 (R4) · =${summary.unchanged} unchanged`);
    const p = summary.parity;
    const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
    log(`  parity: v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
    if (!match && commit) problems += 1;
    if (summary.hereOnly.length) log(`  here, not in v7 — reported, not deactivated (${summary.hereOnly.length}): ${summary.hereOnly.join(", ")}`);
    for (const note of summary.notes) log(`  note: ${note}`);
    for (const refusal of summary.refused) { log(`  REFUSED ${refusal}`); problems += 1; }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-crm-bd failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
