// B1 (RULING-report-studio-consolidation R3/R6; REVIEW-report-srcline-and-B1-rulings) — what a `composed@3` report names as
// its sources, and its audit appendix, both composed from the reviewed snapshot and frozen with the report.
//
// A composition before B1 carries only the snapshot's per-row factor strings ("{factor label} · {dataset version}"): one per
// factor (68 on J000663), each ending in the dataset's stored version, which on a re-ingested job is an upload file name.
// Here the snapshot's provenance stamp names each dataset by its id ("DESNZ GB 2025"), labelled **at compose** and frozen —
// a later change to the registry's labels cannot redraw a report already issued (F-0). The per-row detail moves to the
// appendix, where a reader auditing a figure looks for it.
import { crpScopeCategoryLabel } from "./commands";
import { datasetLabelFromId } from "./datasetSources";
import { snapshotSourceSummary, type SnapshotProvenanceStamp } from "./evidence";
import type { ReportScope } from "./reportScope";

export type ReportSources = {
  /** "Reviewed snapshot J000663 · DESNZ GB 2025 · DESNZ GB 2026": the one line under every chart and section. */
  summary: string;
  /** The stamp's factor sets, as labelled at compose. */
  sets: Array<{ source: "dataset" | "client"; id: string; label: string }>;
};

export type ReportCompositionAuditRow = {
  scope: "1" | "2" | "3";
  scopeCode: string;
  /** The scope category by name ("1.1 Stationary combustion"), as the R5a appendix names it. */
  category: string;
  activity: string;
  /** null = organisation-level (no site). */
  site: string | null;
  /** The factor applied, by its label — never the dataset's stored version. */
  factor: string;
  /** The dataset (by id label) or client factor it came from; "Not recorded" when the snapshot cannot say. */
  source: string;
  qualityTier: string | null;
  tco2e: number;
};

/** Every row the report's figures sum, with what each rests on. No quantity: a spend-based row's quantity is money (NZC-120). */
export type ReportAuditAppendix = { rows: ReportCompositionAuditRow[]; totalTco2e: number };

type Stamp = SnapshotProvenanceStamp | null | undefined;

/** The report's sources, from the snapshot's stamp. Absent without one: the report then names what it always did. */
export function composeReportSources(snapshot: { jobNumber: string; provenance?: Stamp }): ReportSources | undefined {
  const summary = snapshotSourceSummary(snapshot);
  if (summary === null) return undefined;
  const sets = (snapshot.provenance?.factorSets ?? []).map((set) => ({ source: set.source, id: set.id, label: set.source === "dataset" ? datasetLabelFromId(set.id) : set.name }));
  return { summary, sets };
}

export type AuditMeasurement = {
  scope: string; scopeCode?: string | null; tco2e: number;
  sourceLabel?: string | null; reportLabel?: string | null; siteId?: string | null; siteLabel?: string | null;
  factorSet?: string | null; factorSource?: string | null; qualityTier?: string | null;
};

const SEPARATOR = " · ";
/** A stored version that is an upload's file name, which a report never prints. */
const FILE_NAME = /\.(csv|tsv|xlsx|xlsm|xls|ods|json|txt)$/i;
const NOT_RECORDED = "Not recorded";

/**
 * One row's factor and source. A measurement freezes its factor as `"{label} · {version}"` and no dataset id, so the
 * dataset is found by matching that version against the stamp's entries: one match names it, several (two datasets sharing
 * a stored version) name every candidate, none says "Not recorded" — and a version that is a file name is never shown.
 */
export function auditFactorAndSource(row: Pick<AuditMeasurement, "factorSet" | "factorSource">, stamp: Stamp): { factor: string; source: string } {
  const text = row.factorSet?.trim() ?? "";
  if (!text) return { factor: NOT_RECORDED, source: NOT_RECORDED };
  const at = text.lastIndexOf(SEPARATOR);
  const label = at >= 0 ? text.slice(0, at) : text, version = at >= 0 ? text.slice(at + SEPARATOR.length) : "";
  if (row.factorSource === "client") return { factor: FILE_NAME.test(version) ? label : text, source: "Client factor" };
  const matches = [...new Set((stamp?.factorSets ?? []).filter((set) => set.source === "dataset" && version !== "" && set.version === version).map((set) => datasetLabelFromId(set.id)))].sort((a, b) => a.localeCompare(b));
  if (matches.length > 0) return { factor: label, source: matches.join(" / ") };
  if (FILE_NAME.test(version)) return { factor: label, source: NOT_RECORDED };
  if (at < 0 && FILE_NAME.test(text)) return { factor: NOT_RECORDED, source: NOT_RECORDED };
  return { factor: text, source: NOT_RECORDED };
}

/**
 * The audit appendix: the rows the report's figures sum — cut to its scope by the same filter its chart basis is (a site view
 * keeps only its sites' rows) — each with its activity, site, factor, source, tier and tCO₂e. By scope code, then largest.
 */
export function composeReportAudit(input: { measurements: readonly AuditMeasurement[]; provenance?: Stamp; scope: ReportScope }): ReportAuditAppendix {
  const sites = input.scope.kind === "sites" ? new Set(input.scope.siteIds) : null;
  const kept = sites ? input.measurements.filter((row) => typeof row.siteId === "string" && sites.has(row.siteId)) : input.measurements;
  const rows = kept.map((row): ReportCompositionAuditRow => {
    const { factor, source } = auditFactorAndSource(row, input.provenance);
    const scope = (["1", "2", "3"].includes(row.scope) ? row.scope : "3") as ReportCompositionAuditRow["scope"];
    const scopeCode = row.scopeCode ?? scope;
    return {
      scope, scopeCode, category: crpScopeCategoryLabel(scopeCode), activity: row.reportLabel?.trim() || row.sourceLabel?.trim() || NOT_RECORDED,
      site: row.siteId ? row.siteLabel ?? row.siteId : null, factor, source, qualityTier: row.qualityTier ?? null, tco2e: Number(row.tco2e),
    };
  }).sort((a, b) => a.scopeCode.localeCompare(b.scopeCode, "en", { numeric: true }) || b.tco2e - a.tco2e || a.activity.localeCompare(b.activity));
  return { rows, totalTco2e: rows.reduce((total, row) => total + row.tco2e, 0) };
}
