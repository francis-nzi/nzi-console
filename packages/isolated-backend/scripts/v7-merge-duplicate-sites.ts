/**
 * Merge the duplicate sites the 29 Sep import suffixed " (v7 site N)" (SWEEP-v7-duplicate-sites.md; ruled 25 Nov 2026; 0235).
 *
 *   npm run v7:merge-duplicate-sites -w @nzi/isolated-backend -- [--organisation <id>] [--expect <groups>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole merge (every rename, retirement, row move, link and audit event)
 * rolled back. `--expect` refuses unless the plan holds exactly that many groups to merge. Held groups (more than one site with
 * entries and not ruled, or a duplicate carrying records other than scope rows) are listed and never touched.
 * Fail-closed on the boundary; verified TLS off-machine. Prints ids, names and counts only — no figures, no addresses.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { mergeV7DuplicateSites, V7_SITE_MERGE_ACTOR } from "../src/v7SiteLinks";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const expect = argument("--expect");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 duplicate-site merge for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole merge, rolled back"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 1, application_name: "nzi-v7-site-merge" });
  try {
    const dry = await mergeV7DuplicateSites(pool, { organisationId, actorId: V7_SITE_MERGE_ACTOR, reason: "SWEEP-v7-duplicate-sites, ruled 25 Nov 2026" }, { commit: false });
    if (expect !== undefined && dry.plan.merge.length !== Number(expect)) {
      throw new Error(`the plan holds ${dry.plan.merge.length} group(s) to merge, not the ${expect} expected; nothing was written.`);
    }
    const outcome = commit
      ? await mergeV7DuplicateSites(pool, { organisationId, actorId: V7_SITE_MERGE_ACTOR, reason: "SWEEP-v7-duplicate-sites, ruled 25 Nov 2026" }, { commit: true })
      : dry;
    for (const group of outcome.plan.merge) {
      log(`  ${group.clientId}  "${group.name}"  survivor ${group.survivor.siteId} (${group.survivor.rows} rows)  ← ${group.duplicates.map((site) => `${site.siteId} (${site.rows})`).join(", ")}${group.rowsMoving ? `  · ${group.rowsMoving} row(s) move` : ""}`);
    }
    for (const group of outcome.plan.held) log(`  HELD ${group.clientId}  "${group.name}"  ${group.siteIds.join(", ")}: ${group.why}`);
    log(`\n${commit ? "Merged" : "Would merge"} ${outcome.plan.merge.length} group(s), ${outcome.plan.merge.reduce((n, group) => n + group.duplicates.length, 0)} site(s) retired, ${outcome.rowsMoved} row(s) moved, ${outcome.linksWritten} link(s) written; ${outcome.plan.held.length} held.`);
    log(`  correlation ${outcome.correlationId}${commit ? "" : " (rolled back)"}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-merge-duplicate-sites failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
