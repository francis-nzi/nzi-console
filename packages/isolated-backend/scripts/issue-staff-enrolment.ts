/**
 * Issue (or revoke) a staff enrolment invitation (0129).
 *
 *   npm run enrol:staff -- <userId> --actor <your name> --base-url https://<console host> [--organisation <id>] [--hours 72]
 *   npm run enrol:staff -- <userId> --actor <your name> --revoke [--organisation <id>]
 *
 * Run in the Render Shell of the console service, so the database URL never leaves the service's environment. The
 * member must already exist and be active, with a work address — `seed:reference-data` creates the roster at the
 * least-privilege role.
 *
 * It prints the enrolment link **once**. The link is a single-use key to that person's enrolment: pass it to them
 * privately (not in a shared channel), and issue a new one — which revokes this — if it may have gone astray. The
 * person sets their own password and enrols their own authenticator; neither is ever shown here or stored in the
 * clear. Every issue and revoke is audited.
 *
 * Fail-closed on the boundary like every other write here: production APP_ENV is refused and NZI_DATABASE_BOUNDARY must
 * say isolated-non-production.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { issueStaffEnrolmentInvitation, revokeStaffEnrolmentInvitation, StaffEnrolmentError } from "../src/staffEnrolment";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const USAGE = "Usage: enrol:staff <userId> --actor <your name> (--base-url <https://console host> | --revoke) [--organisation <id>] [--hours <n>]";

async function main(): Promise<void> {
  const userId = process.argv[2];
  const actor = argument("--actor")?.trim();
  const revoke = process.argv.includes("--revoke");
  const baseUrl = argument("--base-url");
  const organisationId = argument("--organisation") ?? "net-zero-international";
  const hours = argument("--hours");
  if (!userId || userId.startsWith("--") || !actor || (!revoke && !baseUrl)) throw new Error(USAGE);
  if (baseUrl && !/^https:\/\/[^/\s]+$/.test(baseUrl.replace(/\/$/, ""))) throw new Error("--base-url must be the console's https origin, e.g. https://console.example.com");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const pool = new Pool({ connectionString: url.toString(), max: 1, application_name: "nzi-staff-enrolment" });
  const actorId = `operator:${actor}`;
  try {
    if (revoke) {
      const had = await revokeStaffEnrolmentInvitation(pool, { organisationId, userId, actorId });
      log(had ? `Revoked ${userId}'s open enrolment invitation in ${organisationId}.` : `${userId} had no open enrolment invitation in ${organisationId}.`);
      return;
    }
    const issued = await issueStaffEnrolmentInvitation(pool, { organisationId, userId, actorId, ttlHours: hours ? Number(hours) : undefined });
    log(`\nEnrolment invitation for ${userId} in ${organisationId} — expires ${issued.expiresAt}.`);
    log(`Any earlier open invitation for them is now revoked.\n`);
    log(`  ${baseUrl!.replace(/\/$/, "")}/enrol#token=${issued.token}\n`);
    log("Shown once and stored nowhere. Send it to them privately; if it may have gone astray, issue a new one.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof StaffEnrolmentError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nenrol:staff failed: ${message}\n`);
  process.exitCode = 1;
});
