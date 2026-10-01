/**
 * Take v7's message-template wording onto the console's known keys (admin Phase F1; ruled plan
 * `phaseF-comms-crm-plan.md` F-Q2/F-Q3).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-message-templates --tables message_templates --file C:/v7-extract-message-templates/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-message-templates/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-message-templates --tables message_templates
 *   npm run load:v7-message-templates -- C:/v7-extract-message-templates [--organisation <id>] [--commit]
 *
 * A v7 key with no console send-site is reported, never invented; a v7 template that uses a token its console key does
 * not supply is refused, naming the token. **An imported active template is what that message sends from the moment
 * it is committed**, so the dry run goes to `_handoff` first. The report names keys and tokens — never the wording.
 * Delete the extract directory once the load is committed and verified.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. Fail-closed on the boundary; verified TLS
 * off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7MessageTemplates, planV7MessageTemplates, V7_MESSAGE_TEMPLATE_TABLES } from "../src/v7MessageTemplatesLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-message-templates <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_MESSAGE_TEMPLATE_TABLES });
  log(`\nv7 message templates into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7MessageTemplates(read.extract);
  log(`  v7: ${read.extract.message_templates?.length ?? 0} template(s) → ${plan.values.length} onto a console key: ${plan.values.map((value) => `${value.v7Key} → ${value.templateKey}`).join(", ") || "none"}`);
  if (plan.unknownKeys.length) log(`  no console send-site — reported, not imported (${plan.unknownKeys.length}): ${plan.unknownKeys.join(", ")}`);
  for (const refusal of plan.refused) log(`  REFUSED v7 ${refusal.v7Key}: ${refusal.reason}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-message-templates-load" });
  try {
    const outcome = await loadV7MessageTemplates(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    log(`  +${outcome.inserted} inserted · ${outcome.stamped} stamped (the organisation's own wording kept) · ${outcome.updated} updated from v7 (R4) · =${outcome.unchanged} unchanged`);
    log(`  sending the built-in wording after this load: ${outcome.builtIn.join(", ") || "none"}`);
    for (const note of outcome.notes) log(`  note: ${note}`);
    for (const refusal of outcome.refused) log(`  REFUSED ${refusal}`);
    if (outcome.refused.length) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-message-templates failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
