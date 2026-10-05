import { dateOnlyOrNull } from "@nzi/contracts";
import { sha256Hex, type LegacyReportParticulars } from "./legacyReportSeal";
import type { Finding } from "./v7ReferenceImport";
import { EXTRACT_CONTRACT, missingColumns, type V7Extract, type V7Row, type V7Table } from "./v7ClientExtract";
import { pyFloat, registerSourceFigure, scopeRowFigure, scopeTotals, type NotReplayable } from "./v7EmissionsFormula";

/**
 * The v7 client-and-job transform (docs/CLIENT_JOB_IMPORT_DESIGN.md): an extract in, a validated plan out. Pure — no
 * database — so every rule is tested directly and a dry run shows what a load would write before anything is.
 *
 * Mirrors the reference import. Three kinds of finding: a **refusal** stops the load; an **exclusion** skips a record
 * for one of a closed list of named reasons (`EXCLUSION_REASONS`); a **report** is shown and the load goes ahead.
 *
 * The rules it carries, each ruled:
 *   - scope: active clients by decision 8 (`Active` or `Portfolio Owner`, not archived) and all their jobs;
 *   - a job's family is its type's `job_family` (then `job_group`), else v7's own name rule — never `is_crp`;
 *   - a migrated row's figure is v7's report-time arithmetic (decision 9, `v7EmissionsFormula`);
 *   - only figure-bearing records become migrated rows: every scope row, and every enabled register source that is not
 *     employee commuting. Spend entries and commuting sources are evidence on the row that bears their figure, never
 *     figures (the double-count guard, §6.1);
 *   - the published report is the version `report_reviews.portal_version_id` names (decision 11), and each job's
 *     migrated figures are reconciled to its snapshot's `scope_totals` — reported, never corrected (decision 2);
 *   - `migrated_record` is a closed shape at every depth: no personal data, no free text (§5.1).
 */

export const SOURCE_SYSTEM = "nzi-pro-v7";
export const DEFAULT_ORGANISATION = "net-zero-international";
export const IMPORT_ACTOR = "import:nzi-pro-v7";

export type { Finding };

/** The only reasons a record may be excluded rather than refused. A closed list: anything else refuses. */
export const EXCLUSION_REASONS = {
  "client-not-in-scope": "a client that is not Active or Portfolio Owner, or is archived (decision 8)",
  "job-without-client": "a job with no client — v7 permits it for training; it is outside a client's history",
  "record-of-excluded-parent": "a record whose client or job is excluded",
  "register-source-disabled": "a disabled register source: v7 does not count it, and it is not a figure",
  "lca-not-frozen": "an LCA assessment that is not verified or published, or has no resolved snapshot: no frozen result",
  "contact-without-name": "a contact with no name: the console requires one, and there is nobody to record",
} as const;
export type ExclusionReason = keyof typeof EXCLUSION_REASONS;
export type ExcludedRecord = { table: V7Table; legacyId: string; reason: ExclusionReason };

// ── Closed vocabularies ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every `data_source` v7 writes: the values its code sets, and the ones live v7 was found to hold (extract of 29 Sep
 * 2026) — v7's own enumerations, not free text. Anything else is carried as "Other" and reported — never as its text.
 */
export const KNOWN_DATA_SOURCES = [
  "Company Data", "Spend Data", "WFM Import", "Legacy Annual Upload", "Previous Year Import",
  "Employee Commuting Template", "Employee Commuting Direct Entry", "Employee Commuting (Consolidated)",
  "Source Register", "Asset Register", "Business Travel Register",
  // Found in live v7, 29 Sep 2026: rows and register sources a client entered in v7's portal, and three more of v7's
  // own labels.
  "Client Portal", "Previous Year", "Business Travel Data", "Custom Dataset",
] as const;
/** v7 never writes these to a row; one in the table would be counted twice beside its sources (§6.1). */
export const CONSOLIDATED_ON_READ = ["Asset Register (Consolidated)", "Business Travel Register (Consolidated)"] as const;
const V7_SYNTHESISED = ["WFM Import", "Legacy Annual Upload"];
const COMMUTING_CONSOLIDATED = "Employee Commuting (Consolidated)";

/** Decision 5 (provisional): v7 job status → console status. v7's own value is kept as the workflow stage. */
export const JOB_STATUS_MAP: Readonly<Record<string, "open" | "complete">> = {
  Open: "open", "Data Gathering Phase": "open", "Reporting Phase": "open", "Awaiting Client Input": "open",
  Completed: "complete", Closed: "complete",
  // Found in live v7, 29 Sep 2026 (30 jobs): v7's fullest "closed" — like Completed and Closed, complete.
  "Job Closed - All Reports, Invoices and Support Completed": "complete",
};
const ACTIVE_CLIENT_STATUSES = ["Active", "Portfolio Owner"];
const REVIEW_STATUSES = ["pending", "submitted", "approved", "rejected"] as const;

export const MIGRATED_FLAGS = [
  "monthly-dataset-map-absent", "monthly-factor-relookup", "custom-factor-monthly", "unit-needs-lookup",
  "fallback-needs-lookup", "v7-synthesised", "data-source-unlisted", "stored-figure-differs", "negative-quantity",
  "v7-custom-entry", "review-status-unlisted", "apply-pct-out-of-range", "register-source",
] as const satisfies readonly (NotReplayable | string)[];
export type MigratedFlag = (typeof MIGRATED_FLAGS)[number];

// ── The migrated record, and the guard that keeps it closed at every depth ─────────────────────────────────

export type MigratedRecord = {
  qty: number | null; uom: string | null; months?: Array<number | null>; apply_pct: number | null;
  factor: number | null; ghg_unit: string | null; original_id: string | null; factor_db_id?: string | null;
  dataset?: { id: string; year: number | null; version: string | null };
  reported_tco2e: number; stored_calc_tco2e?: number | null; override_tco2e?: number | null;
  data_source: string; data_confidence?: "H" | "M" | "L" | null; enabled: boolean; review_status?: string | null;
  register?: { source_id: string; group_id: string | null; source_type: string | null; source_subtype: string | null };
  evidence?: {
    spend?: { entry_ids: string[]; count: number; amount_gross: number; currencies: string[] };
    commuting?: { source_ids: string[]; count: number; total_qty: number; total_calc_tco2e: number };
  };
  flags?: MigratedFlag[];
};

type Leaf = "number" | "number|null" | "boolean" | "id" | "id|null" | "unit|null" | "code|null" | "token|null"
  | "data-source" | "confidence|null" | "review|null" | "version|null" | "currency" | "flag";
type Shape = Leaf | { object: Readonly<Record<string, Shape>> } | { array: Shape; length?: number };

/**
 * The closed shape of `migrated_record`, key by key, at every depth. 0133's CHECK closes only the top level; this
 * closes the rest, and the plan refuses any record it rejects. A string leaf is always an id, a unit, a factor code,
 * a lowercase token or a member of a closed list — never free text — and no string anywhere may carry an "@".
 */
export const MIGRATED_RECORD_SHAPE: { object: Readonly<Record<string, Shape>> } = {
  object: {
    qty: "number|null", uom: "unit|null", months: { array: "number|null", length: 12 }, apply_pct: "number|null",
    factor: "number|null", ghg_unit: "unit|null", original_id: "code|null", factor_db_id: "id|null",
    dataset: { object: { id: "id", year: "number|null", version: "version|null" } },
    reported_tco2e: "number", stored_calc_tco2e: "number|null", override_tco2e: "number|null",
    data_source: "data-source", data_confidence: "confidence|null", enabled: "boolean", review_status: "review|null",
    register: { object: { source_id: "id", group_id: "id|null", source_type: "token|null", source_subtype: "token|null" } },
    evidence: {
      object: {
        spend: { object: { entry_ids: { array: "id" }, count: "number", amount_gross: "number", currencies: { array: "currency" } } },
        commuting: { object: { source_ids: { array: "id" }, count: "number", total_qty: "number", total_calc_tco2e: "number" } },
      },
    },
    flags: { array: "flag" },
  },
};

