/**
 * The live proof of R-1 (BRIEF-v7-import-server-side Phase A; NOTE-v7-import-server-side-phase-a §3, ruled): across every row
 * the import's view set holds, no label carries PII. Francis runs it against the previous system's database, as cc_import_view:
 *
 *   NZI_V7_VIEW_URL=… NZI_V7_VIEW_CA_CERT=… npm run v7:import-view-check -w @nzi/isolated-backend
 *
 * It prints counts and never a label: the rows read, how many labels each step of the rule produced, how many match each PII
 * pattern (every one must be 0), how many no step of the rule explains (must be 0), and the role's grants outside the view set
 * (must be 0). Exit 1 on any failure. Read-only: one REPEATABLE READ READ ONLY transaction, rolled back.
 */
import { Pool } from "pg";
import {
  btrimV7ImportLabel, V7_IMPORT_LABEL_PII_PATTERNS, v7ImportLabelPiiHits, type V7ImportLabelPattern,
} from "../src/v7ImportLabel";
import { guardV7ImportViews, V7_IMPORT_VIEW_SCHEMA, v7ImportViewPoolConfig, withV7ViewSnapshot } from "../src/v7ImportView";

const log = (line = "") => process.stdout.write(`${line}\n`);
type Row = Record<string, string | null>;
const AS_TEXT = { getTypeParser: () => (value: string) => value };

export type V7ImportViewCheck = {
  rows: { scopeRows: number; emissionSources: number; personLinked: number };
  labels: { empty: number; allowListed: number; generalised: number; scrubbedToSite: number; scrubbedToCategory: number; unexplained: number };
  piiHits: Record<V7ImportLabelPattern, number>;
  allowListPiiHits: number;
  grantsOutsideTheSet: number;
  passed: boolean;
};

/** The check itself, over one snapshot of the view set. Exported for the real-DB test. */
export async function checkV7ImportViews(db: { query: Pool["query"] }): Promise<V7ImportViewCheck> {
  await guardV7ImportViews(db);
  const q = async (text: string, values: unknown[] = []) => (await db.query({ text, values, types: AS_TEXT })).rows as Row[];
  const s = V7_IMPORT_VIEW_SCHEMA;
  const allowList = (await q(`SELECT label FROM ${s}.factor_labels`)).map((row) => row.label!);
  const allowed = new Set(allowList);
  const scopeRows = await q(`SELECT site_id, category, level_1, level_2, level_3, level_4, column_text, report_label, label_person_linked, label_factor, label_base FROM ${s}.scope_rows`);
  const sources = await q(`SELECT site_id, category, label_person_linked, label_factor, label_base FROM ${s}.emission_sources`);
  const grants = await q(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> $1 AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user))`, [s]);

  const labels = { empty: 0, allowListed: 0, generalised: 0, scrubbedToSite: 0, scrubbedToCategory: 0, unexplained: 0 };
  const piiHits = Object.fromEntries(V7_IMPORT_LABEL_PII_PATTERNS.map((pattern) => [pattern.name, 0])) as Record<V7ImportLabelPattern, number>;
  let personLinked = 0;
  const tally = (row: Row, columns: readonly string[]) => {
    const linked = row.label_person_linked === "t" || row.label_person_linked === "true";
    if (linked) personLinked += 1;
    for (const column of columns) {
      const value = row[column] ?? null;
      if (value === null || btrimV7ImportLabel(value) === "") { labels.empty += 1; continue; }
      for (const hit of v7ImportLabelPiiHits(value)) piiHits[hit] += 1;
      // Each label is counted once, against the first of the rule's outputs it is (an allow-listed label can also be a base).
      if (linked && value === row.label_factor) labels.generalised += 1;
      else if (row.site_id !== null && value === `${row.label_base} — site ${row.site_id}`) labels.scrubbedToSite += 1;
      else if (allowed.has(btrimV7ImportLabel(value))) labels.allowListed += 1;
      else if (value === row.label_base) labels.scrubbedToCategory += 1;
      else labels.unexplained += 1;
    }
  };
  for (const row of scopeRows) tally(row, ["category", "level_1", "level_2", "level_3", "level_4", "column_text", "report_label"]);
  for (const row of sources) tally(row, ["category"]);
  const allowListPiiHits = allowList.filter((label) => v7ImportLabelPiiHits(label).length > 0).length;
  const grantsOutsideTheSet = Number(grants[0]?.n ?? 0);
  const passed = Object.values(piiHits).every((count) => count === 0) && labels.unexplained === 0 && grantsOutsideTheSet === 0;
  return { rows: { scopeRows: scopeRows.length, emissionSources: sources.length, personLinked }, labels, piiHits, allowListPiiHits, grantsOutsideTheSet, passed };
}

async function main(): Promise<void> {
  const config = v7ImportViewPoolConfig();
  log(`\nImport view check · ${config.description}`);
  const pool = new Pool(config);
  try {
    const result = await withV7ViewSnapshot(pool, (db) => checkV7ImportViews(db as unknown as { query: Pool["query"] }));
    const { rows, labels } = result;
    log(`  rows read: ${rows.scopeRows} scope row(s), ${rows.emissionSources} register source(s); ${rows.personLinked} person-linked`);
    log(`  labels: ${labels.allowListed} allow-listed · ${labels.generalised} generalised to the factor's text · ${labels.scrubbedToSite} to "<category> — site <id>" · ${labels.scrubbedToCategory} to "<category>" · ${labels.empty} empty`);
    log(`  unexplained by the rule: ${labels.unexplained} (must be 0)`);
    log(`  PII pattern matches: ${Object.entries(result.piiHits).map(([name, count]) => `${name} ${count}`).join(" · ")} (each must be 0)`);
    log(`  allow-list entries the pattern check reduces anyway: ${result.allowListPiiHits} (information; such a label leaves as its category)`);
    log(`  grants to this role outside the view set: ${result.grantsOutsideTheSet} (must be 0)`);
    log(result.passed ? "\nPASSED: no label in the view set carries PII." : "\nFAILED: see the counts above. No label was printed.");
    if (!result.passed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/v7-import-view-check.ts")) {
  main().catch((error) => {
    process.stderr.write(`\nv7-import-view-check failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
