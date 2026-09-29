import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACT_CONTRACT, V7_TABLES, type V7Row, type V7Table } from "../../src/v7ClientExtract";

/**
 * A synthetic v7 extract, shaped like live v7's (docs/CLIENT_JOB_IMPORT_DESIGN.md Appendix B) and holding no real
 * data. Every name, address and figure is invented.
 *
 * Built to exercise each rule the import carries: decision 8's scope, the family rule (a type flagged `is_crp` that is
 * training by name), decision 9's arithmetic and its quirks, the §6.1 double-count guard (spend entries, commuting
 * sources, a grouped business-travel source, a disabled source), decision 11 (a portal version that is not final) and
 * the per-job reconciliation — one job that reconciles to its published snapshot exactly, one that does not.
 *
 * **Sentinels.** Every free-text or personal column v7 has that must *not* reach `migrated_record` carries one of
 * `SENTINELS`, so the depth test can prove none of them surfaced anywhere in it.
 */

export const SENTINELS = ["ZZSENTINEL", "sentinel@example.invalid"] as const;
const PERSON = "ZZSENTINEL Person";
const EMAIL = "sentinel@example.invalid";

type Rows = Record<V7Table, Array<Record<string, string | null>>>;

const snapshot = (totals: Record<string, number>, preparedBy: string) =>
  JSON.stringify({ generation_date: "2024-03-01", prepared_by: preparedBy, renderer: "react", scope_totals: totals,
    note: "Sïnthetic — “quoted”, a comma, and a\nnewline, so the CSV round trip is proved byte for byte" });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const months = (value: string | null) => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`month_${index + 1}`, value]));

/** Job 100's published totals, worked by hand from the rows below — not by the port under test. */
export const JOB_100_PUBLISHED = { "Scope 1": 4.5, "Scope 2": 2.4, "Scope 3": 14.18, Total: 21.08 };