const LEAF_RULES: Record<Leaf, (value: unknown) => boolean> = {
  number: (value) => typeof value === "number" && Number.isFinite(value),
  "number|null": (value) => value === null || (typeof value === "number" && Number.isFinite(value)),
  boolean: (value) => typeof value === "boolean",
  id: (value) => typeof value === "string" && /^\d{1,18}$/.test(value),
  "id|null": (value) => value === null || (typeof value === "string" && /^\d{1,18}$/.test(value)),
  // Units come from v7's factor library ("kWh", "passenger.km", "room per night", "kgCO2e").
  "unit|null": (value) => value === null || (typeof value === "string" && /^[A-Za-z0-9 .\/%()²³_+-]{0,40}$/.test(value)),
  // Factor codes: DESNZ ("7_400_4000_5_1"), spend ("SPEND-SIC-49.3-5-u"), IEA country names, v7's own synthetic ids.
  "code|null": (value) => value === null || (typeof value === "string" && /^[A-Za-z0-9 ._:()\/&'-]{1,120}$/.test(value)),
  "token|null": (value) => value === null || (typeof value === "string" && /^[a-z0-9_-]{1,40}$/.test(value)),
  "data-source": (value) => value === "Other" || (KNOWN_DATA_SOURCES as readonly unknown[]).includes(value),
  "confidence|null": (value) => value === null || value === "H" || value === "M" || value === "L",
  "review|null": (value) => value === null || value === "other" || (REVIEW_STATUSES as readonly unknown[]).includes(value),
  "version|null": (value) => value === null || (typeof value === "string" && /^[A-Za-z0-9 ._-]{1,40}$/.test(value)),
  currency: (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value),
  flag: (value) => (MIGRATED_FLAGS as readonly unknown[]).includes(value),
};

/** Every way a record departs from the closed shape, by path. Empty means it may be stored. */
export function migratedRecordProblems(record: unknown): string[] {
  const problems: string[] = [];
  const walk = (value: unknown, shape: Shape, path: string) => {
    if (typeof value === "string" && value.includes("@")) problems.push(`${path}: carries an "@"`);
    if (typeof shape === "string") {
      if (!LEAF_RULES[shape](value)) problems.push(`${path}: not a ${shape}`);
      return;
    }
    if ("array" in shape) {
      if (!Array.isArray(value)) { problems.push(`${path}: not an array`); return; }
      if (shape.length !== undefined && value.length !== shape.length) problems.push(`${path}: ${value.length} items, not ${shape.length}`);
      value.forEach((item, index) => walk(item, shape.array, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) { problems.push(`${path}: not an object`); return; }
    for (const [key, item] of Object.entries(value)) {
      const child = shape.object[key];
      if (!child) { problems.push(`${path}.${key}: not an allowed key`); continue; }
      walk(item, child, `${path}.${key}`);
    }
  };
  walk(record, MIGRATED_RECORD_SHAPE, "migrated_record");
  return problems;
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedClient = {
  clientId: string; legacyId: string;
  fields: {
    name: string; status: "active"; sector: string | null; website: string | null; companyRegistration: string | null;
    headquarters: string | null; financialYearEndMonth: number | null; currency: string; companyDescription: string | null;
    portfolio: string | null; referral: string | null; ownerName: string | null; clientManager: string | null;
    registeredAddressLine1: string | null; registeredAddressLine2: string | null; registeredCity: string | null;
    registeredRegion: string | null; registeredPostcode: string | null; registeredCountry: string | null;
    netZeroTargetYear: number | null;
    interim: { year: number | null; scope1Pct: number | null; scope2Pct: number | null; scope3Pct: number | null };
    baseline: { periodStart: string | null; periodEnd: string | null; scope1: number | null; scope2: number | null; scope3: number | null; total: number | null };
  };
  target: PlannedTarget | null;
  /**
   * For a Portfolio Owner client: the portfolio v7 links to it (portfolios_lookup.portfolio_owner_client_db_id — v7's
   * "single source of truth for portfolio membership") and the in-scope clients whose portfolio carries that name.
   * Captured with the load and reported; the console has no place to write it yet (a design decision, not an import
   * detail). null for every other client, and for an owner v7 never linked.
   */
  portfolioOwnership: { legacyPortfolioId: string; name: string; memberLegacyIds: string[] } | null;
  sites: PlannedSite[]; contacts: PlannedContact[]; jobs: PlannedJob[];
};
export type PlannedTarget = {
  benchmarkYear: number; benchmarkTotal: number; benchmarkScope1: number | null; benchmarkScope2: number | null; benchmarkScope3: number | null;
  scope1: { year: number; pct: number } | null; scope2: { year: number; pct: number } | null; scope3: { year: number; pct: number } | null;
};
export type PlannedSite = {
  siteId: string; legacyId: string; name: string; addressLines: string[]; latitude: number | null; longitude: number | null;
  archived: boolean; isRegisteredOffice: boolean; vacatedEffective: string | null;
};
export type PlannedContact = {
  contactId: string; legacyId: string; fullName: string; jobTitle: string | null; email: string | null; phone: string | null; isPrimary: boolean;
};
export type PlannedRow = {
  scopeRowId: string; legacyDbId: string; scope: "1" | "2" | "3"; v7Scope: string;
  sourceLabel: string; reportLabel: string; level1: string; level2: string; level3: string | null; level4: string | null;
  columnText: string | null; quantity: number | null; unit: string | null; datasetId: string | null; factorId: string | null;
  calculatedTco2e: number; reviewStatus: "pending" | "approved" | "rejected"; enabled: boolean; applyPct: number;
  dataConfidence: "H" | "M" | "L" | null; siteId: string | null; isAutoGenerated: boolean; autoPairKind: string | null;
  linkedRowId: string | null; migratedRecord: MigratedRecord;
  provenance: Record<string, unknown>; lineage: Array<Record<string, unknown>>;
  /** Whether v7 counted it in the job's total: an enabled scope row, or an enabled non-commuting register source. */
  counted: boolean;
};
export type PlannedReport = {
  legacyReportId: string; legacyDbId: string; kind: "report" | "lca-result"; versionNumber: number | null;
  legacyStatus: string; reportFormat: string | null; isPortalVersion: boolean; storageProvider: string | null;
  generatedAt: string | null; reviewedAt: string | null; finalizedAt: string | null; supersededAt: string | null;
  payloadText: string | null; v7DataHash: string | null; particulars: LegacyReportParticulars;
};
export type Reconciliation = {
  published: { legacyReportId: string; status: string } | null;
  migrated: ReturnType<typeof scopeTotals>;
  snapshot: Partial<ReturnType<typeof scopeTotals>> | null;
  differences: string[];
};
export type PlannedJob = {
  jobId: string; legacyId: string; sequence: number; legacyJobNumber: string; legacyWfmJobNo: string | null;
  family: "crp" | "consultancy" | "lca" | "pcf" | "training"; title: string; status: "open" | "complete" | "cancelled";
  workflowStage: string; reportingYear: number | null; startDate: string | null; dueDate: string | null;
  periodStart: string | null; periodEnd: string | null; ownerName: string | null; createdAt: string | null;
  detail: Record<string, unknown>; rows: PlannedRow[]; reports: PlannedReport[]; reconciliation: Reconciliation;
};

export type ClientImportPlan = {
  organisationId: string; extractSha256: string;
  clients: PlannedClient[];
  refusals: Finding[]; exclusions: Finding[]; reports: Finding[];
  excluded: ExcludedRecord[];
  summary: {
    clients: number; portfolioOwners: number; sites: number; contacts: number; jobs: number;
    rows: number; rowsEnabled: number; registerRows: number; reports: number; lcaResults: number;
    jobsPublished: number; jobsReconciled: number; jobsWithDifferences: number; maxSequence: number;
    portfolioOwnersLinked: number;
  };
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const text = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" || /^(nan|none|null)$/i.test(trimmed) ? null : trimmed;
};
const flag = (value: string | null | undefined): boolean => /^(t|true|1|yes|y)$/i.test((value ?? "").trim());
const integer = (value: string | null | undefined): number | null => {
  const parsed = pyFloat(value ?? null);
  return parsed === null ? null : Math.trunc(parsed);
};
/** The day a v7 date or timestamp cell names: the shared helper, after v7's NULL spellings, and only if it is a day. */
const v7Day = (value: string | null | undefined): string | null => {
  const day = dateOnlyOrNull(text(value));
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};
const within = (value: number | null, low: number, high: number): number | null =>
  value !== null && value >= low && value <= high ? value : null;
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (value: string | null): number | null => {
  const cleaned = text(value)?.toLowerCase();
  if (!cleaned) return null;
  const numeric = within(integer(cleaned), 1, 12);
  if (numeric !== null && /^\d+$/.test(cleaned)) return numeric;
  const index = MONTH_NAMES.findIndex((name) => cleaned.startsWith(name));
  return index >= 0 ? index + 1 : null;
};
const scopeDigit = (value: string | null | undefined): "1" | "2" | "3" | null => {
  const match = /^\s*(?:scope\s*)?([123])\s*$/i.exec(value ?? "");
  return match ? (match[1] as "1" | "2" | "3") : null;
};
const byNumericId = (key: string) => (a: V7Row, b: V7Row) => Number(a[key]) - Number(b[key]) || String(a[key]).localeCompare(String(b[key]));

/** v7's name rule for a job type's family (`core/migrations.py:437-487`), in its order. */
export function familyByV7NameRule(name: string | null | undefined): PlannedJob["family"] {
  const lower = (name ?? "").toLowerCase();
  if (lower.includes("training")) return "training";
  if (lower.includes("consult") || lower.includes("policy development") || lower.includes("strategy workshop")
    || lower.includes("monthly support services") || lower.includes("support services")) return "consultancy";
  if (lower.includes("life cycle") || lower.includes("assessment")) return "lca";
  if (lower.includes("product carbon") || lower.includes("pcf")) return "pcf";
  return "crp";
}
const FAMILIES = ["crp", "consultancy", "lca", "pcf", "training"] as const;

/** A job's family: its type's `job_family`, then `job_group`, then v7's name rule — as v7 resolves it. */
export function familyOfJob(job: V7Row, types: ReadonlyMap<string, V7Row>): string {
  const type = job.job_type_id == null ? undefined : types.get(job.job_type_id);
  if (type) return text(type.job_family) ?? text(type.job_group) ?? familyByV7NameRule(type.name);
  return familyByV7NameRule(job.job_type ?? null);
}

// ── Planning ────────────────────────────────────────────────────────────────────────────────────────────────

export type PlanInput = {
  extract: V7Extract;
  headers?: Partial<Record<V7Table, readonly string[]>>;
  extractSha256: string;
  organisationId?: string;
  /** From reading the extract: a file that disagrees with its manifest. Each is a refusal. */
  extractProblems?: readonly string[];
};

export function planV7ClientImport(input: PlanInput): ClientImportPlan {
  const organisationId = input.organisationId ?? DEFAULT_ORGANISATION;
  const refusals = new Map<string, Finding>();
  const exclusions = new Map<string, Finding>();
  const reports = new Map<string, Finding>();
  const excluded: ExcludedRecord[] = [];
  const note = (into: Map<string, Finding>, code: string, message: string, example: string) => {
    const found = into.get(code) ?? { code, message, count: 0, examples: [] };
    found.count += 1;
    if (found.examples.length < 5) found.examples.push(example);
    into.set(code, found);
  };
  const refuse = (code: string, message: string, example: string) => note(refusals, code, message, example);
  const report = (code: string, message: string, example: string) => note(reports, code, message, example);
  const exclude = (table: V7Table, legacyId: string, reason: ExclusionReason) => {
    excluded.push({ table, legacyId, reason });
    note(exclusions, reason, EXCLUSION_REASONS[reason], `${table} ${legacyId}`);
  };
  const { extract } = input;

  for (const problem of input.extractProblems ?? []) refuse("extract-manifest", "the extract does not match its manifest", problem);
  for (const [table, header] of Object.entries(input.headers ?? {}) as Array<[V7Table, readonly string[]]>) {
    for (const column of missingColumns(table, header)) refuse("extract-column-missing", "a column the import reads is not in the extract", `${table}.${column}`);
  }
  const hasColumn = (table: V7Table, column: string): boolean =>
    input.headers?.[table] ? input.headers[table]!.includes(column) : (extract[table][0] !== undefined && column in extract[table][0]!);

  // One row per v7 id, per table. A repeat is an extract fault, and loading either copy would be a guess.
  const idColumn: Record<V7Table, string> = {
    clients: "db_id", client_sites: "site_id", client_contacts: "contact_id", job_types: "job_type_id", jobs: "job_id",
    crp_job_details: "job_id", datasets: "dataset_id", job_scope_rows: "row_id", job_emission_groups: "group_id",
    job_emission_sources: "source_id", job_spend_entries: "entry_id", lca_assessments: "assessment_id",
    job_report_versions: "report_version_id", report_reviews: "job_id", portfolios_lookup: "portfolio_id", job_plan: "job_id",
    // The admin lookups (A3) — the client import does not read them; load:v7-lookups does.
    industries_lookup: "industry_id", referrals_lookup: "referral_id", payment_terms_lookup: "term_id", positions_lookup: "position_id",
    processes_lookup: "process_id", client_teams_lookup: "client_team_id", action_categories_lookup: "category_id",
    governance_subjects_lookup: "governance_subject_id", bd_bin_reasons_lookup: "bin_reason_id", uom_lookup: "uom_id",
    job_item_categories_lookup: "category_id",
    // Jobs configuration (admin C4) — read by load:v7-jobs-config, not the client import.
    vat_rates_lookup: "vat_rate_id", milestone_templates: "template_id", milestone_template_items: "item_id",
    job_template_milestone_completions: "completion_id", job_file_types_lookup: "file_type_id",
    // Currencies (admin E1) — read by load:v7-currencies; the legacy table is keyed by its code.
    currency_lookup: "currency_id", currencies_lookup: "currency_code",
    // The service catalogue (admin E2) — read by load:v7-job-items.
    job_items: "item_id",
    // Job-type templates (admin E3) — read by load:v7-job-type-items.
    job_type_items: "job_type_item_id",
    // Suppliers and their rate card (admin E4) — read by load:v7-suppliers. Contacts sealed on load.
    suppliers: "supplier_id", supplier_service_items: "supplier_item_id",
    // Message templates (admin F1) — read by load:v7-message-templates; content onto the console's known keys only.
    message_templates: "template_id",
    // CRM and BD lookups (admin F2) — load:v7-crm-tags, load:v7-bd-service-lines (keyed by its text key), load:v7-bd-funnel-stages.
    crm_tags: "tag_id", bd_service_lines: "service_key", bd_funnel_stages: "stage_id",
    // Custom field definitions (admin F3) — read by load:v7-custom-fields; definitions only, never values.
    custom_field_definitions: "field_id",
    // Staff (admin B2) — read by load:v7-staff, not the client import. v7's user id is the email address.
    users: "user_id",
    // Organisation settings (admin D2) — read by load:v7-org-settings; only the allow-listed profile and logo keys.
    system_settings: "setting_key",
    // Time (⚑7) — read by load:v7-time, not the client import: v7's activity subjects and the time logged on imported jobs.
    time_subjects: "subject_id", time_logs: "time_id",
  };
  const index = (table: V7Table): Map<string, V7Row> => {
    const map = new Map<string, V7Row>();
    for (const row of extract[table]) {
      const id = row[idColumn[table]];
      if (id === null || id === undefined) { refuse("extract-id-missing", "a row with no v7 id", table); continue; }
      if (map.has(id)) refuse("extract-duplicate-id", "a v7 id appears twice in one table", `${table} ${id}`);
      map.set(id, row);
    }
    return map;
  };
  const clientsById = index("clients");
  const types = index("job_types");
  const datasets = index("datasets");
  const groups = index("job_emission_groups");
  const crpDetails = index("crp_job_details");
  const reviews = index("report_reviews");
  const portfolios = index("portfolios_lookup");
  index("client_sites"); index("client_contacts"); index("jobs"); index("job_scope_rows");
  index("job_emission_sources"); index("job_spend_entries"); index("lca_assessments"); index("job_report_versions");

  // ── Clients (decision 8) ──
  const inScope = new Set<string>();
  let portfolioOwners = 0;
  for (const client of [...clientsById.values()].sort(byNumericId("db_id"))) {
    const status = text(client.status) ?? "Active";
    if (!ACTIVE_CLIENT_STATUSES.includes(status) || flag(client.archived)) { exclude("clients", client.db_id!, "client-not-in-scope"); continue; }
    if (!text(client.client_name)) { refuse("client-without-name", "an in-scope client with no name", `client ${client.db_id}`); continue; }
    if (status === "Portfolio Owner") portfolioOwners += 1;
    inScope.add(client.db_id!);
  }
  if (portfolioOwners > 0) report("client-portfolio-owner", "Portfolio Owner clients imported as active (decision 8; decision 5 provisional)", `${portfolioOwners} client(s)`);

  // Portfolio ownership, as v7 resolves it (services/portfolio.py _resolve_owner_portfolio_name): an owner's portfolio
  // is its ACTIVE portfolios_lookup link, lowest portfolio_id first; members are clients whose own portfolio names it,
  // case-insensitively. Never guessed from clients.portfolio alone, which v7 defaults to "NZI" everywhere.
  const ownership = new Map<string, { legacyPortfolioId: string; name: string; memberLegacyIds: string[] }>();
  for (const link of [...portfolios.values()].sort(byNumericId("portfolio_id"))) {
    const owner = text(link.portfolio_owner_client_db_id);
    const name = text(link.name);
    if (!owner || !name || (text(link.is_active) !== null && !flag(link.is_active))) continue;
    if (!inScope.has(owner)) {
      report("portfolio-owner-out-of-scope", "a v7 portfolio whose owner is not an in-scope client; the link is not carried", `portfolio ${link.portfolio_id} → client ${owner}`);
      continue;
    }
    if (ownership.has(owner)) continue; // v7 takes the first
    const members = [...inScope].filter((id) => id !== owner && text(clientsById.get(id)?.portfolio)?.toLowerCase() === name.toLowerCase())
      .sort((a, b) => Number(a) - Number(b));
    ownership.set(owner, { legacyPortfolioId: link.portfolio_id!, name, memberLegacyIds: members });
    report("portfolio-owner-linked", "a Portfolio Owner and the portfolio v7 links to it, with its in-scope members — captured; the console has nowhere to write it yet", `client ${owner} owns portfolio ${link.portfolio_id} "${name}": ${members.length} in-scope member(s)`);
  }
  for (const id of inScope) {
    if (text(clientsById.get(id)?.status) === "Portfolio Owner" && !ownership.has(id)) {
      report("portfolio-owner-unlinked", "a Portfolio Owner client v7 never linked to a portfolio (v7's own admin screen flags these)", `client ${id}`);
    }
  }

  const childOf = (table: V7Table, row: V7Row, clientKey = "client_db_id"): "in" | "excluded" | "orphan" => {
    const clientId = row[clientKey];
    if (clientId === null || clientId === undefined) return "orphan";
    if (inScope.has(clientId)) return "in";
    return clientsById.has(clientId) ? "excluded" : "orphan";
  };

  // ── Jobs ──
  const jobsById = new Map<string, V7Row>();
  const sequences = new Map<number, string>();
  for (const job of [...extract.jobs].sort(byNumericId("job_id"))) {
    const id = job.job_id!;
    if (job.client_db_id === null) { exclude("jobs", id, "job-without-client"); continue; }
    const parent = childOf("jobs", job);
    if (parent === "excluded") { exclude("jobs", id, "record-of-excluded-parent"); continue; }
    if (parent === "orphan") { refuse("orphaned-record", "a record points at a v7 parent the extract does not hold", `jobs ${id} → client ${job.client_db_id}`); continue; }
    const number = text(job.job_number);
    if (!number || !/^J\d{6}$/.test(number)) { refuse("job-number-non-standard", "a job number that is not J + six digits (decision 1a keeps v7's numbers)", `job ${id}`); continue; }
    const sequence = Number(number.slice(1));
    if (sequences.has(sequence)) { refuse("job-number-repeated", "two v7 jobs hold one job number", `${number}: jobs ${sequences.get(sequence)} and ${id}`); continue; }
    sequences.set(sequence, id);
    const status = text(job.status) ?? "Open";
    if (!flag(job.archived) && !JOB_STATUS_MAP[status]) { refuse("job-status-unknown", "a v7 job status with no ruled mapping (decision 5)", `"${status}"`); continue; }
    const family = familyOfJob(job, types);
    if (!(FAMILIES as readonly string[]).includes(family)) { refuse("job-family-unknown", "a job type's family is not one the console knows", `job ${id}: "${family}"`); continue; }
    if (job.job_type_id != null && !types.has(job.job_type_id)) report("job-type-missing", "a job's type is not in the extract; its family came from v7's name rule on the job's own type text", `job ${id}`);
    jobsById.set(id, job);
  }
  const jobOf = (table: V7Table, row: V7Row): V7Row | null => {
    const job = row.job_id == null ? undefined : jobsById.get(row.job_id);
    if (job) return job;
    const known = extract.jobs.some((candidate) => candidate.job_id === row.job_id);
    if (known) exclude(table, row[idColumn[table]] ?? "?", "record-of-excluded-parent");
    else refuse("orphaned-record", "a record points at a v7 parent the extract does not hold", `${table} ${row[idColumn[table]]} → job ${row.job_id}`);
    return null;
  };

  // ── Children, grouped under their parents ──
  const group = <K extends string>(rows: readonly V7Row[], key: K) => {
    const map = new Map<string, V7Row[]>();
    for (const row of rows) { const k = row[key]; if (k === null || k === undefined) continue; map.set(k, [...(map.get(k) ?? []), row]); }
    return map;
  };
  const sitesByClient = group(extract.client_sites.filter((site) => {
    const parent = childOf("client_sites", site);
    if (parent === "excluded") exclude("client_sites", site.site_id!, "record-of-excluded-parent");
    if (parent === "orphan") refuse("orphaned-record", "a record points at a v7 parent the extract does not hold", `client_sites ${site.site_id} → client ${site.client_db_id}`);
    return parent === "in";
  }), "client_db_id");
  const contactsByClient = group(extract.client_contacts.filter((contact) => {
    const parent = childOf("client_contacts", contact);
    if (parent === "excluded") exclude("client_contacts", contact.contact_id!, "record-of-excluded-parent");
    if (parent === "orphan") refuse("orphaned-record", "a record points at a v7 parent the extract does not hold", `client_contacts ${contact.contact_id} → client ${contact.client_db_id}`);
    return parent === "in";
  }), "client_db_id");
  const rowsByJob = group(extract.job_scope_rows.filter((row) => jobOf("job_scope_rows", row)), "job_id");
  const sourcesByJob = group(extract.job_emission_sources.filter((row) => jobOf("job_emission_sources", row)), "job_id");
  const spendByJob = group(extract.job_spend_entries.filter((row) => jobOf("job_spend_entries", row)), "job_id");
  const lcaByJob = group(extract.lca_assessments.filter((row) => jobOf("lca_assessments", row)), "job_id");
  const versionsByJob = group(extract.job_report_versions.filter((row) => jobOf("job_report_versions", row)), "job_id");

  const referenceKnown = hasColumn("job_scope_rows", "reference_factor") && hasColumn("job_scope_rows", "reference_ghg_unit");
  if (!referenceKnown) report("extract-reference-lookup-absent", "the extract carries no factor-lookup reference; rows whose unit or fallback turns on it are flagged", "job_scope_rows.reference_factor / reference_ghg_unit");

  const clients: PlannedClient[] = [];
  let maxSequence = 0;
  for (const clientLegacyId of [...inScope].sort((a, b) => Number(a) - Number(b))) {
    const v7 = clientsById.get(clientLegacyId)!;
    const clientId = `v7-client-${clientLegacyId}`;

    // Sites: names unique per client, one live registered office.
    const sites: PlannedSite[] = [];
    const siteIds = new Set<string>();
    const names = new Set<string>();
    let registeredOffice = false;
    for (const site of (sitesByClient.get(clientLegacyId) ?? []).sort(byNumericId("site_id"))) {
      let name = text(site.site_name);
      if (!name) { name = `Unnamed site (v7 site ${site.site_id})`; report("site-without-name", "a v7 site with no name, given a placeholder", `site ${site.site_id}`); }
      if (names.has(name.toLowerCase())) { report("site-name-repeated", "a v7 site name repeated within one client, suffixed with its v7 id", `site ${site.site_id}`); name = `${name} (v7 site ${site.site_id})`; }
      names.add(name.toLowerCase());
      const vacated = v7Day(site.vacated_date);
      const archived = flag(site.archived);
      let isRegisteredOffice = flag(site.is_registered_office);
      if (isRegisteredOffice && (vacated || archived)) { isRegisteredOffice = false; report("registered-office-closed", "a closed v7 site marked registered office; the mark is dropped", `site ${site.site_id}`); }
      if (isRegisteredOffice && registeredOffice) { isRegisteredOffice = false; report("registered-office-repeated", "a second live registered office on one client; only the first keeps the mark", `site ${site.site_id}`); }
      registeredOffice ||= isRegisteredOffice;
      const location = text(site.location);
      sites.push({
        siteId: `v7-site-${site.site_id}`, legacyId: site.site_id!, name, addressLines: location ? [location] : [],
        latitude: pyFloat(site.latitude ?? null), longitude: pyFloat(site.longitude ?? null), archived, isRegisteredOffice,
        vacatedEffective: vacated,
      });
      siteIds.add(site.site_id!);
    }

    // Contacts: one active primary.
    const contacts: PlannedContact[] = [];
    let primary = false;
    for (const contact of (contactsByClient.get(clientLegacyId) ?? []).sort(byNumericId("contact_id"))) {
      const fullName = text(contact.full_name);
      if (!fullName) { exclude("client_contacts", contact.contact_id!, "contact-without-name"); continue; }
      let isPrimary = flag(contact.is_primary);
      if (isPrimary && primary) { isPrimary = false; report("contact-primary-repeated", "a second primary contact on one client; only the first stays primary", `contact ${contact.contact_id}`); }
      primary ||= isPrimary;
      contacts.push({ contactId: `v7-contact-${contact.contact_id}`, legacyId: contact.contact_id!, fullName,
        jobTitle: text(contact.job_title), email: text(contact.email), phone: text(contact.phone), isPrimary });
    }

    const fields = clientFields(v7, clientLegacyId, report);
    const target = clientTarget(v7, clientLegacyId, report);

    // Jobs.
    const jobs: PlannedJob[] = [];
    for (const job of [...jobsById.values()].filter((candidate) => candidate.client_db_id === clientLegacyId).sort(byNumericId("job_id"))) {
      const planned = planJob(job);
      if (planned) { jobs.push(planned); maxSequence = Math.max(maxSequence, planned.sequence); }
    }
    clients.push({ clientId, legacyId: clientLegacyId, fields, target, sites, contacts, jobs, portfolioOwnership: ownership.get(clientLegacyId) ?? null });

    function planJob(v7Job: V7Row): PlannedJob | null {
      const id = v7Job.job_id!;
      const jobNumber = text(v7Job.job_number)!;
      const family = familyOfJob(v7Job, types) as PlannedJob["family"];
      const statusText = text(v7Job.status) ?? "Open";
      const status = flag(v7Job.archived) ? "cancelled" : JOB_STATUS_MAP[statusText]!;
      const crp = crpDetails.get(id);
      let periodStart = v7Day(v7Job.reporting_period_start) ?? v7Day(crp?.reporting_period_from);
      let periodEnd = v7Day(v7Job.reporting_period_end) ?? v7Day(crp?.reporting_period_to);
      if (periodStart && periodEnd && periodStart >= periodEnd) {
        report("job-period-inverted", "a job's reporting period does not run forwards; it is left unset", `job ${id}`);
        periodStart = null; periodEnd = null;
      }
      const typeName = v7Job.job_type_id == null ? null : text(types.get(v7Job.job_type_id)?.name);
      const title = text(v7Job.title) ?? typeName ?? text(v7Job.job_type) ?? `v7 job ${jobNumber}`;

      const rows = planRows(v7Job);
      const reports = planReports(v7Job);
      const reconciliation = reconcile(v7Job, rows, reports);
      if (family === "lca" || family === "pcf") report("lca-working-detail-in-v7", "an LCA/PCF job: its frozen result is imported; its working detail stays in v7 (§6.2)", `job ${id}`);
      return {
        jobId: `v7-job-${id}`, legacyId: id, sequence: Number(jobNumber.slice(1)), legacyJobNumber: jobNumber,
        legacyWfmJobNo: text(v7Job.legacy_job_no), family, title, status, workflowStage: statusText,
        reportingYear: within(integer(v7Job.reporting_year), 1900, 2200), startDate: v7Day(v7Job.start_date),
        dueDate: v7Day(v7Job.due_date), periodStart, periodEnd, ownerName: text(v7Job.crm_name),
        createdAt: text(v7Job.created_at), detail: detailFor(family, periodStart, periodEnd), rows, reports, reconciliation,
      };
    }

    function planRows(v7Job: V7Row): PlannedRow[] {
      const jobId = v7Job.job_id!;
      const planned: PlannedRow[] = [];
      const v7Rows = (rowsByJob.get(jobId) ?? []).sort(byNumericId("row_id"));
      const rowIds = new Set(v7Rows.map((row) => row.row_id!));
      const siteFor = (siteId: string | null, what: string): string | null => {
        if (siteId === null) return null;
        if (siteIds.has(siteId)) return `v7-site-${siteId}`;
        report("row-site-missing", "a row's v7 site is not among its client's imported sites; the row carries no site", what);
        return null;
      };
      const datasetOf = (datasetId: string | null): MigratedRecord["dataset"] | undefined => {
        if (datasetId === null) return undefined;
        const dataset = datasets.get(datasetId);
        if (!dataset) report("dataset-missing", "a row's v7 dataset is not in the extract; its year and version are not recorded", `dataset ${datasetId}`);
        const version = text(dataset?.version);
        return { id: datasetId, year: integer(dataset?.year), version: version && /^[A-Za-z0-9 ._-]{1,40}$/.test(version) ? version : null };
      };

      // Evidence: spend entries v7 pushed into 'Spend Data' rows, and commuting sources behind the consolidated rows.
      const spend = (spendByJob.get(jobId) ?? []).filter((entry) => !flag(entry.is_deleted) && entry.factor_db_id !== null
        && text(entry.mapped_scope) !== null && (!flag(entry.submitted_by_portal) || text(entry.review_status) === "approved"));
      const spendKey = (scope: string | null | undefined, originalId: string | null, factorDbId: string | null | undefined, site: string | null | undefined) =>
        `${(scope ?? "").trim()}|${originalId ?? `#${factorDbId}`}|${site ?? "-"}`;
      const spendGroups = new Map<string, V7Row[]>();
      for (const entry of spend) {
        const key = spendKey(entry.mapped_scope, text(entry.factor_original_id), entry.factor_db_id, entry.site_id);
        spendGroups.set(key, [...(spendGroups.get(key) ?? []), entry]);
      }
      const commuting = (sourcesByJob.get(jobId) ?? []).filter((source) => source.source_type === "employee_commuting"
        && flag(source.enabled ?? "t") && source.factor_db_id !== null);
      const commutingGroups = new Map<string, V7Row[]>();
      for (const source of commuting) {
        const key = `${source.site_id ?? "-"}|${source.factor_db_id}`;
        commutingGroups.set(key, [...(commutingGroups.get(key) ?? []), source]);
      }
      const usedSpend = new Set<string>();
      const usedCommuting = new Set<string>();

      for (const v7Row of v7Rows) {
        const rowId = v7Row.row_id!;
        const what = `job ${jobId} row ${rowId}`;
        const scope = scopeDigit(v7Row.scope);
        if (!scope) { refuse("row-scope-unknown", "a v7 row whose scope is not 1, 2 or 3", `${what}: "${v7Row.scope}"`); continue; }
        const rawSource = text(v7Row.data_source) ?? "Company Data";
        if ((CONSOLIDATED_ON_READ as readonly string[]).includes(rawSource)) {
          refuse("row-consolidated-on-read", "a scope row stored with a register's consolidated-on-read source — it would count twice beside its sources (§6.1)", what);
          continue;
        }
        const enabled = flag(v7Row.enabled);
        const months = Array.from({ length: 12 }, (_, month) => v7Row[`month_${month + 1}`] ?? null);
        const figure = scopeRowFigure({
          scope: v7Row.scope, qty: v7Row.qty, uom: v7Row.uom, factor: v7Row.factor, ghgUnit: v7Row.ghg_unit,
          applyPct: v7Row.apply_pct ?? null, months, datasetId: v7Row.dataset_id ?? null, factorDbId: v7Row.factor_db_id ?? null,
          originalId: v7Row.original_id, notes: v7Row.notes ?? null,
          referenceFactor: referenceKnown ? v7Row.reference_factor ?? null : undefined,
          referenceGhgUnit: referenceKnown ? v7Row.reference_ghg_unit ?? null : undefined,
        });
        const flags = new Set<MigratedFlag>(figure.notReplayable);
        const dataSource = (KNOWN_DATA_SOURCES as readonly string[]).includes(rawSource) ? rawSource : "Other";
        if (dataSource === "Other") { flags.add("data-source-unlisted"); report("data-source-unlisted", "a v7 data_source outside the known list, carried as \"Other\"", `"${rawSource}"`); }
        if (V7_SYNTHESISED.includes(dataSource)) flags.add("v7-synthesised");
        if (flag(v7Row.is_custom_entry)) flags.add("v7-custom-entry");
        const stored = pyFloat(v7Row.calc_tco2e ?? null);
        if (stored !== null && Math.abs(stored - figure.tco2e) > 0.001 * Math.max(Math.abs(stored), 1e-9)) {
          flags.add("stored-figure-differs");
          report("row-stored-figure-differs", "v7's stored figure differs from what v7 reported; the reported one is migrated, the stored kept beside it (decision 9)", what);
        }
        for (const reason of figure.notReplayable) report(`row-not-replayable:${reason}`, "a row whose v7 figure turns on a live lookup; its own copied factor is used and the published snapshot stands for it", what);
        const review = reviewOf(v7Row.review_status ?? null, flags);
        const applyPctRaw = pyFloat(v7Row.apply_pct ?? null);
        const applyPct = applyPctRaw === null ? 100 : applyPctRaw;
        if (applyPct < 0 || applyPct > 100) flags.add("apply-pct-out-of-range");
        if (figure.displayQty < 0) flags.add("negative-quantity");

        const evidence: MigratedRecord["evidence"] = {};
        if (dataSource === "Spend Data") {
          const key = spendKey(v7Row.scope, text(v7Row.original_id), v7Row.factor_db_id ?? null, v7Row.site_id ?? null);
          const fallbackKey = spendKey(v7Row.scope, null, v7Row.factor_db_id ?? null, v7Row.site_id ?? null);
          const entries = spendGroups.get(key) ?? spendGroups.get(fallbackKey) ?? [];
          for (const entry of entries) usedSpend.add(entry.entry_id!);
          const amount = entries.reduce((sum, entry) => sum + (pyFloat(entry.amount_gross) ?? 0), 0);
          const currencies = [...new Set(entries.map((entry) => text(entry.conversion_currency) ?? text(entry.currency) ?? "GBP"))]
            .filter((currency) => /^[A-Z]{3}$/.test(currency)).sort();
          evidence.spend = { entry_ids: entries.map((entry) => entry.entry_id!).sort((a, b) => Number(a) - Number(b)), count: entries.length, amount_gross: amount, currencies };
          if (enabled && Math.abs(amount - (pyFloat(v7Row.qty) ?? 0)) > 0.005) {
            report("spend-row-disagrees-with-entries", "a 'Spend Data' row's quantity does not sum its mapped spend entries (§6.1)", what);
          }
        }
        if (rawSource === COMMUTING_CONSOLIDATED || text(v7Row.auto_pair_kind) === "employee_commuting") {
          const sources = commutingGroups.get(`${v7Row.site_id ?? "-"}|${v7Row.factor_db_id ?? ""}`) ?? [];
          for (const source of sources) usedCommuting.add(source.source_id!);
          const totalQty = sources.reduce((sum, source) => sum + (pyFloat(source.qty ?? null) ?? 0), 0);
          const totalCalc = sources.reduce((sum, source) => sum + (pyFloat(source.calc_tco2e ?? null) ?? 0), 0);
          evidence.commuting = { source_ids: sources.map((source) => source.source_id!).sort((a, b) => Number(a) - Number(b)), count: sources.length, total_qty: totalQty, total_calc_tco2e: totalCalc };
          if (enabled && Math.abs(totalQty - (pyFloat(v7Row.qty) ?? 0)) > 0.005) {
            report("commuting-row-disagrees-with-sources", "a consolidated commuting row's quantity does not sum its commuting sources (§6.1)", what);
          }
        }

        const record: MigratedRecord = {
          qty: pyFloat(v7Row.qty), uom: text(v7Row.uom), apply_pct: applyPctRaw, factor: pyFloat(v7Row.factor),
          ghg_unit: text(v7Row.ghg_unit), original_id: text(v7Row.original_id), factor_db_id: text(v7Row.factor_db_id ?? null),
          reported_tco2e: figure.tco2e, stored_calc_tco2e: stored, override_tco2e: pyFloat(v7Row.override_tco2e ?? null),
          data_source: dataSource, data_confidence: confidenceOf(v7Row.data_confidence ?? null), enabled,
          review_status: review.recorded,
        };
        if (months.some((value) => value !== null)) record.months = months.map((value) => pyFloat(value));
        const dataset = datasetOf(v7Row.dataset_id ?? null);
        if (dataset) record.dataset = dataset;
        if (evidence.spend || evidence.commuting) record.evidence = evidence;
        if (flags.size) record.flags = [...flags].sort();

        const reportLabel = text(v7Row.report_label) ?? text(v7Row.column_text) ?? text(v7Row.level_2) ?? text(v7Row.category) ?? "Uncategorised";
        const linked = text(v7Row.linked_row_id ?? null);
        planned.push(finishRow({
          scopeRowId: `v7-row-${rowId}`, legacyDbId: rowId, scope, v7Scope: v7Row.scope ?? "",
          sourceLabel: reportLabel, reportLabel, level1: text(v7Row.level_1) ?? `Scope ${scope}`,
          level2: text(v7Row.level_2) ?? text(v7Row.category) ?? reportLabel, level3: text(v7Row.level_3 ?? null),
          level4: text(v7Row.level_4 ?? null), columnText: text(v7Row.column_text ?? null),
          quantity: figure.displayQty >= 0 ? figure.displayQty : null, unit: text(v7Row.uom),
          datasetId: v7Row.dataset_id ? `v7-dataset-${v7Row.dataset_id}` : null, factorId: text(v7Row.original_id),
          calculatedTco2e: figure.tco2e, reviewStatus: review.console, enabled, applyPct: Math.min(Math.max(applyPct, 0), 100),
          dataConfidence: confidenceOf(v7Row.data_confidence ?? null), siteId: siteFor(v7Row.site_id ?? null, what),
          isAutoGenerated: flag(v7Row.is_auto_generated), autoPairKind: text(v7Row.auto_pair_kind ?? null),
          linkedRowId: linked && rowIds.has(linked) ? `v7-row-${linked}` : null, migratedRecord: record,
          provenance: {}, lineage: [], counted: enabled,
        }, "job_scope_rows", v7Row));
      }

      // Register sources v7 unions in on read: each enabled non-commuting source is a figure, and a migrated row.
      for (const source of (sourcesByJob.get(jobId) ?? []).sort(byNumericId("source_id"))) {
        const sourceId = source.source_id!;
        if (source.source_type === "employee_commuting") {
          if (!usedCommuting.has(sourceId) && flag(source.enabled ?? "t") && source.factor_db_id !== null) {
            report("commuting-source-without-row", "an enabled commuting source with no consolidated row to carry it as evidence", `job ${jobId} source ${sourceId}`);
          }
          continue;
        }
        if (!flag(source.enabled ?? "t")) { exclude("job_emission_sources", sourceId, "register-source-disabled"); continue; }
        const what = `job ${jobId} source ${sourceId}`;
        const scope = scopeDigit(source.scope);
        if (!scope) { refuse("row-scope-unknown", "a v7 row whose scope is not 1, 2 or 3", `${what}: "${source.scope}"`); continue; }
        const groupRow = source.group_id ? groups.get(source.group_id) : undefined;
        if (source.group_id && !groupRow) { refuse("orphaned-record", "a record points at a v7 parent the extract does not hold", `${what} → group ${source.group_id}`); continue; }
        const pick = (column: string) => (groupRow && groupRow[column] !== null && groupRow[column] !== undefined ? groupRow[column]! : source[column] ?? null);
        const factor = pick("factor"); const ghgUnit = pick("ghg_unit"); const uom = pick("uom");
        const originalId = pick("original_id"); const factorDbId = pick("factor_db_id"); const datasetId = pick("dataset_id");
        const tco2e = registerSourceFigure({ qty: source.qty ?? null, factor, ghgUnit, applyPct: source.apply_pct ?? null, calcTco2e: source.calc_tco2e ?? null });
        const family = source.source_type === "business_travel" ? "Business Travel Register" : "Asset Register";
        const rawSource = text(source.data_source) ?? family;
        const flags = new Set<MigratedFlag>(["register-source"]);
        const dataSource = (KNOWN_DATA_SOURCES as readonly string[]).includes(rawSource) ? rawSource : "Other";
        if (dataSource === "Other") { flags.add("data-source-unlisted"); report("data-source-unlisted", "a v7 data_source outside the known list, carried as \"Other\"", `"${rawSource}"`); }
        const review = reviewOf(source.review_status ?? null, flags);
        const qty = pyFloat(source.qty ?? null);
        const applyPctRaw = pyFloat(source.apply_pct ?? null);
        if (qty !== null && qty < 0) flags.add("negative-quantity");
        const token = (value: string | null | undefined) => { const cleaned = text(value)?.toLowerCase() ?? null; return cleaned && /^[a-z0-9_-]{1,40}$/.test(cleaned) ? cleaned : null; };
        const record: MigratedRecord = {
          qty, uom: text(uom), apply_pct: applyPctRaw, factor: pyFloat(factor), ghg_unit: text(ghgUnit), original_id: text(originalId),
          factor_db_id: text(factorDbId), reported_tco2e: tco2e, stored_calc_tco2e: pyFloat(source.calc_tco2e ?? null),
          data_source: dataSource, data_confidence: confidenceOf(source.data_confidence ?? null), enabled: true,
          review_status: review.recorded,
          register: { source_id: sourceId, group_id: text(source.group_id ?? null), source_type: token(source.source_type), source_subtype: token(source.source_subtype) },
          flags: [...flags].sort(),
        };
        const dataset = datasetOf(datasetId);
        if (dataset) record.dataset = dataset;
        const category = text(source.category ?? null);
        const reportLabel = category ?? (family === "Business Travel Register" ? "Business travel" : "Asset register");
        planned.push(finishRow({
          scopeRowId: `v7-source-${sourceId}`, legacyDbId: `source:${sourceId}`, scope, v7Scope: source.scope ?? "",
          sourceLabel: reportLabel, reportLabel, level1: `Scope ${scope}`, level2: family, level3: category, level4: null,
          columnText: null, quantity: qty !== null && qty >= 0 ? qty : null, unit: text(uom),
          datasetId: datasetId ? `v7-dataset-${datasetId}` : null, factorId: text(originalId), calculatedTco2e: tco2e,
          reviewStatus: review.console, enabled: true, applyPct: Math.min(Math.max(applyPctRaw ?? 100, 0), 100),
          dataConfidence: confidenceOf(source.data_confidence ?? null), siteId: siteFor(source.site_id ?? null, what),
          isAutoGenerated: false, autoPairKind: null, linkedRowId: null, migratedRecord: record,
          provenance: {}, lineage: [], counted: true,
        }, "job_emission_sources", source));
      }

      for (const entry of spend) {
        if (!usedSpend.has(entry.entry_id!)) report("spend-entry-without-row", "a mapped spend entry with no 'Spend Data' row to carry it as evidence", `job ${jobId} entry ${entry.entry_id}`);
      }

      // v7's own known double count: a 'Spend Data' row beside another enabled row for the same factor and site.
      const enabledByIdentity = new Map<string, Set<string>>();
      for (const row of planned.filter((candidate) => candidate.enabled && !candidate.legacyDbId.startsWith("source:"))) {
        const key = `${row.scope}|${row.migratedRecord.original_id}|${row.siteId ?? "-"}`;
        enabledByIdentity.set(key, new Set([...(enabledByIdentity.get(key) ?? []), row.migratedRecord.data_source === "Spend Data" ? "spend" : "other"]));
      }
      for (const [key, kinds] of enabledByIdentity) {
        if (kinds.size > 1) report("spend-double-count", "an enabled 'Spend Data' row and another enabled row for the same scope, factor and site — v7's known double count, loaded as v7 left it", `job ${jobId}: ${key}`);
      }

      // The guard, asserted rather than assumed: nothing that is evidence became a figure.
      for (const row of planned) {
        if (row.legacyDbId.startsWith("source:") && row.migratedRecord.register?.source_type === "employee_commuting") {
          refuse("evidence-as-figure", "a commuting source became a migrated figure (§6.1)", row.scopeRowId);
        }
        const problems = migratedRecordProblems(row.migratedRecord);
        for (const problem of problems) refuse("migrated-record-not-closed", "a migrated_record departs from its closed shape (§5.1)", `${row.scopeRowId}: ${problem}`);
      }
      return planned;
    }

    function finishRow(row: PlannedRow, table: "job_scope_rows" | "job_emission_sources", v7Row: V7Row): PlannedRow {
      row.provenance = {
        origin: "migrated", sourceSystem: SOURCE_SYSTEM, sourceTable: table,
        figure: "v7-reported", formula: "v7 report-time arithmetic (decision 9)",
        factor: { v7FactorDbId: row.migratedRecord.factor_db_id ?? null, v7DatasetId: row.migratedRecord.dataset?.id ?? null, originalId: row.migratedRecord.original_id },
        flags: row.migratedRecord.flags ?? [],
      };
      row.lineage = [
        { step: "recorded-in-v7", table, id: table === "job_scope_rows" ? v7Row.row_id : v7Row.source_id },
        { step: "v7-reported-figure", tco2e: row.calculatedTco2e },
      ];
      return row;
    }

    function planReports(v7Job: V7Row): PlannedReport[] {
      const jobId = v7Job.job_id!;
      const review = reviews.get(jobId);
      const portalVersionId = text(review?.portal_version_id);
      const planned: PlannedReport[] = [];
      for (const version of (versionsByJob.get(jobId) ?? []).sort(byNumericId("report_version_id"))) {
        const id = version.report_version_id!;
        const payloadText = version.snapshot_json ?? null;
        const stated = text(version.data_hash)?.toLowerCase() ?? null;
        if (stated !== null && (payloadText === null || sha256Hex(payloadText) !== stated)) {
          refuse("report-hash-mismatch", "a report version whose snapshot does not hash to v7's data_hash — refused, not imported (decision 3)", `report ${id}`);
          continue;
        }
        const isPortalVersion = portalVersionId === id;
        const provider = text(version.storage_provider);
        if ((provider ?? "local") === "local" && !text(version.file_path)) report("report-pdf-no-path", "a report version whose PDF has no stored path; its snapshot and hash come across, its link is absent (§9)", `report ${id}`);
        const particulars: LegacyReportParticulars = {
          versionLabel: text(version.version_label), notes: text(version.notes), generatedBy: text(version.generated_by),
          reviewedBy: text(version.reviewed_by), finalizedBy: text(version.finalized_by), supersededBy: text(version.superseded_by),
          fileName: text(version.file_name), filePath: text(version.file_path), externalItemId: text(version.external_item_id),
          externalWebUrl: text(version.external_web_url), externalPath: text(version.external_path),
        };
        if (isPortalVersion) {
          Object.assign(particulars, {
            approvedByName: text(review?.approved_by_name), approvedByEmail: text(review?.approved_by_email),
            reviewStatus: text(review?.status), publishedAt: text(review?.published_at), publishedBy: text(review?.published_by),
          });
        }
        const versionNumber = integer(version.version_number);
        if (versionNumber === null || versionNumber < 1) { refuse("report-version-unnumbered", "a report version with no version number", `report ${id}`); continue; }
        planned.push({
          legacyReportId: `v7-report-${id}`, legacyDbId: id, kind: "report", versionNumber,
          legacyStatus: text(version.status) ?? "draft", reportFormat: text(version.report_format), isPortalVersion,
          storageProvider: provider, generatedAt: text(version.generated_at), reviewedAt: text(version.reviewed_at),
          finalizedAt: text(version.finalized_at), supersededAt: text(version.superseded_at),
          payloadText, v7DataHash: stated, particulars,
        });
      }
      if (portalVersionId && !planned.some((candidate) => candidate.legacyDbId === portalVersionId)) {
        report("portal-version-missing", "report_reviews names a portal version that is not among the job's imported versions", `job ${jobId}`);
      }
      for (const assessment of (lcaByJob.get(jobId) ?? []).sort(byNumericId("assessment_id"))) {
        const id = assessment.assessment_id!;
        const frozen = ["verified", "published"].includes(text(assessment.review_status) ?? "") && assessment.resolved_lines_snapshot != null;
        if (!frozen) { exclude("lca_assessments", id, "lca-not-frozen"); continue; }
        planned.push({
          legacyReportId: `v7-lca-${id}`, legacyDbId: id, kind: "lca-result", versionNumber: null,
          legacyStatus: text(assessment.review_status)!, reportFormat: null, isPortalVersion: false, storageProvider: null,
          generatedAt: null, reviewedAt: null, finalizedAt: null, supersededAt: null,
          payloadText: assessment.resolved_lines_snapshot ?? null, v7DataHash: null,
          particulars: { totalTco2e: pyFloat(assessment.total_tco2e ?? null) },
        });
      }
      return planned;
    }

    function reconcile(v7Job: V7Row, rows: PlannedRow[], planned: PlannedReport[]): Reconciliation {
      const migrated = scopeTotals(rows.filter((row) => row.counted).map((row) => ({ scope: row.v7Scope, tco2e: row.calculatedTco2e })));
      const published = planned.find((candidate) => candidate.kind === "report" && candidate.isPortalVersion) ?? null;
      if (!published) {
        if (rows.some((row) => row.counted)) report("job-unpublished", "a job with figures and no portal version: its migrated row sum is its historical figure, marked unpublished (decision 2)", `job ${v7Job.job_id}`);
        return { published: null, migrated, snapshot: null, differences: [] };
      }
      if (published.legacyStatus.toLowerCase() !== "final") {
        report("published-version-not-final", "the portal version is not 'final'; it is the published report (decision 11), and its status is kept verbatim", `job ${v7Job.job_id} report ${published.legacyDbId}: "${published.legacyStatus}"`);
      }
      let snapshot: Reconciliation["snapshot"] = null;
      try {
        const parsed = JSON.parse(published.payloadText ?? "null") as { scope_totals?: Record<string, unknown> } | null;
        const totals = parsed?.scope_totals;
        if (totals && typeof totals === "object") {
          snapshot = {};
          for (const key of ["Scope 1", "Scope 2", "Scope 3", "Total"] as const) {
            const value = pyFloat(typeof totals[key] === "number" ? totals[key] as number : typeof totals[key] === "string" ? totals[key] as string : null);
            if (value !== null) snapshot[key] = value;
          }
        }
      } catch { snapshot = null; }
      const differences: string[] = [];
      if (!snapshot) {
        report("published-snapshot-without-totals", "the published snapshot has no readable scope_totals to reconcile against", `job ${v7Job.job_id} report ${published.legacyDbId}`);
        return { published: { legacyReportId: published.legacyReportId, status: published.legacyStatus }, migrated, snapshot: null, differences };
      }
      for (const key of ["Scope 1", "Scope 2", "Scope 3", "Total"] as const) {
        const shown = snapshot[key];
        if (shown === undefined) continue;
        if (Math.abs(shown - migrated[key]) > 1e-9) differences.push(`${key}: published ${shown}, migrated ${migrated[key]}`);
      }
      if (differences.length) report("reconciliation-difference", "a job whose migrated figures differ from its published snapshot — reported, never corrected (decision 2)", `job ${v7Job.job_id}: ${differences.join("; ")}`);
      return { published: { legacyReportId: published.legacyReportId, status: published.legacyStatus }, migrated, snapshot, differences };
    }
  }

  const jobs = clients.flatMap((client) => client.jobs);
  const rows = jobs.flatMap((job) => job.rows);
  const reportCount = jobs.flatMap((job) => job.reports);
  return {
    organisationId, extractSha256: input.extractSha256, clients,
    refusals: [...refusals.values()], exclusions: [...exclusions.values()], reports: [...reports.values()], excluded,
    summary: {
      clients: clients.length, portfolioOwners, sites: clients.reduce((n, c) => n + c.sites.length, 0),
      contacts: clients.reduce((n, c) => n + c.contacts.length, 0), jobs: jobs.length, rows: rows.length,
      rowsEnabled: rows.filter((row) => row.enabled).length, registerRows: rows.filter((row) => row.legacyDbId.startsWith("source:")).length,
      reports: reportCount.filter((entry) => entry.kind === "report").length, lcaResults: reportCount.filter((entry) => entry.kind === "lca-result").length,
      jobsPublished: jobs.filter((job) => job.reconciliation.published).length,
      jobsReconciled: jobs.filter((job) => job.reconciliation.snapshot && job.reconciliation.differences.length === 0).length,
      jobsWithDifferences: jobs.filter((job) => job.reconciliation.differences.length > 0).length, maxSequence,
      portfolioOwnersLinked: clients.filter((client) => client.portfolioOwnership).length,
    },
  };
}

// ── Field mapping ───────────────────────────────────────────────────────────────────────────────────────────

function reviewOf(value: string | null, flags: Set<MigratedFlag>): { console: PlannedRow["reviewStatus"]; recorded: string | null } {
  const cleaned = text(value)?.toLowerCase() ?? null;
  if (cleaned === null) return { console: "pending", recorded: null };
  if ((REVIEW_STATUSES as readonly string[]).includes(cleaned)) {
    return { console: cleaned === "approved" ? "approved" : cleaned === "rejected" ? "rejected" : "pending", recorded: cleaned };
  }
  flags.add("review-status-unlisted");
  return { console: "pending", recorded: "other" };
}

const confidenceOf = (value: string | null): "H" | "M" | "L" | null => {
  const cleaned = text(value)?.toUpperCase().slice(0, 1) ?? null;
  return cleaned === "H" || cleaned === "M" || cleaned === "L" ? cleaned : null;
};

/** The family's detail shape, exactly as `createJob` writes it, so every reader of `detail_json` sees a known kind. */
function detailFor(family: PlannedJob["family"], periodStart: string | null, periodEnd: string | null): Record<string, unknown> {
  switch (family) {
    case "crp": return { kind: "crp", reportingPeriod: periodStart && periodEnd ? `${periodStart}–${periodEnd}` : "", includedScopes: [], reviewedRows: 0, totalRows: 0 };
    case "consultancy": return { kind: "consultancy", scope: "", deliverables: [], plannedDays: 0, usedDays: 0 };
    case "lca": return { kind: "lca", assessment: "", boundary: "", bomLines: 0, scenarios: 0 };
    case "pcf": return { kind: "pcf", product: "", functionalUnit: "", bomLines: 0, readinessPct: 0 };
    case "training": return { kind: "training", course: "", sessions: 0, bookings: 0, attendancePct: 0 };
  }
}

type Report = (code: string, message: string, example: string) => void;

function clientFields(v7: V7Row, id: string, report: Report): PlannedClient["fields"] {
  const currency = text(v7.currency)?.toUpperCase() ?? null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) report("client-currency-unreadable", "a client currency that is not a three-letter code; GBP is used", `client ${id}`);
  const yearEnd = text(v7.year_end_month);
  const fyMonth = monthOf(yearEnd);
  if (yearEnd && fyMonth === null) report("client-year-end-unreadable", "a client year-end month that is not a month; left unset", `client ${id}`);
  const netZero = integer(v7.net_zero_year);
  const interimYear = integer(v7.interim_year);
  const checkedYear = (value: number | null, what: string) => {
    if (value !== null && within(value, 2020, 2100) === null) { report("client-target-out-of-range", "a v7 target value outside the console's range; left unset", `client ${id} ${what}`); return null; }
    return value;
  };
  const pct = (value: string | null | undefined, what: string) => {
    const parsed = pyFloat(value ?? null);
    if (parsed !== null && within(parsed, 0, 100) === null) { report("client-target-out-of-range", "a v7 target value outside the console's range; left unset", `client ${id} ${what}`); return null; }
    return parsed;
  };
  const tonnes = (value: string | null | undefined, what: string) => {
    const parsed = pyFloat(value ?? null);
    if (parsed !== null && parsed < 0) { report("client-baseline-negative", "a negative v7 baseline figure; left unset", `client ${id} ${what}`); return null; }
    return parsed;
  };
  let periodStart = v7Day(v7.benchmark_period_start);
  let periodEnd = v7Day(v7.benchmark_period_end);
  if (periodStart && periodEnd && periodEnd <= periodStart) {
    report("client-baseline-period-inverted", "a v7 baseline period that does not run forwards; left unset", `client ${id}`);
    periodStart = null; periodEnd = null;
  }
  if (netZero === 2050 && interimYear === 2035 && [v7.interim_s1_pct, v7.interim_s2_pct, v7.interim_s3_pct].every((value) => pyFloat(value ?? null) === 50)) {
    report("client-targets-at-v7-defaults", "a client whose targets equal v7's column defaults (2050 / 2035 / 50%) — imported as v7 held them, indistinguishable from targets set on purpose", `client ${id}`);
  }
  return {
    name: text(v7.client_name)!, status: "active", sector: text(v7.industry), website: text(v7.website),
    companyRegistration: text(v7.company_reg), headquarters: text(v7.headquarters), financialYearEndMonth: fyMonth,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : "GBP", companyDescription: text(v7.description_long),
    portfolio: text(v7.portfolio), referral: text(v7.referral), ownerName: text(v7.crm_owner), clientManager: text(v7.client_manager),
    registeredAddressLine1: text(v7.addr_line1), registeredAddressLine2: text(v7.addr_line2), registeredCity: text(v7.addr_city),
    registeredRegion: text(v7.addr_region), registeredPostcode: text(v7.addr_postcode), registeredCountry: text(v7.addr_country),
    netZeroTargetYear: checkedYear(netZero, "net_zero_year"),
    interim: {
      year: checkedYear(interimYear, "interim_year"),
      scope1Pct: pct(v7.interim_s1_pct, "interim_s1_pct"), scope2Pct: pct(v7.interim_s2_pct, "interim_s2_pct"), scope3Pct: pct(v7.interim_s3_pct, "interim_s3_pct"),
    },
    baseline: {
      periodStart, periodEnd, scope1: tonnes(v7.benchmark_scope_1_tco2e, "benchmark_scope_1_tco2e"),
      scope2: tonnes(v7.benchmark_scope_2_tco2e, "benchmark_scope_2_tco2e"), scope3: tonnes(v7.benchmark_scope_3_tco2e, "benchmark_scope_3_tco2e"),
      total: tonnes(v7.benchmark_total_tco2e, "benchmark_total_tco2e"),
    },
  };
}

function clientTarget(v7: V7Row, id: string, report: Report): PlannedTarget | null {
  const benchmarkYear = integer(v7.benchmark_year);
  const benchmarkTotal = pyFloat(v7.benchmark_total_tco2e ?? null);
  if (benchmarkYear === null || benchmarkTotal === null) return null;
  if (within(benchmarkYear, 2000, 2100) === null || benchmarkTotal < 0) {
    report("client-target-unrecordable", "a v7 benchmark the console's target record cannot hold; no target version is written", `client ${id}`);
    return null;
  }
  const scopeTarget = (yearColumn: string, pctColumn: string) => {
    const year = integer(v7[yearColumn]);
    const pct = pyFloat(v7[pctColumn] ?? null);
    if (year === null && pct === null) return null;
    if (year === null || pct === null || year <= benchmarkYear || within(year, 2000, 2100) === null || within(pct, 0, 100) === null) {
      report("client-target-unrecordable", "a v7 per-scope target the console's target record cannot hold; that scope is left unset", `client ${id} ${yearColumn}`);
      return null;
    }
    return { year, pct };
  };
  const nonNegative = (value: string | null | undefined) => { const parsed = pyFloat(value ?? null); return parsed !== null && parsed >= 0 ? parsed : null; };
  return {
    benchmarkYear, benchmarkTotal,
    benchmarkScope1: nonNegative(v7.benchmark_scope_1_tco2e), benchmarkScope2: nonNegative(v7.benchmark_scope_2_tco2e), benchmarkScope3: nonNegative(v7.benchmark_scope_3_tco2e),
    scope1: scopeTarget("target_s1_year", "target_s1_pct"), scope2: scopeTarget("target_s2_year", "target_s2_pct"), scope3: scopeTarget("target_s3_year", "target_s3_pct"),
  };
}

/** The contract's column lists, re-exported for the extract documentation test. */
export const CONTRACT = EXTRACT_CONTRACT;
