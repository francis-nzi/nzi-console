// The import, server-side — Phase A (BRIEF-v7-import-server-side; NOTE-v7-import-server-side-phase-a, ruled 13 Nov 2026).
//
// The previous system's emission rows are read through its non-PII view set (`v7-source/v7_import_views.sql`, schema
// `v7_import`, role cc_import_view, NZI_V7_VIEW_URL), in-process: no extract file, no upload. The views carry exactly the
// planner's inputs — ids, codes, numbers, dates and labels already through the label rule — so the reader rebuilds the same
// tables the extract would give, plans them with `planV7ClientImport` unchanged, and diffs with the summary's own emitter,
// unchanged but for one thing: the console's stored labels go through the same rule before comparing (`labels`).
//
// Read and diff only. Nothing here writes to either database: the source read is one REPEATABLE READ READ ONLY transaction,
// always rolled back; the console side is the summary's own comparison (a standing re-ingest reverted under a savepoint that
// is rolled back, as the summary script does).
//
// The guard: before every read, each view's columns are compared, by name and in order, with V7_IMPORT_VIEW_CONTRACT; any
// view or column the contract does not name — a column that could carry PII — and the read is refused.
import { createHash } from "node:crypto";
import type { ClientBase, Pool, PoolConfig } from "pg";
import type { V7ImportSummary } from "@nzi/contracts";
import { verifiedTlsConfig, type TlsPoolConfig } from "./databaseTls";
import type { Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import type { V7Extract, V7Row, V7Table } from "./v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport, type PlannedJob, type PlannedRow } from "./v7ClientImport";
import { btrimV7ImportLabel, sanitiseV7ImportLabel, type V7ImportLabelContext } from "./v7ImportLabel";
import { summariseV7JobAsTheChainSees } from "./v7ImportIngest";
import { V7_IMPORT_LABEL_FIELDS, type V7ImportLabelComparison } from "./v7ImportSummary";

export const V7_IMPORT_VIEW_SCHEMA = "v7_import";

/** Every view of the set and its columns, in order — exactly what the SQL creates. Anything else is refused. */
export const V7_IMPORT_VIEW_CONTRACT = {
  clients: ["db_id", "status", "archived"],
  crp_job_details: ["job_id", "reporting_period_from", "reporting_period_to"],
  datasets: ["dataset_id", "year", "version"],
  emission_groups: ["group_id", "job_id", "dataset_id", "factor_db_id", "original_id", "factor", "ghg_unit", "uom", "enabled"],
  emission_sources: ["source_id", "job_id", "scope", "source_type", "enabled", "group_id", "source_subtype", "site_id", "category", "dataset_id",
    "factor_db_id", "original_id", "qty", "uom", "factor", "ghg_unit", "apply_pct", "calc_tco2e", "data_source", "data_confidence", "review_status",
    "label_person_linked", "label_factor", "label_base"],
  factor_labels: ["label"],
  job_types: ["job_type_id", "name", "job_family", "job_group", "is_crp"],
  jobs: ["job_id", "client_db_id", "job_number", "status", "archived", "job_type_id", "job_type", "reporting_year", "reporting_period_start", "reporting_period_end"],
  scope_rows: ["row_id", "job_id", "scope", "original_id", "qty", "uom", "factor", "ghg_unit", "enabled", "site_id", "dataset_id", "factor_db_id",
    "category", "level_1", "level_2", "level_3", "level_4", "column_text", "report_label", "factor_original_id", "storage_reason", "apply_pct",
    "month_1", "month_2", "month_3", "month_4", "month_5", "month_6", "month_7", "month_8", "month_9", "month_10", "month_11", "month_12",
    "calc_tco2e", "override_tco2e", "data_source", "data_confidence", "is_custom_entry", "linked_row_id", "is_auto_generated", "auto_pair_kind",
    "review_status", "reference_factor", "reference_ghg_unit", "label_person_linked", "label_factor", "label_base"],
  sites: ["site_id", "client_db_id", "is_registered_office", "vacated_date", "archived"],
  spend_entries: ["entry_id", "job_id", "amount_gross", "is_deleted", "site_id", "factor_db_id", "factor_original_id", "mapped_scope",
    "conversion_currency", "currency", "submitted_by_portal", "review_status", "estimated_emissions_tco2e"],
} as const satisfies Record<string, readonly string[]>;
export type V7ImportView = keyof typeof V7_IMPORT_VIEW_CONTRACT;

/** The label rule's context columns: read for the rule, never planned. */
const LABEL_CONTEXT = ["label_person_linked", "label_factor", "label_base"] as const;

const refuse = (code: string, message: string): never => { throw new CommandValidationError([{ field: "source", code, message }]); };

/** Every value as text, exactly as the extract's CSV writes it: the planner reads strings. */
const AS_TEXT = { getTypeParser: () => (value: string) => value };
type Source = Pick<ClientBase, "query">;
const read = async (db: Source, text: string, values: unknown[] = []): Promise<V7Row[]> =>
  (await db.query({ text, values, types: AS_TEXT })).rows as V7Row[];

/**
 * The guard: the view set is exactly the contract. Refused — before anything is read — on a view or a column the contract does
 * not name (by name, never by value), on one it names that is missing, or on columns out of order.
 */
export async function guardV7ImportViews(db: Source): Promise<void> {
  const columns = await read(db, `SELECT c.relname AS view, a.attname AS column FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE n.nspname = $1 ORDER BY c.relname, a.attnum`, [V7_IMPORT_VIEW_SCHEMA]);
  const relations = await read(db, `SELECT c.relname AS view, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p')`, [V7_IMPORT_VIEW_SCHEMA]);
  const actual = new Map<string, string[]>();
  for (const row of columns) actual.set(row.view!, [...(actual.get(row.view!) ?? []), row.column!]);
  const problems: string[] = [];
  for (const relation of relations) {
    const expected = (V7_IMPORT_VIEW_CONTRACT as Record<string, readonly string[]>)[relation.view!];
    if (!expected) { problems.push(`${relation.view} (not in the contract)`); continue; }
    if (relation.kind !== "v") problems.push(`${relation.view} (not a view)`);
    const held = actual.get(relation.view!) ?? [];
    for (const column of held) if (!expected.includes(column)) problems.push(`${relation.view}.${column} (not in the contract)`);
    for (const column of expected) if (!held.includes(column)) problems.push(`${relation.view}.${column} (missing)`);
    const sameSet = held.length === expected.length && held.every((column) => expected.includes(column));
    if (sameSet && held.join(",") !== expected.join(",")) problems.push(`${relation.view} (columns out of order)`);
  }
  for (const view of Object.keys(V7_IMPORT_VIEW_CONTRACT)) if (!relations.some((relation) => relation.view === view)) problems.push(`${view} (missing)`);
  if (problems.length) refuse("VIEW_NOT_AS_CONTRACTED", `The source's import views are not as contracted, so nothing was read: ${problems.slice(0, 10).join(", ")}${problems.length > 10 ? ` and ${problems.length - 10} more` : ""}.`);
}

/** One snapshot of the source, read-only and always rolled back. */
export async function withV7ViewSnapshot<T>(pool: Pick<Pool, "connect">, work: (db: Source) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export type V7ImportViewRead = {
  /** The planner's tables for the one job, as an extract of it would hold them; every other table empty. */
  extract: V7Extract; headers: Partial<Record<V7Table, string[]>>;
  /** The fingerprint of what was read (it stands where an extract's sha256 stands). */
  sourceSha256: string;
  /** The label rule's context, per import identity (`row_id`, or `source:<id>`). */
  labelContexts: Map<string, V7ImportLabelContext>;
};

const without = (row: V7Row, columns: readonly string[]): V7Row => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));
const contextOf = (row: V7Row): V7ImportLabelContext => ({
  personLinked: row.label_person_linked === "t" || row.label_person_linked === "true",
  factorLabel: row.label_factor ?? null, base: row.label_base ?? "Uncategorised", siteId: row.site_id ?? null,
});
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);

