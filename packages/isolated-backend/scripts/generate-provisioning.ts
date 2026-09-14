// Generates the organisation-provisioning migration from the seeds already in the repo.
//
// The reference data an organisation needs — the SRS framework, the levers, the strategy
// library — is currently written into migrations `0070`, `0075` and `0078` as
// `INSERT ... SELECT ... FROM nzi_console.organisations`. That shape seeds every
// organisation that existed WHEN THE MIGRATION RAN, and nothing re-runs it, so an
// organisation created afterwards silently gets none of it.
//
// The fix needs those same rows callable for one organisation at a time. Rather than
// retyping 48 SRS requirements and 13 strategies into a new file — where a transcription
// slip would be invisible until a tenant noticed a missing requirement — this lifts the
// `VALUES` blocks out of the frozen migrations verbatim and rewrites only the plumbing:
// `FROM organisations o` becomes a parameter, and `0075`'s pre-rename column names become
// their `0078` equivalents.
//
//   npx tsx scripts/generate-provisioning.ts
//
// 0080 is applied and frozen, so regenerating emits a NEW migration that CREATE OR REPLACEs
// the function — everything it does is idempotent, so re-running the trigger creation and the
// backfill over an already-provisioned database is a no-op.
//
// The migration is the artefact and is committed; this is the tool that made it. A CI test
// asserts a newly provisioned organisation ends up with exactly what a migration-seeded one
// has, so the two cannot drift after generation either.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

/** Every `INSERT ... FROM nzi_console.organisations ...` statement in a migration. */
function seedStatements(sql: string): string[] {
  const statements: string[] = [];
  const pattern = /INSERT INTO nzi_console\.\w+[\s\S]*?;\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    if (/FROM nzi_console\.organisations/.test(match[0])) statements.push(match[0]);
  }
  return statements;
}

/**
 * Rewrite a per-every-organisation seed into a per-one-organisation one.
 *
 * `FROM organisations o CROSS JOIN (VALUES …)` becomes `FROM (VALUES …)`, and every
 * `o.organisation_id` becomes the function's parameter. The `VALUES` rows themselves are
 * untouched — that is the whole point.
 */
function forOneOrganisation(statement: string): string {
  const rewritten = statement
    // `FROM organisations o CROSS JOIN (VALUES …)` and `FROM organisations o, (VALUES …)`
    // both become a plain select over the VALUES list.
    .replace(/FROM nzi_console\.organisations o,\s*/g, "FROM ")
    .replace(/FROM nzi_console\.organisations o\s*\n?\s*CROSS JOIN /g, "FROM ")
    // A seed of pure constants has a bare `FROM organisations o` only to fan out across
    // them. For one organisation there is nothing to select from, so the clause goes.
    .replace(/\s*FROM nzi_console\.organisations o\s*(?=;)/g, "")
    .replace(/\bo\.organisation_id\b/g, "p_organisation_id")
    .replace(/;\s*$/, ";");
  if (/nzi_console\.organisations/.test(rewritten)) {
    throw new Error(`Seed still fans out across organisations after rewriting:\n${rewritten.slice(0, 200)}`);
  }
  return rewritten;
}

/** 0075 seeded the library under its pre-0078 name and column spelling. */
function afterRename(statement: string): string {
  return statement
    .replace(/nzi_console\.action_levers/g, "nzi_console.reduction_strategies")
    .replace(/\blever_id\b/g, "strategy_id")
    .replace(/\blever_key\b/g, "strategy_key")
    .replace(/'lever-' \|\| seed\.strategy_key/g, "'lever-' || seed.strategy_key")
    .replace(/sphere_of_influence/g, "control_level");
}

/**
 * `0081`'s alignment seeds are already per-strategy rather than per-organisation, so they
 * need scoping rather than un-fanning: add the organisation filter to the strategy they
 * select from. Lifted for the same reason as the rest — the mapping is 21 pairs, and
 * retyping it is how a default alignment quietly goes missing for a new tenant.
 */
