/**
 * Change a staff member's role (audited, with a reason).
 *
 *   npm run staff:role -- <userId> <admin|consultant|reviewer|finance|viewer> --actor <your name> --reason "<why>" [--organisation <id>]
 *
 * The bootstrap for the first admin: `seed:reference-data` creates every member at the least-privilege role, so one
 * person is made Admin here — which carries `staff.invite` (matrix v8) — and invites the rest from Platform & audit →
 * Access. Run in the Render Shell of the console service. There is deliberately no console route to this: role
 * administration in the UI is its own build.
 *
 * Fail-closed on the boundary like every other write here.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { assignStaffRole } from "../src/staffInvitations";

const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const USAGE = 'Usage: staff:role <userId> <role> --actor <your name> --reason "<why>" [--organisation <id>]';

async function main(): Promise<void> {
  const [userId, role] = process.argv.slice(2);
  const actor = argument("--actor")?.trim(), reason = argument("--reason")?.trim();
  if (!userId || !role || userId.startsWith("--") || role.startsWith("--") || !actor || !reason) throw new Error(USAGE);
  const organisationId = argument("--organisation") ?? "net-zero-international";
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const pool = new Pool({ connectionString: url.toString(), max: 1, application_name: "nzi-staff-role" });
  try {
    const changed = await assignStaffRole(pool, { organisationId, userId, role, actorId: `operator:${actor}`, reason });
    process.stdout.write(`${userId} in ${organisationId}: ${changed.from} → ${changed.to}. Audited as staff.role.assign.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nstaff:role failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
