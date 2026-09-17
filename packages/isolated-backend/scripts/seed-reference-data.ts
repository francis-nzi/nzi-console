/**
 * Load the curated reference lists (NZC-089).
 *
 *   npm run seed:reference-data
 *   npm run seed:reference-data -- --archive-missing
 *
 * Reads `docs/_seed_reference_data.md` — the transcription of the live admin, standing in for an
 * export routine live does not have — and loads Industries, Referrals and the team roster.
 *
 * Idempotent and reconcile-by-reading (§14): a re-run creates nothing, changes nothing and bumps
 * no versions. `--archive-missing` treats the document as the whole truth and archives anything
 * absent from it; off by default, because a partial document would otherwise archive the firm's
 * entire list.
 *
 * Fail-closed on the boundary, like every other write here: production APP_ENV is refused and
 * NZI_DATABASE_BOUNDARY must say isolated-non-production. The roster carries NZI's own staff names
 * and emails, which belong in isolated staging and nowhere further.
 */
import { Pool } from "pg";
import { importReferenceValues, importTeamMembers } from "../src/referenceData";
import { readSeedLists } from "../src/referenceSeedSource";
import { validateDatabaseBoundary } from "../src/databaseBoundary";

const ORG = process.env.NZI_DEMO_ORGANISATION_ID ?? "demo-nzi-console";
const ACTOR = process.env.SEED_ACTOR_ID ?? "acceptance-admin";
const ARCHIVE_MISSING = process.argv.includes("--archive-missing");

const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });

  const lists = readSeedLists();
  log(`\nSeeding reference data into ${ORG}.`);
  log(`  industries ${lists.industries.length} · referrals ${lists.referrals.length} · team ${lists.team.length}`);
  for (const held of lists.excluded) log(`  excluded: ${held.displayName} <${held.email}> — ${held.reason}`);

  const pool = new Pool({ connectionString: url.toString(), max: 3, application_name: "nzi-reference-seed" });
  try {
    const industries = await importReferenceValues(pool,
      { organisationId: ORG, actorId: ACTOR, categoryKey: "industries", values: lists.industries, archiveMissing: ARCHIVE_MISSING });
    log(`\n  industries  +${industries.created} ~${industries.updated} =${industries.unchanged} ↺${industries.reinstated} ⌁${industries.archived}`);

    const referrals = await importReferenceValues(pool,
      { organisationId: ORG, actorId: ACTOR, categoryKey: "referrals", values: lists.referrals, archiveMissing: ARCHIVE_MISSING });
    log(`  referrals   +${referrals.created} ~${referrals.updated} =${referrals.unchanged} ↺${referrals.reinstated} ⌁${referrals.archived}`);

    const team = await importTeamMembers(pool,
      { organisationId: ORG, actorId: ACTOR, members: lists.team, createMissing: true });
    log(`  team        +${team.created} ~${team.updated} =${team.unchanged}`);
    if (team.unknown.length) log(`  team unknown: ${team.unknown.join(", ")}`);

    log("\n  Everyone newly rostered holds the least-privilege role. The live Admin/SuperAdmin roles");
    log("  are deliberately not carried across: being nameable as a client's manager is not permission.");
    log("\n  Industries carry no SIC codes — live has none. The industry→SIC auto-fill stays off until");
    log("  they are curated; inventing codes would put wrong ones on client records.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nseed-reference-data failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
