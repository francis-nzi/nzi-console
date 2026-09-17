/**
 * Carry the free-text client identity fields onto the curated references (NZC-090).
 *
 *   npm run backfill:client-references -- --dry-run
 *   npm run backfill:client-references
 *
 * Run the dry run first. It reports exactly what would be matched and, more importantly, what
 * would not — every value this cannot place is printed with the client it belongs to, because a
 * client's recorded industry or referral is something the firm typed about a real relationship and
 * is not a script's to discard.
 *
 * Idempotent: a second run finds the ids already set and writes nothing.
 */
import { Pool } from "pg";
import { backfillClientReferences } from "../src/clientReferenceBackfill";
import { validateDatabaseBoundary } from "../src/databaseBoundary";

const ORG = process.env.NZI_DEMO_ORGANISATION_ID ?? "demo-nzi-console";
const ACTOR = process.env.SEED_ACTOR_ID ?? "acceptance-admin";
const DRY_RUN = process.argv.includes("--dry-run");
const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const pool = new Pool({ connectionString: url.toString(), max: 2, application_name: "nzi-client-backfill" });
  try {
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR, dryRun: DRY_RUN });
    log(`\n${DRY_RUN ? "Dry run — nothing written." : "Backfill applied."} Organisation ${ORG}.\n`);
    for (const field of ["sector", "referral", "owner", "clientManager"] as const) {
      log(`  ${field.padEnd(14)} matched ${outcome.matched[field]} · already set ${outcome.alreadySet[field]} · blank ${outcome.blank[field]}`);
    }
    if (outcome.unmatched.length === 0) { log("\n  Everything placed.\n"); return; }

    log(`\n  ${outcome.unmatched.length} value(s) left as they are — decide these by hand:\n`);
    for (const row of outcome.unmatched) {
      log(`    ${row.clientName} · ${row.field} · "${row.value}" — ${row.reason}`);
    }
    log("\n  Nothing above was changed or cleared. Add the value to its lookup and re-run, or");
    log("  set it on the client. An owner that disagrees with its name is a permission question,");
    log("  not a data one, and is never re-pointed by this script.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nbackfill-client-references failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