function alignmentSeeds(sql: string): string[] {
  const statements: string[] = [];
  const pattern = /INSERT INTO nzi_console\.strategy_srs_requirements[\s\S]*?ON CONFLICT DO NOTHING;\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const scoped = match[0].replace(/\nWHERE /, "\nWHERE s.organisation_id = p_organisation_id\n  AND ");
    if (!/s\.organisation_id = p_organisation_id/.test(scoped)) {
      throw new Error(`Could not scope an alignment seed to one organisation:\n${match[0].slice(0, 160)}`);
    }
    statements.push(scoped);
  }
  return statements;
}

const srs = seedStatements(read("0070_srs_readiness.sql")).map(forOneOrganisation);
const library = seedStatements(read("0075_action_lever_library.sql")).map(forOneOrganisation).map(afterRename);
const levers = seedStatements(read("0078_reduction_strategies.sql")).map(forOneOrganisation);
const alignments = alignmentSeeds(read("0081_strategy_srs_alignment.sql"));

if (srs.length !== 5) throw new Error(`Expected 5 SRS seed statements, found ${srs.length}`);
if (library.length !== 1) throw new Error(`Expected 1 library seed statement, found ${library.length}`);
if (levers.length !== 1) throw new Error(`Expected 1 lever seed statement, found ${levers.length}`);
if (alignments.length !== 2) throw new Error(`Expected 2 alignment seed statements, found ${alignments.length}`);

const indent = (sql: string) => sql.trimEnd().split("\n").map((line) => `  ${line}`).join("\n");

