/**
 * JW-14 Part 1 — discard named draft scope rows through the governed `scope.row.discard`, behind the staging gate.
 *
 *   npm run discard:scope-rows -w @nzi/isolated-backend -- --job J000001 --rows <id>,<id> --reason "<why>" [--commit]
 *
 * Exactly the rows named, on exactly the job named — anything else is refused before a write is attempted. Each must be
 * a console draft with no saved data; the command refuses anything holding data, imported from v7, or in use, and the
 * run reports the refusal rather than stopping. A dry run is the whole run, rolled back. The actor is the system
 * principal `policy:jw14-cleanup` with the admin grant (the staffAdmin break-glass precedent); the reason travels on
 * every audit event. Fail-closed on the boundary; verified TLS off-machine.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { withTenantWrite } from "../src/postgres";
import { CommandValidationError } from "../src/postgresCommands";
import { discardScopeRowInTransaction } from "../src/scopeRowState";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const jobNumber = argument("--job");
  const rowIds = (argument("--rows") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const reason = argument("--reason")?.trim();
  const commit = process.argv.includes("--commit");
  if (!jobNumber || rowIds.length === 0 || !reason) throw new Error("--job, --rows and --reason are required.");
  const url = validateDatabaseBoundary({ appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const runId = `jw14-discard-${randomUUID()}`;
  log(`\nDiscard draft scope rows on ${jobNumber} (${organisationId}) — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  log(`  run ${runId} · reason: ${reason}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-jw14-discard" });
  let refused = 0;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const job = (await db.query<{ job_id: string }>(`SELECT job_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_number = $2`, [organisationId, jobNumber])).rows[0];
      if (!job) throw new Error(`Job ${jobNumber} was not found.`);
      for (const rowId of rowIds) {
        const row = (await db.query<{ version: number; category_code: string | null; origin: string; quantity: string | null; factor_id: string | null; calculated: string | null; review_status: string }>(
          `SELECT version, category_code, origin, quantity::text AS quantity, factor_id, calculated_tco2e::text AS calculated, review_status
             FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3`, [organisationId, job.job_id, rowId])).rows[0];
        if (!row) { refused += 1; log(`  ${rowId} | not a row of ${jobNumber} — REFUSED, nothing attempted`); continue; }
        const shape = `${row.category_code ?? "(no category)"} · ${row.origin} · v${row.version} · quantity ${row.quantity ?? "none"} · factor ${row.factor_id ? "set" : "none"} · figure ${row.calculated ?? "none"} · review ${row.review_status}`;
        await db.query("SAVEPOINT discard_row");
        try {
          await discardScopeRowInTransaction(db, { jobId: job.job_id, rowId, expectedVersion: row.version }, {
            organisationId, actorId: "policy:jw14-cleanup", principal: "system", idempotencyKey: `${runId}:${rowId}`, correlationId: runId,
            reason, grant: commandGrantForRole("admin", organisationId, "policy:jw14-cleanup"),
          });
          const gone = (await db.query(`SELECT 1 FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`, [organisationId, rowId])).rows.length === 0;
          await db.query("RELEASE SAVEPOINT discard_row");
          log(`  ${rowId} | ${shape} | ${commit ? "discarded" : "would discard"}${gone ? "" : " — POST-CONDITION MISS: still present"}`);
          if (!gone) refused += 1;
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT discard_row");
          refused += 1;
          const why = error instanceof CommandValidationError ? error.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : String(error);
          log(`  ${rowId} | ${shape} | REFUSED — ${why}`);
        }
      }
      if (!commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    await pool.end();
  }
  log(`\n${rowIds.length - refused} of ${rowIds.length} ${commit ? "discarded" : "would be discarded"} · refused ${refused}`);
  if (refused) process.exitCode = 1;
  if (!commit) log("Dry run complete. Re-run with --commit to write.");
}

main().catch((error) => { process.stderr.write(`\ndiscard-scope-rows failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
