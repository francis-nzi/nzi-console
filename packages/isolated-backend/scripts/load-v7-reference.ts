/**
 * Load v7's reference data into the console (REFERENCE_DATA_DESIGN §5).
 *
 *   npm run load:v7-reference -- <factor_lookup.csv> [--precedence <file.json>] [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`: it reads the extract, builds the plan, and prints every refusal and report — nothing is
 * written. With `--commit`, and only when the plan carries no refusal, it writes the plan in one transaction into the
 * target organisation (net-zero-international unless told otherwise). Re-running is safe: a dataset already loaded with
 * the same content is left alone, one loaded with different content is refused.
 *
 * `--precedence` is Francis's ruling for editions the rule cannot order: `{ "<dataset slug>": "<active v7 dataset_id>" }`.
 *
 * Fail-closed on the boundary like every other write here: production APP_ENV is refused and NZI_DATABASE_BOUNDARY must
 * say isolated-non-production.
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { DEFAULT_ORGANISATION, parseCsv, planV7Load, type Finding, type Precedence } from "../src/v7ReferenceImport";
import { loadV7Plan } from "../src/v7ReferenceLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const printFindings = (title: string, findings: Finding[]) => {
  if (findings.length === 0) return;
  log(`\n${title}`);
  for (const finding of findings) {
    log(`  ${finding.code} ×${finding.count} — ${finding.message}`);
    for (const example of finding.examples) log(`      ${example}`);
  }
};

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("Usage: load-v7-reference <factor_lookup.csv> [--precedence <file.json>] [--organisation <id>] [--commit]");
  const precedencePath = argument("--precedence");
  const precedence: Precedence = precedencePath ? JSON.parse(readFileSync(precedencePath, "utf8")) : {};
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const pool = new Pool({ connectionString: url.toString(), max: 2, application_name: "nzi-v7-reference-load" });
  try {
    const registry = await listCategoryVariants(pool as never);
    const plan = planV7Load(parseCsv(readFileSync(file, "utf8")), registry, { organisationId, precedence });

    log(`\nv7 reference load into ${organisationId} — ${commit ? "COMMIT" : "dry run, nothing will be written"}`);
    log(`  extracted ${plan.summary.extracted} · identical repeats collapsed ${plan.summary.duplicatesCollapsed} · not kgCO2e ${plan.summary.skippedNotKgco2e}`);
    log(`  datasets ${plan.datasets.length} (${plan.datasets.filter((d) => d.status === "superseded").length} superseded) · identities ${plan.identities.length} · value rows ${plan.factors.length}`);
    printFindings("REFUSALS — the load will not run until each is resolved", plan.refusals);
    printFindings("Reports — shown, not blocking", plan.reports);

    if (plan.refusals.length > 0) { process.exitCode = 1; return; }
    if (!commit) { log("\nDry run complete. Re-run with --commit to write."); return; }
    const outcome = await loadV7Plan(pool, plan);
    log(`\nWritten: datasets +${outcome.datasetsInserted} (=${outcome.datasetsUnchanged} unchanged) · identities +${outcome.identitiesInserted} (=${outcome.identitiesKept} kept) · value rows +${outcome.factorsInserted}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-reference failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
