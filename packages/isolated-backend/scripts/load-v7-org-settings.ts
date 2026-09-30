/**
 * Import v7's organisation profile and logo, once, fill-empty-only (admin Phase D, D2; ruled `phaseD-org-settings-plan.md` Q4).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-org --tables system_settings --file C:/v7-extract-org/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-org/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-org --tables system_settings
 *   npm run load:v7-org-settings -- C:/v7-extract-org [--organisation <id>] [--commit]
 *
 * The extract's keys filter copies only v7's profile and logo keys — **never the bank details**, which are hand-entered.
 * If a bank row is ever found in the extract, the load is refused and nothing is written.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. **The report states each field as filled,
 * unchanged, differs, blank in v7 or invalid in v7 — never a value.** Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7OrgSettings, planV7OrgSettings, V7_ORG_SETTINGS_TABLES } from "../src/v7OrgSettingsLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-org-settings <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_ORG_SETTINGS_TABLES });
  log(`\nv7 organisation profile into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7OrgSettings(read.extract);
  if (plan.refused) { log(`\nREFUSED — ${plan.refused}. Nothing was written.`); process.exitCode = 1; return; }
  log(`  v7: ${Object.keys(plan.fields).length} profile field(s) with a value · ${plan.blank.length} blank · ${plan.invalid.length} invalid · logo ${plan.logo === null ? "none" : "problem" in plan.logo ? "unusable" : "present"}`);
  if (plan.unknownKeys.length) log(`  keys not read by this import: ${plan.unknownKeys.join(", ")}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-org-settings-load" });
  try {
    const outcome = await loadV7OrgSettings(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}) — profile version ${outcome.version.before} → ${outcome.version.after}:`);
    for (const entry of outcome.fields) {
      log(`  ${entry.field.padEnd(20)} ${entry.state}${entry.rule ? ` (${entry.rule})` : ""}${entry.v7ChangedSinceImport ? " · v7 has changed since the import — not applied" : ""}`);
    }
    log(`  ${"logo".padEnd(20)} ${outcome.logo}${outcome.logoProblem ? ` — ${outcome.logoProblem}` : ""}`);
    log("\n  Values are not shown. The bank details were not extracted and are not imported: enter them on Admin → Organisation.");
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-org-settings failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
