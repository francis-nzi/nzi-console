/**
 * Encrypt the personal data that is already in the database (NZC-119).
 *
 *   npm run backfill:pii-encryption -w @nzi/isolated-backend -- --dry-run
 *   npm run backfill:pii-encryption -w @nzi/isolated-backend
 *
 * Run the dry run first: it counts what is outstanding per table and writes nothing.
 *
 * **Order matters.** Dual-write ships before this runs. A row created while this is working would
 * otherwise land with plaintext and no ciphertext behind the point the backfill had already passed —
 * unencrypted, therefore unerasable, with nothing anywhere to say so.
 *
 * Resumable, and safe to interrupt: the outstanding work *is* the queue (plaintext present, ciphertext
 * absent), each batch is its own transaction, and a second run continues from wherever the first
 * stopped. Re-running a finished backfill selects nothing.
 *
 * The keys come from the environment and stay there — the same three variables the application reads,
 * never arguments, so they do not end up in a shell history or a ticket.
 */
import { Pool } from "pg";
import { backfillSealedPii } from "../src/piiBackfill";
import { resolveSealingKeys, SEALING_KEY_VARIABLES } from "../src/piiSealingKeys";
import { validateDatabaseBoundary } from "../src/databaseBoundary";

const ORG = process.env.NZI_DEMO_ORGANISATION_ID ?? "demo-nzi-console";
const ACTOR = process.env.SEED_ACTOR_ID ?? "pii-encryption-backfill";
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = Number(process.env.NZI_BACKFILL_BATCH_SIZE ?? "200");
const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const keys = resolveSealingKeys();
  const pool = new Pool({ connectionString: url.toString(), max: 2, application_name: "nzi-pii-backfill" });
  try {
    log(`\n${DRY_RUN ? "Dry run" : "Sealing"} · organisation ${ORG} · batches of ${BATCH}\n`);
    const outcome = await backfillSealedPii(pool, {
      organisationId: ORG, actorId: ACTOR, keys, batchSize: BATCH, dryRun: DRY_RUN,
      onProgress: ({ table, sealed, outstanding }) =>
        log(`  ${table.padEnd(22)} sealed ${String(sealed).padStart(7)} · ~${outstanding} to go`),
    });

    log(`\n  ${"table".padEnd(22)} ${"before".padStart(8)} ${"sealed".padStart(8)} ${"left".padStart(8)}`);
    for (const row of outcome.tables) {
      log(`  ${row.table.padEnd(22)} ${String(row.outstandingBefore).padStart(8)} ${String(row.sealed).padStart(8)} ${String(row.outstandingAfter).padStart(8)}`);
    }

    const stranded = outcome.tables.filter((row) => row.outstandingAfter > 0);
    if (DRY_RUN) {
      log("\n  Nothing written. Re-run without --dry-run to seal.\n");
    } else if (stranded.length === 0) {
      log("\n  Every row with personal data now has ciphertext beside it.\n");
    } else {
      // Not a failure to retry: a row left outstanding is one whose subject could not be named, and
      // running again will leave it exactly where it is. It needs a person to say who it belongs to.
      log("\n  Rows left outstanding — each has personal data and no subject to key it to:\n");
      for (const row of stranded) log(`    ${row.table}: ${row.outstandingAfter}`);
      log("\n  Re-running will not move these. They need the subject naming before they can be sealed.\n");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nbackfill-pii-encryption failed: ${message}\n`);
  if (/encryption keys/.test(message)) {
    process.stderr.write(`Set ${Object.values(SEALING_KEY_VARIABLES).join(", ")} in the environment.\n`);
  }
  process.exitCode = 1;
});
