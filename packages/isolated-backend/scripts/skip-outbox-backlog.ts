/**
 * Clear the unconsumed outbox backlog — skip-only, owner-run, behind the staging gate (BRIEF-outbox-skip-cleanup).
 *
 *   npm run skip:outbox-backlog -w @nzi/isolated-backend -- [--organisation <id>] [--keep-topic <topic>]... [--batch <n>] [--commit]
 *
 * Marks `skipped` every `pending` row of the organisation (default net-zero-international) whose topic is NOT `email.send` or
 * `strategy.deadline.reminder` — those two stay with their real handlers. No mailer, no reminder scan, no delivery of any kind:
 * the only column written is `state`. `--keep-topic` adds topics to leave alone (it can only narrow the run).
 *
 * The default is a dry run: a per-topic count, nothing written. `--commit` skips in batches under SEED_ACTOR_ID and writes one
 * counts-only audit event (`outbox.backlog.skipped`). Re-running with nothing pending changes and records nothing. Output is
 * topic names and counts only — never a payload.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { clearUnconsumedOutbox } from "../src/outboxSkip";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const repeated = (name: string) => process.argv.flatMap((value, at) => (value === name && process.argv[at + 1] ? [process.argv[at + 1]!] : []));

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const batchSize = argument("--batch") ? Number(argument("--batch")) : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) throw new Error("--batch must be a positive whole number.");
  const actorId = process.env.SEED_ACTOR_ID;
  if (commit && !actorId?.trim()) throw new Error("SEED_ACTOR_ID must name who is clearing the backlog; the audit event records it.");
  const url = validateDatabaseBoundary({ appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nOutbox backlog — skip-only (${organisationId}) — ${commit ? "COMMIT" : "dry run: counts only, nothing written"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-outbox-skip-cleanup" });
  try {
    const run = await clearUnconsumedOutbox(pool, organisationId, {
      commit, actorId, batchSize, extraKept: repeated("--keep-topic"),
      onBatch: (batch) => log(`  batch: ${batch.total} row(s) skipped`),
    });
    log(`  left with their real handlers: ${run.kept.join(", ")}`);
    const verb = run.committed ? "skipped" : "would skip";
    for (const [topic, n] of Object.entries(run.byTopic)) log(`  ${verb}  ${String(n).padStart(8)}  ${topic}`);
    log(`  ${verb}  ${String(run.total).padStart(8)}  TOTAL${run.committed ? ` in ${run.batches} batch(es); one audit event written` : ""}`);
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => { process.stderr.write(`\nskip-outbox-backlog failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