/** Read one job from the view set (inside a snapshot, after the guard): exactly one in-scope job, or nothing. */
export async function readV7JobFromViews(db: Source, jobNumber: string): Promise<V7ImportViewRead> {
  if (!/^J\d{6}$/.test(jobNumber)) refuse("JOB_NUMBER", "A job is named by its J number, e.g. J000669.");
  await guardV7ImportViews(db);
  const v = (view: V7ImportView) => `${V7_IMPORT_VIEW_SCHEMA}.${view}`;
  const jobs = await read(db, `SELECT * FROM ${v("jobs")} WHERE job_number = $1 ORDER BY job_id`, [jobNumber]);
  if (jobs.length !== 1) refuse("NOT_ONE_JOB", `${jobNumber} is not exactly one in-scope job of the previous system (an Active or Portfolio Owner client, not archived).`);
  const job = jobs[0]!;
  const ofJob = (view: V7ImportView, key: string) => read(db, `SELECT * FROM ${v(view)} WHERE job_id = $1 ORDER BY ${key}`, [job.job_id]);
  const clients = await read(db, `SELECT * FROM ${v("clients")} WHERE db_id = $1`, [job.client_db_id]);
  const sites = await read(db, `SELECT * FROM ${v("sites")} WHERE client_db_id = $1 ORDER BY site_id`, [job.client_db_id]);
  const jobTypes = await read(db, `SELECT * FROM ${v("job_types")} ORDER BY job_type_id`);
  const datasets = await read(db, `SELECT * FROM ${v("datasets")} ORDER BY dataset_id`);
  const crp = await ofJob("crp_job_details", "job_id");
  const scopeRows = await ofJob("scope_rows", "row_id");
  const groups = await ofJob("emission_groups", "group_id");
  const sources = await ofJob("emission_sources", "source_id");
  const spend = await ofJob("spend_entries", "entry_id");

  const labelContexts = new Map<string, V7ImportLabelContext>();
  for (const row of scopeRows) labelContexts.set(row.row_id!, contextOf(row));
  for (const row of sources) labelContexts.set(`source:${row.source_id}`, contextOf(row));

  // The extract's tables, rebuilt. A name the planner requires and the view never carries is a placeholder of the id alone.
  const tables: Partial<Record<V7Table, V7Row[]>> = {
    clients: clients.map((row) => ({ ...row, client_name: `client ${row.db_id}` })),
    client_sites: sites.map((row) => ({ ...row, site_name: `site ${row.site_id}` })),
    job_types: jobTypes, jobs, crp_job_details: crp, datasets,
    // notes: only its two tokens ever crossed; written back as the only text the planner reads in it.
    job_scope_rows: scopeRows.map((row) => ({
      ...without(row, ["factor_original_id", "storage_reason", ...LABEL_CONTEXT]),
      notes: [row.factor_original_id ? `factor_original_id=${row.factor_original_id}` : null, row.storage_reason ? `storage_reason=${row.storage_reason}` : null]
        .filter(Boolean).join("; ") || null,
    })),
    job_emission_groups: groups, job_emission_sources: sources.map((row) => without(row, LABEL_CONTEXT)), job_spend_entries: spend,
  };
  const headerOf = (view: V7ImportView, extra: readonly string[] = [], drop: readonly string[] = []) =>
    [...V7_IMPORT_VIEW_CONTRACT[view].filter((column) => !drop.includes(column)), ...extra];
  const headers: Partial<Record<V7Table, string[]>> = {
    clients: headerOf("clients", ["client_name"]), client_sites: headerOf("sites", ["site_name"]), job_types: headerOf("job_types"),
    jobs: headerOf("jobs"), crp_job_details: headerOf("crp_job_details"), datasets: headerOf("datasets"),
    job_scope_rows: headerOf("scope_rows", ["notes"], ["factor_original_id", "storage_reason", ...LABEL_CONTEXT]),
    job_emission_groups: headerOf("emission_groups"), job_emission_sources: headerOf("emission_sources", [], LABEL_CONTEXT),
    job_spend_entries: headerOf("spend_entries"),
  };
  const extract = new Proxy(tables, { get: (target, table: string) => target[table as V7Table] ?? [] }) as unknown as V7Extract;
  const sourceSha256 = createHash("sha256").update(stable({ jobNumber, tables })).digest("hex");
  return { extract, headers, sourceSha256, labelContexts };
}