const sql = `BEGIN;

-- Reference data follows the organisation, instead of the migration that ran once.
--
-- The SRS framework, the levers and the strategy library are seeded with
-- \`INSERT ... SELECT ... FROM nzi_console.organisations\`. That covers every organisation
-- that existed WHEN THE MIGRATION RAN, and nothing re-runs it — so an organisation created
-- afterwards gets no framework, no levers and no library, silently. It is not a theory: the
-- migrations CI run surfaced it, and a client onboarded today would hit the same missing
-- \`srs_frameworks\` that took staging down.
--
-- So provisioning becomes a thing that happens TO AN ORGANISATION rather than a thing a
-- migration did once:
--
--   * \`provision_organisation(id)\` — idempotent, gives one organisation the current
--     reference set, and skips anything it already has.
--   * a trigger on \`organisations\` — because nothing in this repo creates an organisation.
--     They arrive by script or by hand, so a command would be a hook nothing calls. A
--     trigger cannot be bypassed by whichever path is used next.
--   * a backfill for the organisations that already exist.
--
-- The seed rows below are lifted verbatim from 0070 / 0075 / 0078 by
-- \`scripts/generate-provisioning.ts\` rather than retyped, so they cannot differ by a
-- transcription slip. A CI test asserts a newly provisioned organisation matches a
-- migration-seeded one, which guards against drift from here on.
--
-- Everything is guarded by \`NOT EXISTS\` / \`ON CONFLICT DO NOTHING\`: provisioning an
-- organisation twice is a no-op, which is what makes the trigger and the backfill safe to
-- run over each other.

CREATE OR REPLACE FUNCTION nzi_console.provision_organisation(p_organisation_id text)
RETURNS void LANGUAGE plpgsql AS $provision$
BEGIN
  -- ── UK SRS framework ───────────────────────────────────────────────────────────────
  -- Skipped wholesale when the organisation already has a framework: re-seeding v1 next to
  -- a v2 somebody published would give it two, and "one active version" is the rule.
  IF NOT EXISTS (SELECT 1 FROM nzi_console.srs_frameworks WHERE organisation_id = p_organisation_id) THEN
${srs.map(indent).join("\n\n")}
  END IF;

  -- ── Reduction levers ───────────────────────────────────────────────────────────────
${indent(levers[0]!)}

  -- ── The strategy library ───────────────────────────────────────────────────────────
${indent(library[0]!)}

  -- ── Allocate the library to levers ─────────────────────────────────────────────────
  -- Same mapping 0078 applied, keyed on the stable keys rather than generated ids.
  INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
  SELECT s.organisation_id, s.strategy_id, l.lever_id
  FROM nzi_console.reduction_strategies s
  JOIN nzi_console.levers l ON l.organisation_id = s.organisation_id
  WHERE s.organisation_id = p_organisation_id
    AND (s.strategy_key, l.lever_key) IN (
      ('renewable-tariff', 'energy'),
      ('solar-pv', 'energy'), ('solar-pv', 'buildings'),
      ('heat-pump', 'energy'), ('heat-pump', 'buildings'),
      ('led-bms', 'energy'), ('led-bms', 'buildings'),
      ('ev-fleet', 'transport'),
      ('waste-reduction', 'waste'),
      ('supplier-engagement', 'procurement'),
      ('sustainable-procurement', 'procurement'), ('sustainable-procurement', 'governance'),
      ('recycled-packaging', 'procurement'), ('recycled-packaging', 'waste'),
      ('rail-first-travel', 'transport'), ('rail-first-travel', 'governance'),
      ('commuting-plan', 'transport'),
      ('product-take-back', 'waste'),
      ('supplier-code', 'governance')
    )
  ON CONFLICT DO NOTHING;

  -- A strategy with no lever would not render in a plan grouped by lever, so anything the
  -- mapping missed lands under Process & operations rather than vanishing.
  INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id)
  SELECT s.organisation_id, s.strategy_id, l.lever_id
  FROM nzi_console.reduction_strategies s
  JOIN nzi_console.levers l ON (l.organisation_id, l.lever_key) = (s.organisation_id, 'process')
  WHERE s.organisation_id = p_organisation_id
    AND NOT EXISTS (
      SELECT 1 FROM nzi_console.strategy_levers x
      WHERE (x.organisation_id, x.strategy_id) = (s.organisation_id, s.strategy_id)
    )
  ON CONFLICT DO NOTHING;
  -- ── Default SRS alignment on each library strategy ────────────────────────────────
  -- A client copy inherits these; without them a consultant would have to pick a
  -- requirement by hand for every strategy, which is a poor first experience of a rule
  -- that exists to protect the client.
${alignments.map(indent).join("\n\n")}
END
$provision$;

COMMENT ON FUNCTION nzi_console.provision_organisation(text) IS
  'Gives one organisation the current reference set: the SRS framework, the levers and the strategy library. Idempotent — provisioning twice is a no-op, which is what lets the trigger and the backfill run over each other safely.';

-- ── The trigger ──────────────────────────────────────────────────────────────────────
--
-- Nothing in this repository creates an organisation: they arrive by script or by hand. A
-- command would therefore be a hook nothing calls, and the gap would reopen the first time
-- someone inserted a row directly — which is exactly how it opened in the first place.

CREATE OR REPLACE FUNCTION nzi_console.provision_new_organisation()
RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  PERFORM nzi_console.provision_organisation(NEW.organisation_id);
  RETURN NEW;
END
$trigger$;

DROP TRIGGER IF EXISTS provision_on_insert ON nzi_console.organisations;
CREATE TRIGGER provision_on_insert
  AFTER INSERT ON nzi_console.organisations
  FOR EACH ROW EXECUTE FUNCTION nzi_console.provision_new_organisation();

COMMENT ON FUNCTION nzi_console.provision_new_organisation() IS
  'Provisions reference data for a newly inserted organisation, whatever created it. A trigger rather than an application command because nothing in the repo creates organisations — they arrive by script or by hand.';

-- ── Backfill ─────────────────────────────────────────────────────────────────────────
--
-- Idempotent, so it covers the organisations that predate the trigger and does nothing to
-- the ones already complete.

SELECT nzi_console.provision_organisation(organisation_id) FROM nzi_console.organisations;

COMMIT;
`;

const output = process.argv[2];
if (!output) {
  throw new Error(
    "Usage: tsx scripts/generate-provisioning.ts <output.sql>\n" +
    "0080 is applied and frozen — regenerating writes a NEW migration that CREATE OR REPLACEs the function.",
  );
}
writeFileSync(join(MIGRATIONS, output), sql);
console.log(`wrote ${output} (${srs.length} SRS + 1 lever + 1 library + ${alignments.length} alignment seed statements lifted verbatim)`);