export function syntheticRows(): Rows {
  const published100 = snapshot(JOB_100_PUBLISHED, "Ada Example");
  const superseded100 = snapshot({ "Scope 1": 4, "Scope 2": 2, "Scope 3": 14, Total: 20 }, "Ada Example");
  const portal106 = snapshot({ "Scope 1": 1.5, "Scope 2": 0, "Scope 3": 0, Total: 1.5 }, "Ada Example");
  return {
    clients: [
      { db_id: "1", client_name: "Synthetic Alpha Ltd", status: "Active", archived: "f", industry: "Manufacturing",
        year_end_month: "March", currency: "GBP", crm_owner: "Casey Owner", portfolio: "beta PORTFOLIO", client_manager: "Morgan Manager",
        addr_line1: "1 Example Street", addr_city: "Exampleton", addr_postcode: "EX1 1AA", addr_country: "United Kingdom",
        net_zero_year: "2045", interim_year: "2030", interim_s1_pct: "42", interim_s2_pct: "42", interim_s3_pct: "25",
        target_s1_year: "2030", target_s1_pct: "50", benchmark_year: "2019", benchmark_period_start: "2019-01-01",
        benchmark_period_end: "2019-12-31", benchmark_scope_1_tco2e: "10", benchmark_scope_2_tco2e: "5",
        benchmark_scope_3_tco2e: "30", benchmark_total_tco2e: "45" },
      { db_id: "2", client_name: "Synthetic Beta Group", status: "Portfolio Owner", archived: "f", currency: "EUR",
        net_zero_year: "2050", interim_year: "2035", interim_s1_pct: "50", interim_s2_pct: "50", interim_s3_pct: "50" },
      { db_id: "3", client_name: "Synthetic Prospect", status: "Prospect", archived: "f" },
      { db_id: "4", client_name: "Synthetic Archived", status: "Active", archived: "t" },
    ],
    client_sites: [
      { site_id: "11", client_db_id: "1", site_name: "Head Office", location: "1 Example Street, Exampleton", is_registered_office: "t", archived: "f" },
      { site_id: "12", client_db_id: "1", site_name: "Depot", location: "Unit 2, Example Park", is_registered_office: "t", vacated_date: "2022-06-30", archived: "f" },
      { site_id: "13", client_db_id: "1", site_name: "head office", location: null, is_registered_office: "f", archived: "f" },
      { site_id: "31", client_db_id: "3", site_name: "Prospect Site" },
    ],
    client_contacts: [
      { contact_id: "21", client_db_id: "1", full_name: "Ada Example", job_title: "Sustainability Lead", email: "ada@example.invalid", phone: "+44 0000 000001", is_primary: "t" },
      { contact_id: "22", client_db_id: "1", full_name: "Bo Example", job_title: "Finance", email: "bo@example.invalid", phone: null, is_primary: "t" },
      { contact_id: "23", client_db_id: "1", full_name: "  ", email: "nobody@example.invalid", is_primary: "f" },
      { contact_id: "24", client_db_id: "2", full_name: "Cy Example", email: null, is_primary: "f" },
    ],
    job_types: [
      { job_type_id: "1", name: "Carbon Reduction Plan", job_family: "crp", is_crp: "t" },
      { job_type_id: "2", name: "Consultancy - Strategy Workshop", job_family: null, is_crp: "f" },
      { job_type_id: "3", name: "Life Cycle Assessment", job_family: "", is_crp: "f" },
      // Flagged is_crp, and training by name: is_crp does not track the name, so it is never the rule (§1.1).
      { job_type_id: "4", name: "Training Course", job_family: null, is_crp: "t" },
      { job_type_id: "5", name: "Footprint Service", job_family: null, job_group: "pcf", is_crp: "f" },
    ],
    jobs: [
      { job_id: "100", client_db_id: "1", job_type_id: "1", job_number: "J000612", title: "CRP 2023", status: "Completed", archived: "f",
        reporting_year: "2023", legacy_job_no: "WFM-4411", crm_name: "Casey Owner", start_date: "2024-01-05", due_date: "2024-03-01", created_at: "2024-01-05 09:00:00" },
      { job_id: "101", client_db_id: "1", job_type_id: "2", job_number: "J000613", title: null, status: "Open", archived: "f" },
      { job_id: "102", client_db_id: "2", job_type_id: "3", job_number: "J000614", title: "LCA — Widget", status: "Reporting Phase", archived: "f" },
      { job_id: "103", client_db_id: "2", job_type_id: "4", job_number: "J000615", title: "Carbon literacy", status: "Open", archived: "t" },
      { job_id: "104", client_db_id: null, job_type_id: "4", job_number: "J000700", title: "Open course", status: "Open", archived: "f" },
      { job_id: "105", client_db_id: "3", job_type_id: "1", job_number: "J000701", title: "Prospect CRP", status: "Open", archived: "f" },
      { job_id: "106", client_db_id: "1", job_type_id: "1", job_number: "J000616", title: "CRP 2024", status: "Reporting Phase", archived: "f",
        reporting_period_start: "2024-01-01", reporting_period_end: "2024-12-31" },
      { job_id: "107", client_db_id: "2", job_type_id: "5", job_number: "J000617", title: "Product footprint", status: "Open", archived: "f" },
    ],
    crp_job_details: [{ job_id: "100", reporting_period_from: "2023-01-01", reporting_period_to: "2023-12-31" }],
    datasets: [{ dataset_id: "7", year: "2023", version: "v1" }],
    job_scope_rows: [
      // Scope 1 gas, annual: 10,000 kWh × 0.18 kgCO2e = 1.8 t.
      { row_id: "1000", job_id: "100", scope: "Scope 1", original_id: "7_400_4000_5_1", qty: "10000", uom: "kWh", factor: "0.18",
        ghg_unit: "kgCO2e", enabled: "t", site_id: "11", dataset_id: "7", factor_db_id: "551", level_1: "Fuels", level_2: "Gaseous fuels",
        report_label: "Natural gas", apply_pct: "100", calc_tco2e: "1.8", data_source: "Company Data", data_confidence: "H", review_status: "approved" },
      // Scope 2 electricity, monthly: 12 × 1,000 kWh × 0.2 = 2.4 t (months, not qty, drive it).
      { row_id: "1001", job_id: "100", scope: "Scope 2", original_id: "7_410_4100_1_1", qty: "99999", uom: "kWh", factor: "0.2",
        ghg_unit: "kgCO2e", enabled: "t", site_id: "11", dataset_id: "7", factor_db_id: "555", level_1: "UK electricity",
        level_2: "Electricity generated", report_label: "Electricity", calc_tco2e: "2.4", data_source: "Company Data", ...months("1000") },
      // Spend Data: £5,000 × 0.3 kgCO2e/£ = 1.5 t. Stored 1,500 — v7's historic 1000× bug (decision 9 reports it).
      { row_id: "1002", job_id: "100", scope: "Scope 3", original_id: "SPEND-SIC-49.3-5-u", qty: "5000", uom: "GBP", factor: "0.3",
        ghg_unit: "kgCO2e", enabled: "t", site_id: "11", dataset_id: "7", factor_db_id: "560", level_1: "Spend", level_2: "Land transport",
        report_label: "Land transport (spend)", calc_tco2e: "1500", data_source: "Spend Data", data_confidence: "L" },
      // WFM Import: a synthesised total, tCO2e as quantity with factor 1 — v7's fallback path; 12.5 t. Override ignored.
      { row_id: "1003", job_id: "100", scope: "Scope 3", original_id: "wfm-import-scope-3", qty: "12.5", uom: "tCO2e", factor: "1",
        ghg_unit: "tCO2e", enabled: "t", level_1: "Historical", level_2: "WFM total", report_label: "Scope 3 (WFM)",
        notes: `storage_reason=wfm_total; imported by ${PERSON}`, calc_tco2e: "12.5", override_tco2e: "12.5",
        override_reason: `Set by ${PERSON}`, data_source: "WFM Import" },
      // Disabled: carried, never counted.
      { row_id: "1004", job_id: "100", scope: "Scope 1", original_id: "7_400_4001_5_1", qty: "5000", uom: "litres", factor: "2.5",
        ghg_unit: "kgCO2e", enabled: "f", level_1: "Fuels", level_2: "Liquid fuels", report_label: "Diesel", data_source: "Company Data" },
      // Consolidated commuting: 300 km × 0.1 = 0.03 t; its notes name employees (v7 writes them there).
      { row_id: "1005", job_id: "100", scope: "Scope 3", original_id: "7_430_4300_2_1", qty: "300", uom: "km", factor: "0.1",
        ghg_unit: "kgCO2e", enabled: "t", site_id: "11", factor_db_id: "570", dataset_id: "7", level_1: "Business travel- land",
        level_2: "Cars (by size)", report_label: "Employee commuting", notes: `Employees: ${PERSON}, ${EMAIL}`,
        data_source: "Employee Commuting (Consolidated)", auto_pair_kind: "employee_commuting", is_auto_generated: "t" },
      // apply_pct 0 reads as 100 in v7: 100 × 1 kg = 0.1 t.
      { row_id: "1006", job_id: "100", scope: "Scope 1", original_id: "7_400_4002_5_1", qty: "100", uom: "kg", factor: "1",
        ghg_unit: "kgCO2e", enabled: "t", apply_pct: "0", level_1: "Refrigerant", level_2: "Kyoto", report_label: "Refrigerant", data_source: "Company Data" },
      // An override v7 never reads: the figure is 50 × 2 kg = 0.1 t, not 99.
      { row_id: "1007", job_id: "100", scope: "Scope 1", original_id: "7_400_4003_5_1", qty: "50", uom: "kg", factor: "2",
        ghg_unit: "kgCO2e", enabled: "t", override_tco2e: "99", override_reason: `Per ${EMAIL}`, notes: `Checked with ${PERSON}`,
        level_1: "Process", level_2: "Other", report_label: "Process emissions", data_source: "Company Data" },
      // Job 106: 1,000 kg × 1 = 1.0 t, against a published snapshot that says 1.5.
      { row_id: "1100", job_id: "106", scope: "Scope 1", original_id: "7_400_4000_5_1", qty: "1000", uom: "kg", factor: "1",
        ghg_unit: "kgCO2e", enabled: "t", level_1: "Fuels", level_2: "Gaseous fuels", report_label: "Natural gas", data_source: "Company Data" },
    ],
    job_emission_groups: [
      { group_id: "900", job_id: "100", factor: "0.15", ghg_unit: "kgCO2e", uom: "km", original_id: "7_440_4400_1_1", factor_db_id: "580", dataset_id: "7", enabled: "t" },
    ],
    job_emission_sources: [
      // Asset: stored calc_tco2e is what v7 reports (2.5 t). Its free text names people and a vehicle.
      { source_id: "5001", job_id: "100", scope: "Scope 1", source_type: "asset", source_subtype: "vehicle", enabled: "t", site_id: "11",
        category: "Company vehicles", qty: "1000", uom: "litres", factor: "2.5", ghg_unit: "kgCO2e", calc_tco2e: "2.5",
        source_name: `Van driven by ${PERSON}`, employee_name: PERSON, notes: `Logbook from ${EMAIL}`,
        detail_json: JSON.stringify({ driver: PERSON, email: EMAIL, registration: "ZZSENTINEL-REG" }), data_source: "Source Register" },
      // Business travel, grouped: the group's factor wins (COALESCE(g.factor, js.factor)); calc NULL → 1,000 × 0.15 kg = 0.15 t.
      { source_id: "5002", job_id: "100", group_id: "900", scope: "Scope 3", source_type: "business_travel", enabled: "t",
        category: "Rail", qty: "1000", factor: "9", ghg_unit: "kgCO2e", calc_tco2e: null, employee_name: PERSON, source_name: `Trip by ${PERSON}` },
      // Disabled asset: not a figure — excluded.
      { source_id: "5003", job_id: "100", scope: "Scope 1", source_type: "asset", enabled: "f", qty: "10", factor: "1", ghg_unit: "kgCO2e" },
      // Commuting: evidence on row 1005, never a figure.
      { source_id: "4001", job_id: "100", scope: "Scope 3", source_type: "employee_commuting", enabled: "t", site_id: "11",
        factor_db_id: "570", qty: "100", factor: "0.1", ghg_unit: "kgCO2e", calc_tco2e: "0.01", employee_name: PERSON },
      { source_id: "4002", job_id: "100", scope: "Scope 3", source_type: "employee_commuting", enabled: "t", site_id: "11",
        factor_db_id: "570", qty: "200", factor: "0.1", ghg_unit: "kgCO2e", calc_tco2e: "0.02", employee_name: `${PERSON} Two` },
    ],
    job_spend_entries: [
      { entry_id: "3001", job_id: "100", amount_gross: "3000", is_deleted: "f", site_id: "11", factor_db_id: "560",
        factor_original_id: "SPEND-SIC-49.3-5-u", mapped_scope: "Scope 3", conversion_currency: "GBP", submitted_by_portal: "f",
        spend_description: `Taxi for ${PERSON}`, notes: EMAIL },
      { entry_id: "3002", job_id: "100", amount_gross: "2000", is_deleted: "f", site_id: "11", factor_db_id: "560",
        factor_original_id: "SPEND-SIC-49.3-5-u", mapped_scope: "Scope 3", conversion_currency: "GBP", submitted_by_portal: "f", spend_description: "Couriers" },
      { entry_id: "3003", job_id: "100", amount_gross: "999", is_deleted: "t", site_id: "11", factor_db_id: "560",
        factor_original_id: "SPEND-SIC-49.3-5-u", mapped_scope: "Scope 3", spend_description: "Deleted line" },
    ],
    lca_assessments: [
      { assessment_id: "8001", job_id: "102", review_status: "verified", total_tco2e: "1.2",
        resolved_lines_snapshot: JSON.stringify({ lines: [{ material: "steel", tco2e: 1.2 }], verified_by: PERSON }) },
      { assessment_id: "8002", job_id: "102", review_status: "draft", total_tco2e: "0", resolved_lines_snapshot: null },
    ],
    job_report_versions: [
      { report_version_id: "7000", job_id: "100", version_number: "1", status: "superseded", report_format: "react",
        snapshot_json: superseded100, data_hash: sha(superseded100), storage_provider: "onedrive",
        external_web_url: "https://example.invalid/personal/ada_example/r1.pdf", generated_by: "ada@example.invalid", generated_at: "2024-02-01 10:00:00" },
      { report_version_id: "7001", job_id: "100", version_number: "2", status: "final", report_format: "react",
        snapshot_json: published100, data_hash: sha(published100), storage_provider: "local", file_path: "reports/100/v2.pdf",
        generated_by: "ada@example.invalid", finalized_by: "bo@example.invalid", finalized_at: "2024-03-01 12:00:00", notes: `Signed off by ${PERSON}` },
      { report_version_id: "7010", job_id: "106", version_number: "1", status: "review", report_format: "pdf",
        snapshot_json: portal106, data_hash: sha(portal106), storage_provider: "local", file_path: null },
    ],
    report_reviews: [
      { job_id: "100", portal_version_id: "7001", status: "approved", approved_by_name: "Bo Example", approved_by_email: "bo@example.invalid" },
      { job_id: "106", portal_version_id: "7010", status: "sent_for_review" },
    ],
    // v7's owner→portfolio links: client 2 (Portfolio Owner) owns "Beta Portfolio", of which client 1 is a member
    // (matched case-insensitively, as v7 does); an inactive link and one owned by an out-of-scope client are not carried.
    portfolios_lookup: [
      { portfolio_id: "1", name: "Beta Portfolio", portfolio_owner_client_db_id: "2", is_active: "t" },
      { portfolio_id: "2", name: "Prospect Group", portfolio_owner_client_db_id: "3", is_active: "t" },
      { portfolio_id: "3", name: "Old Beta", portfolio_owner_client_db_id: "2", is_active: "f" },
      { portfolio_id: "4", name: "Unowned", portfolio_owner_client_db_id: null, is_active: "t" },
    ],
    // v7's job plans (PR 2). The client import does not read them; the milestone backfill does. Job 101 carries the
    // dirty case (ruled A2): a first draft "completed by" someone with no completion time.
    job_plan: [
      { job_id: "100", data_collection_due: "2023-03-01", first_draft_due: "2023-06-01", final_report_due: "2023-09-01",
        data_collection_completed_at: "2023-02-27 09:00:00", data_collection_completed_by: "Ada Example",
        first_draft_completed_at: "2023-05-30 16:30:00.25", first_draft_completed_by: "Ada Example",
        final_report_completed_at: "2023-09-01 12:00:00", final_report_completed_by: "Ada Example" },
      { job_id: "101", data_collection_due: "2026-09-20", first_draft_due: "2026-11-01", final_report_due: null,
        data_collection_completed_at: null, first_draft_completed_at: null, first_draft_completed_by: "Ada Example", final_report_completed_at: null },
      { job_id: "103", data_collection_due: null, first_draft_due: null, final_report_due: "2025-01-01",
        data_collection_completed_at: null, first_draft_completed_at: null, final_report_completed_at: null },
    ],
    // v7's admin lookups (admin A3). A label differing from a seeded one only in case and spacing, an inactive value, and
    // the three tables that carry a sort order.
    industries_lookup: [
      { industry_id: "1", name: "Manufacturing", is_active: "t" },
      { industry_id: "2", name: " retail ", is_active: "t" },
      { industry_id: "3", name: "Mining", is_active: "f" },
    ],
    referrals_lookup: [{ referral_id: "1", name: "Existing client", is_active: "t" }],
    payment_terms_lookup: [{ term_id: "1", name: "30 days", is_active: "t" }, { term_id: "2", name: "60 days", is_active: "t" }],
    positions_lookup: [{ position_id: "1", name: "Consultant", is_active: "t" }],
    processes_lookup: [{ process_id: "1", name: "Client Onboarding", is_active: "t" }],
    client_teams_lookup: [{ client_team_id: "1", name: "Sustainability", is_active: "t" }],
    action_categories_lookup: [{ category_id: "1", name: "Governance", is_active: "t" }],
    governance_subjects_lookup: [{ governance_subject_id: "1", name: "Board", is_active: "t" }],
    bd_bin_reasons_lookup: [{ bin_reason_id: "1", name: "No budget", is_active: "t", sort_order: "10" }],
    uom_lookup: [{ uom_id: "1", name: "Hour", is_active: "t", sort_order: "20" }, { uom_id: "2", name: "Day", is_active: "t", sort_order: "10" }],
    job_item_categories_lookup: [{ category_id: "1", name: "Consultancy", is_active: "t", sort_order: "10" }, { category_id: "2", name: "Disbursements", is_active: "f", sort_order: "50" }],
  };
}