/** Plan the one job from a view read, as the summary script plans it from an extract. A refusal is refused here too. */
export function planV7JobFromViews(viewRead: V7ImportViewRead, jobNumber: string, organisationId = DEFAULT_ORGANISATION): PlannedJob {
  const plan = planV7ClientImport({ extract: viewRead.extract, headers: viewRead.headers, extractSha256: viewRead.sourceSha256, organisationId });
  if (plan.refusals.length) refuse("PLAN_REFUSED", `The job's plan carries ${plan.refusals.length} refusal(s): ${plan.refusals.map((finding) => `${finding.code} ×${finding.count}`).join(", ")}.`);
  const jobs = plan.clients.flatMap((client) => client.jobs).filter((planned) => planned.legacyJobNumber === jobNumber);
  if (jobs.length !== 1) refuse("NOT_ONE_JOB", `${jobNumber} was not planned exactly once.`);
  return jobs[0]!;
}

/**
 * The server-side summary of one job: read from the view set in one snapshot, planned, and diffed against the console's rows
 * exactly as the summary script does it — the same emitter, the same crosswalk keys, the same "as the chain sees it" — with the
 * console's labels compared through the label rule. `consoleDb` is a tenant write transaction (the standing re-ingest is
 * reverted under a savepoint and rolled back); nothing is kept on either side.
 */
