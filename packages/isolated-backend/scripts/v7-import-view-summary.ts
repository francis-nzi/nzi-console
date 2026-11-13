/**
 * The server-side summary of one job, off the import's view set (BRIEF-v7-import-server-side Phase A): the same three-way
 * summary the extract-based `v7:import-summary` makes, with no extract file and no upload — read and diff only.
 *
 *   NZI_V7_VIEW_URL=… NZI_V7_VIEW_CA_CERT=… npm run v7:import-view-summary -w @nzi/isolated-backend -- --job J000669 \
 *       [--out <summary.json>] [--organisation <id>]
 *
 * Prints counts, Σ per scope and the verdict. Writes nothing to either database (the source read is read-only and rolled back;
 * the console comparison reverts any standing re-ingest under a savepoint it rolls back). --out writes the summary — ids,
 * codes, statuses and tCO2e only — to a file, to compare with the extract-based one.
 */
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { v7ImportSummaryIssues } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { withTenantWrite } from "../src/postgres";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { summariseV7JobFromViews, v7ImportViewPoolConfig } from "../src/v7ImportView";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const jobNumber = argument("--job");
  if (!jobNumber || !/^J\d{6}$/.test(jobNumber)) throw new Error("--job <one J number, e.g. J000669> is required.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const out = argument("--out");

  const source = v7ImportViewPoolConfig();
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nServer-side import summary of ${jobNumber} for ${organisationId}`);
  log(`  source: the view set · ${source.description}`);
  log(`  console: ${tls.description}`);
  const sourcePool = new Pool(source);
  const consolePool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-import-view-summary" });
  try {
    const summary = await withTenantWrite(consolePool, organisationId, (db) => summariseV7JobFromViews(db, sourcePool, { organisationId, legacyJobNumber: jobNumber }));
    const issues = v7ImportSummaryIssues(summary);
    if (issues.length) throw new Error(`The summary is not well formed: ${JSON.stringify(issues)}`);
    const c = summary.counts;
    log(`  source fingerprint ${summary.extractSha256} · ${summary.rows.length} row(s)`);
    log(`  matched ${c.matched} · changed ${c.changed} · needs mapping ${c.needsMapping} · new ${c.new} · withdrawn ${c.withdrawn} · linked pair changed ${c.linkedPairChanged}`);
    for (const [scope, totals] of Object.entries(summary.scopeTotals)) log(`  Scope ${scope}: source ${totals.v7Tco2e} t · console ${totals.consoleTco2e} t`);
    log(`  verdict: ${summary.verdict}`);
    if (out) { writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`); log(`  written to ${out}`); }
    log("\nNothing was written to either database, and nothing was uploaded.");
  } finally {
    await sourcePool.end();
    await consolePool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-import-view-summary failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