/** Every contract column present, absent keys as NULL — what `\copy (SELECT <contract columns> …)` writes. */
export function syntheticExtract(rows: Rows = syntheticRows()): Record<V7Table, V7Row[]> {
  return Object.fromEntries(V7_TABLES.map((table) => {
    const columns = [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional] as string[];
    return [table, rows[table].map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))];
  })) as Record<V7Table, V7Row[]>;
}

export const syntheticHeaders = (): Record<V7Table, string[]> =>
  Object.fromEntries(V7_TABLES.map((table) => [table, [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional]])) as Record<V7Table, string[]>;

const csvCell = (value: string | null) => (value === null ? "" : `"${value.replace(/"/g, "\"\"")}"`);

/** Written as `COPY … CSV HEADER` would: NULL unquoted-empty, every value quoted. Returns the manifest's hash. */
/**
 * v7's own client Risk as the extract derives it beside `job_plan` (the parity file, PR 2), on a fixed operating day:
 * both in-scope clients are Overdue — client 1 by job 101's data collection, client 2 by archived job 103's report.
 */
export const SYNTHETIC_OPERATING_DAY = "2026-09-29";
export const syntheticParity = (): Array<Record<string, string>> => [
  { client_db_id: "1", operating_day: SYNTHETIC_OPERATING_DAY, v7_milestone_status: "red" },
  { client_db_id: "2", operating_day: SYNTHETIC_OPERATING_DAY, v7_milestone_status: "red" },
];

