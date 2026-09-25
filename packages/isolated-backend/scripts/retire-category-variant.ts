/**
 * Retire a category variant through the audited `factor.variant.retire` command (NZC-145).
 *
 *   npm run retire:category-variant -- <suffix> "<reason>"
 *
 * There is no registry admin screen yet, so this is how a ruled retirement is carried out: the real command, with its
 * capability check, its audit event and its idempotence — retiring a retired variant reports the state and changes
 * nothing. A retired suffix still parses, so history keeps resolving; it is only withheld from new fan-outs.
 *
 * Ruled 25 Sep 2026: retire `-w` (waste) — not one of v7's ten suffixes.
 *
 * SEED_ACTOR_ID names who is acting; the audit event records it. The organisation (for the audit trail only — the
 * registry is estate-wide) defaults to net-zero-international. Fail-closed on the boundary like every other write here.
 */
import { Pool } from "pg";
import { roleCapabilityGrants } from "@nzi/contracts";
import type { StaffPrincipal } from "../src/auth";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { retireCategoryVariant } from "../src/factorCategoryVariants";

const log = (line = "") => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const [suffixCode, reason] = [process.argv[2], process.argv[3]];
  if (!suffixCode || !reason?.trim()) throw new Error('Usage: retire-category-variant <suffix> "<reason>"');
  const actorId = process.env.SEED_ACTOR_ID;
  if (!actorId) throw new Error("SEED_ACTOR_ID must name who is retiring the variant; the audit event records it.");
  const organisationId = process.env.NZI_ORGANISATION_ID ?? "net-zero-international";

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const principal = {
    organisationId, userId: actorId, sessionId: "operator-script", issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
  } as StaffPrincipal;
  const pool = new Pool({ connectionString: url.toString(), max: 1, application_name: "nzi-retire-category-variant" });
  try {
    const outcome = await retireCategoryVariant(pool, principal, { organisationId, suffixCode, reason: reason.trim() });
    log(outcome.alreadyRetired
      ? `${suffixCode} was already retired; nothing changed.`
      : `${suffixCode} (${outcome.variant.label}) retired by ${actorId}. It still parses; it is withheld from new fan-outs.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nretire-category-variant failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