export async function summariseV7JobFromViews(consoleDb: Queryable, source: Pick<Pool, "connect">, input: {
  organisationId: string; legacyJobNumber: string; generatedAt?: string;
}): Promise<V7ImportSummary> {
  return withV7ViewSnapshot(source, async (db) => {
    const viewRead = await readV7JobFromViews(db, input.legacyJobNumber);
    const job = planV7JobFromViews(viewRead, input.legacyJobNumber, input.organisationId);
    return summariseV7JobAsTheChainSees(consoleDb, {
      organisationId: input.organisationId, jobId: job.jobId, legacyJobNumber: input.legacyJobNumber, extractSha256: viewRead.sourceSha256,
      rows: job.rows, generatedAt: input.generatedAt, labels: await labelComparison(consoleDb, db, viewRead, input.organisationId, job.jobId),
    });
  });
}

/** The console's own labels on the job, and which of them the source's allow-list holds — the rule's one lookup. */
async function labelComparison(consoleDb: Queryable, db: Source, viewRead: V7ImportViewRead, organisationId: string, jobId: string): Promise<V7ImportLabelComparison> {
  const held = await consoleDb.query<Record<string, string | null>>(
    `SELECT source_label, report_label, level_1, level_2, level_3, level_4, column_text FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_row_id IS NULL`, [organisationId, jobId]);
  const values = [...new Set(held.rows.flatMap((row) => Object.values(row)).filter((value): value is string => value !== null).map(btrimV7ImportLabel))];
  const allowed = new Set((await read(db, `SELECT label FROM ${V7_IMPORT_VIEW_SCHEMA}.factor_labels WHERE label = ANY($1::text[])`, [values])).map((row) => row.label!));
  return { sanitise: (legacyDbId, value) => {
    const context = viewRead.labelContexts.get(legacyDbId);
    return context && value !== null ? sanitiseV7ImportLabel(value, allowed.has(btrimV7ImportLabel(value)), context) : value;
  } };
}

/**
 * The job's rows for the chain (Phase B, `import.refresh`): read from the view set in one snapshot and planned, exactly as the
 * summary above — and then each label the rule explains carried as the console already holds it. The re-sync compares every
 * label column, so without this a label the rule rewrote would read as v7 moving, and the re-sync would supersede (or, in a
 * pair, refuse) a row the summary calls matched. With it, the chain and the summary agree row for row: the summary of these
 * rows, compared plainly, is the server-side summary (`summariseV7JobFromViews`). A label that really changed in the previous
 * system still arrives as the rule makes it. Nothing new enters the console: a carried label is the console's own.
 */
