/**
 * Seed the staging test client for the portal acceptance run (NZC-080).
 *
 *   npm run seed:portal-acceptance
 *   npm run seed:portal-acceptance -- --withdraw-all
 *
 * Produces every case `docs/STAGING_ACCEPTANCE_PORTAL_PLAN.md` and
 * `docs/STAGING_ACCEPTANCE_PORTAL_READINESS.md` ask for, so the run is a spot-check against known
 * expected values rather than an exploration of whatever happens to be in the database.
 *
 * ## Through the command layer, not around it
 *
 * Every domain row is written by the commands the staff console calls. A seed of raw INSERTs
 * would produce rows that look right and carry no audit event, no outbox entry, no version and no
 * provenance — and the acceptance run would then be checking the portal against data the real
 * write path has never produced. The commands also enforce their own invariants, so this seed
 * cannot create a shape the console could not.
 *
 * The one exception is the seed actor's **membership** row, upserted with SQL below: there is no
 * command for "make this user exist", and it is called out rather than hidden.
 *
 * ## Where the logic lives, and why
 *
 * The sequence itself is `src/portalAcceptanceSeed.ts`, driven in CI against a real Postgres by
 * `tests/portalAcceptanceSeed.test.ts`. This file is only the runnable edge: boundary guard,
 * client resolution, printing.
 *
 * That split was bought the hard way. The first two failures here were reproducible only by
 * running against staging — a round-trip each, and each one left a half-applied fixture in a real
 * client's plan. A fixture whose only test environment is the one you are trying to protect is a
 * fixture nobody can fix cheaply.
 *
 * ## Idempotent
 *
 * Commands are idempotent on `(organisation_id, idempotency_key)` and a replay returns the
 * original outcome including the id it created, so each creation is keyed by a hash of its
 * payload. Updates are keyed by payload too, so re-running refreshes the target dates back into
 * their due-state buckets rather than letting "due soon" quietly become "overdue". The assessment
 * is reconciled by reading, and an open draft is resumed rather than started beside.
 *
 * ## Fail-closed
 *
 * `validateDatabaseBoundary` is the app's own guard: production `APP_ENV` is refused and
 * `NZI_DATABASE_BOUNDARY` must say `isolated-non-production`. There is no override.
 *
 * ## Cleanup
 *
 * `--withdraw-all` takes the seeded strategies off the plan through `client.strategy.remove`,
 * which deactivates and audits exactly as the console does. Nothing is deleted, so the audit
 * trail of the acceptance run survives it. The completed assessment is left alone: an assessment
 * is a dated record, and withdrawing one would misrepresent the client's history.
 */
import { Pool } from "pg";
import { seedPortalAcceptance, SeedStepError, STRATEGY_CASES } from "../src/portalAcceptanceSeed";
import { validateDatabaseBoundary } from "../src/databaseBoundary";

const ORG = process.env.NZI_DEMO_ORGANISATION_ID ?? "demo-nzi-console";
const ACTOR = process.env.SEED_ACTOR_ID ?? "acceptance-admin";
const CLIENT_HINT = process.env.SEED_CLIENT_NAME ?? "Bushy Tails";
const WITHDRAW_ALL = process.argv.includes("--withdraw-all");

const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });

  const pool = new Pool({ connectionString: url.toString(), max: 3, application_name: "nzi-portal-acceptance-seed" });
  try {
    // Identity plumbing — the one SQL write here, and the only thing without a command.
    await pool.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET role_id = 'admin', status = 'active'`,
      [ORG, ACTOR],
    );

    const found = await pool.query<{ client_id: string; name: string }>(
      `SELECT client_id, name FROM nzi_console.clients
        WHERE organisation_id = $1 AND (name ILIKE $2 OR client_id = $2)
        ORDER BY name LIMIT 1`,
      [ORG, CLIENT_HINT],
    );
    const target = found.rows[0];
    if (!target) throw new Error(`No client matching "${CLIENT_HINT}" in ${ORG}. Set SEED_CLIENT_NAME to one that exists.`);
    log(`\nSeeding portal acceptance data for ${target.name} (${target.client_id}) in ${ORG}.\n`);

    const summary = await seedPortalAcceptance(pool, {
      organisationId: ORG, actorId: ACTOR, clientId: target.client_id, log, withdrawAll: WITHDRAW_ALL,
    });

    if (WITHDRAW_ALL) {
      log("\nThe completed SRS assessment is left in place: assessments are a dated record, and");
      log("withdrawing one would misrepresent the client's history rather than tidy it up.\n");
      return;
    }

    log(`\n─── Seeded. What to expect in the portal for ${target.name} ───\n`);
    for (const entry of STRATEGY_CASES) log(`  ${entry.id.padEnd(18)} ${entry.proves}`);
    log("");
    log(`  gap addressed      ${summary.reserved.addressed} — lists the live strategy (readiness #5)`);
    log(`  gap withdrawn-only ${summary.reserved.withdrawn} — must read "no strategy aligned yet" (readiness #6)`);
    log(`  gap out-of-report  ${summary.reserved.outOfReport} — must read "no strategy aligned yet" (readiness #7)`);
    log(`  gap no strategy    ${summary.reserved.noStrategy} — must read "no strategy aligned yet" (readiness #8)`);
    log("");
    log(`  assessment ${summary.assessmentId} — ${summary.assessmentState}`);
    log("");
    log("  Re-run any time: creations replay, and the target dates are refreshed back into their");
    log("  due-state buckets. Use --withdraw-all to take the seeded strategies off the plan.\n");
  } finally {
    await pool.end();
  }
}

/**
 * Say what actually failed.
 *
 * `CommandValidationError`'s message is the constant "Command validation failed." — the detail is
 * in its `issues`, as `{ field, code, message }`, and `SeedStepError` adds which command and case
 * raised it. Printing only `error.message` threw all of that away and turned a one-line diagnosis
 * into two staging round-trips.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const head = error instanceof SeedStepError ? error.message : `${error.name}: ${error.message}`;
  const issues = error instanceof SeedStepError
    ? error.issues
    : (error as { issues?: Array<{ field: string; code: string; message: string }> }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return head;
  return [head, ...issues.map((issue) => `    · ${issue.field} [${issue.code}] ${issue.message}`)].join("\n");
}

main().catch((error) => {
  process.stderr.write(`\nseed-portal-acceptance failed: ${describeFailure(error)}\n`);
  process.exitCode = 1;
});