export function writeSyntheticExtract(directory: string, rows: Rows = syntheticRows(), parity = syntheticParity()): string {
  mkdirSync(directory, { recursive: true });
  const extract = syntheticExtract(rows);
  const headers = syntheticHeaders();
  const manifest: { extractedAt: string; tables: Record<string, { file: string; rows: number; sha256: string }>; derived?: Record<string, { file: string; rows: number; sha256: string }> } = { extractedAt: "synthetic", tables: {} };
  const parityHeader = ["client_db_id", "operating_day", "v7_milestone_status"];
  const parityBody = [parityHeader.join(","), ...parity.map((row) => parityHeader.map((column) => csvCell(row[column] ?? null)).join(","))].join("\n") + "\n";
  writeFileSync(join(directory, "v7_client_risk.csv"), parityBody, "utf8");
  manifest.derived = { v7_client_risk: { file: "v7_client_risk.csv", rows: parity.length, sha256: createHash("sha256").update(parityBody, "utf8").digest("hex") } };
  for (const table of V7_TABLES) {
    const body = [headers[table].join(","), ...extract[table].map((row) => headers[table].map((column) => csvCell(row[column] ?? null)).join(","))].join("\n") + "\n";
    const file = `${table}.csv`;
    writeFileSync(join(directory, file), body, "utf8");
    manifest.tables[table] = { file, rows: extract[table].length, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
  }
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(join(directory, "manifest.json"), manifestText, "utf8");
  return createHash("sha256").update(manifestText, "utf8").digest("hex");
}