export async function readV7JobRowsFromViews(consoleDb: Queryable, source: Pick<Pool, "connect">, input: { organisationId: string; jobId: string; legacyJobNumber: string }):
  Promise<{ sourceSha256: string; rows: PlannedRow[] }> {
  return withV7ViewSnapshot(source, async (db) => {
    const viewRead = await readV7JobFromViews(db, input.legacyJobNumber);
    const job = planV7JobFromViews(viewRead, input.legacyJobNumber, input.organisationId);
    if (job.jobId !== input.jobId) refuse("JOB_MISMATCH", `${input.legacyJobNumber} is another job in the previous system than this one.`);
    const labels = await labelComparison(consoleDb, db, viewRead, input.organisationId, job.jobId);
    const held = new Map((await consoleDb.query<Record<string, string | null> & { legacy_db_id: string }>(
      `SELECT legacy_db_id, ${Object.keys(V7_IMPORT_LABEL_FIELDS).join(", ")} FROM nzi_console.job_scope_rows
        WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_row_id IS NULL`, [input.organisationId, job.jobId])).rows.map((row) => [row.legacy_db_id, row]));
    const rows = job.rows.map((planned) => {
      const was = held.get(planned.legacyDbId);
      if (!was) return planned;
      const carried: Partial<PlannedRow> = {};
      for (const [column, field] of Object.entries(V7_IMPORT_LABEL_FIELDS) as Array<[keyof typeof V7_IMPORT_LABEL_FIELDS, (typeof V7_IMPORT_LABEL_FIELDS)[keyof typeof V7_IMPORT_LABEL_FIELDS]]>) {
        const mine = was[column] ?? null, now = planned[field];
        if (mine !== null && mine !== now && labels.sanitise(planned.legacyDbId, mine) === now) (carried as Record<string, string>)[field] = mine;
      }
      return Object.keys(carried).length ? { ...planned, ...carried } : planned;
    });
    return { sourceSha256: viewRead.sourceSha256, rows };
  });
}

export class V7ImportViewConnectionRefused extends Error {}

/**
 * A Supabase URL's project ref: the host's (`db.<ref>.supabase.co`, `<ref>.supabase.co`) or, through the shared pooler
 * (`*.pooler.supabase.com`), the user name's suffix (`<role>.<ref>`). Null for any other URL.
 */
export function supabaseProjectRef(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const direct = /^(?:db\.)?([a-z0-9]+)\.supabase\.(?:co|com|in)$/.exec(host);
  if (direct && !host.endsWith(".pooler.supabase.com")) return direct[1]!;
  if (host.endsWith(".pooler.supabase.com")) {
    const user = decodeURIComponent(url.username);
    const at = user.lastIndexOf(".");
    return at > 0 && at < user.length - 1 ? user.slice(at + 1).toLowerCase() : null;
  }
  return null;
}

/**
 * The service's one connection to the view set: NZI_V7_VIEW_URL (cc_import_view), verified TLS, no fallback to any other URL —
 * and never the console's own database. The CA is NZI_V7_VIEW_CA_CERT (or the URL's sslrootcert).
 */
export function v7ImportViewPoolConfig(env: Readonly<Record<string, string | undefined>> = process.env): PoolConfig & { description: TlsPoolConfig["description"] } {
  const raw = env.NZI_V7_VIEW_URL?.trim();
  if (!raw) throw new V7ImportViewConnectionRefused("NZI_V7_VIEW_URL is not set: the import's view set is read through it alone.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new V7ImportViewConnectionRefused("NZI_V7_VIEW_URL is not a database URL."); }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new V7ImportViewConnectionRefused("NZI_V7_VIEW_URL is not a Postgres URL.");
  // Same database = same Supabase project. Through the shared pooler every project has the same host, port and `/postgres`;
  // only the project ref tells them apart. A URL with no ref (not Supabase) is compared by host, port and database instead.
  const same = (other: string | undefined) => {
    if (!other?.trim()) return false;
    let o: URL;
    try { o = new URL(other.trim()); } catch { return false; }
    const mine = supabaseProjectRef(url), theirs = supabaseProjectRef(o);
    if (mine !== null || theirs !== null) return mine === theirs;
    return o.hostname === url.hostname && (o.port || "5432") === (url.port || "5432") && o.pathname === url.pathname;
  };
  if (same(env.NZI_ISOLATED_DATABASE_URL)) throw new V7ImportViewConnectionRefused("NZI_V7_VIEW_URL names the console's own database; it must name the source's view set.");
  const tls = verifiedTlsConfig(url, { caCert: env.NZI_V7_VIEW_CA_CERT });
  return { connectionString: tls.connectionString, ssl: tls.ssl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    application_name: "nzi-import-view", options: "-c default_transaction_read_only=on", description: tls.description };
}
