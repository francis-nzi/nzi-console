/**
 * Change a staff member's role (audited, with a reason) — the break-glass (ruled Q9).
 *
 *   npm run staff:role -- <userId> <admin|consultant|reviewer|finance|viewer> --actor <your name> --reason "<why>" [--organisation <id>]
 *
 * Roles are changed in the console, on Admin → Team & access. This is for when no admin can sign in to do it — and for
 * an organisation's first admin. It runs the same `staff.role.assign` command as the console, with the same guards
 * (never the organisation's last active admin) and the same audit event, as the `system` principal. Run in the Render
 * Shell of the console service.
 *
 * Fail-closed on the boundary like every other write here.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { CommandValidationError } from "../src/postgresCommands";
import { assignStaffRole } from "../src/staffAdmin";

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
  const detail = error instanceof CommandValidationError ? error.issues.map((issue) => issue.message).join(" ") : error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nstaff:role failed: ${detail}\n`);
  process.exitCode = 1;
});
