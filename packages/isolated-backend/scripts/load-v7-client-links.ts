/**
 * Link imported clients to the reconciled lookups and to memberships (admin Phase A4).
 *
 *   npm run load:v7-client-links -- [--organisation <id>] [--commit]
 *
 * No extract: everything it matches is already in the isolated database — each v7 client's text (the client import),
 * the lookups (A3) and the memberships. A dry run unless `--commit`, and a dry run is the run, rolled back.
 *
 * Exact and unique only, fill-NULL-only, never creates a lookup value, never touches the text columns
 * (src/v7ClientLinkLoad.ts). Per link it reports filled, already linked, conflicts, unmatched and blank; the distinct
 * texts matched and unmatched with client counts (client names are never printed; a manager's name is withheld too —
 * it is a person's name, and the Clients list shows it to those who may see it); and each conflict by client id.
 * Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { LINK_FIELDS, loadV7ClientLinks, type LinkField } from "../src/v7ClientLinkLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const LABEL: Record<LinkField, string> = {
  sector: "sector → industries", referral: "referral → referrals", portfolio: "portfolio → portfolios", clientManager: "client manager → memberships",
};

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 client links into ${organisationId} — ${commit ? "COMMIT" : "dry run: the run loaded and rolled back"}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-client-links" });
  try {
    const outcome = await loadV7ClientLinks(pool, organisationId, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}): ${outcome.clientsChanged} of ${outcome.clientsInScope} imported clients changed — each version-bumped, one audit event each`);
    for (const field of LINK_FIELDS) {
      const t = outcome.tally[field];
      log(`\n  ${LABEL[field]}`);
      log(`    +${t.filled} filled${t.filledToInactive ? ` (${t.filledToInactive} to an inactive value)` : ""} · =${t.alreadyLinked} already linked · ${t.conflicts} conflicts · ${t.unmatched} unmatched · ${t.blank} blank`);
      if (field === "clientManager") {
        if (outcome.matched[field].length) log(`    matched: ${outcome.matched[field].length} distinct names (withheld)`);
        for (const entry of outcome.unmatched[field]) log(`    unmatched (${entry.reason}): a name held by ${entry.clients} client(s) (withheld)`);
        continue;
      }
      for (const entry of outcome.matched[field]) log(`    matched  "${entry.text}" → ${entry.valueId} "${entry.label}" ×${entry.clients}`);
      for (const entry of outcome.unmatched[field]) log(`    unmatched (${entry.reason}) "${entry.text}" ×${entry.clients}`);
    }
    if (outcome.conflicts.length) {
      log(`\nCONFLICTS — a link already set differs from what the text matches; reported, not overwritten (${outcome.conflicts.length}):`);
      for (const conflict of outcome.conflicts) log(`  ${conflict.clientId} ${conflict.field}: set to ${conflict.field === "clientManager" ? "a membership" : conflict.current}, the text matches ${conflict.field === "clientManager" ? "another" : conflict.matched}`);
      process.exitCode = 1;
    }
    log("\nAn unmatched text is fixed in the Lookups screen (add or rename a value), then re-run — this never creates one.");
    if (!commit) log("Dry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-client-links failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
