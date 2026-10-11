// Reporting Track A (RULING-reporting-trackA; RULING-reporting-report-list-and-navigation §2): where a CRP job's report is, and
// how the report list and the preparation picker find a job. Pure — the job page's link, the Reports list's rows and the picker
// share these, so the same job reads the same way wherever it appears.
import type { ReportStage } from "./reportStatus";

/** What decides a job's report link and its eligibility — a slice of the report status register's row. */
export type ReportNavFacts = {
  jobId: string;
  /** The job's default published report, if any. */
  publishedVersionId: string | null;
  /** A reviewed snapshot exists. */
  hasSnapshot: boolean;
  /** Imported v7 history: its record of account is its v7 report. */
  v7Record: boolean;
};

export type ReportLink =
  | { kind: "published"; label: "View composed report"; href: string }
  | { kind: "prepare"; label: "Prepare report"; href: string }
  | { kind: "add-evidence"; label: "Add evidence"; href: string }
  /** No link: v7's report is the record of account and its content is sealed (Q1 (b)) — the metadata is shown instead. */
  | { kind: "v7-record"; label: "v7 record of account · awaiting re-compose"; href: null };

/**
 * A1: the one report link a job has, computed from its state — so the same control does the right thing before and after a
 * job is re-composed, and never leads to an empty preview.
 */
export function reportLinkFor(facts: ReportNavFacts): ReportLink {
  if (facts.publishedVersionId) return { kind: "published", label: "View composed report", href: `/reports/${encodeURIComponent(facts.publishedVersionId)}` };
  if (facts.hasSnapshot) return { kind: "prepare", label: "Prepare report", href: `/report-preview?jobId=${encodeURIComponent(facts.jobId)}` };
  if (facts.v7Record) return { kind: "v7-record", label: "v7 record of account · awaiting re-compose", href: null };
  return { kind: "add-evidence", label: "Add evidence", href: `/jobs/${encodeURIComponent(facts.jobId)}` };
}

/** A3/A5: whether a job can be composed now, is imported history awaiting re-compose, or has nothing to compose yet. */
export type ReportEligibility = "compose-eligible" | "v7-awaiting" | "no-evidence";
export function reportEligibilityOf(facts: ReportNavFacts): ReportEligibility {
  if (facts.publishedVersionId || facts.hasSnapshot) return "compose-eligible";
  return facts.v7Record ? "v7-awaiting" : "no-evidence";
}
export const reportEligibilityLabels: Record<ReportEligibility, string> = {
  "compose-eligible": "Compose-eligible",
  "v7-awaiting": "v7 · awaiting re-compose",
  "no-evidence": "No evidence yet",
};

/** Q1 (b): the v7 record of account, from its unsealed metadata — what there honestly is, with no link to sealed content. */
export type V7ReportMeta = { version: number; status: string; finalisedAt: string | null; dataHash: string | null };
export function v7RecordLine(meta: V7ReportMeta | null): string {
  if (!meta) return "Record of account: imported from NZ Insights Pro v7 (no v7 report version was issued for it).";
  const finalised = meta.finalisedAt ? ` · finalised ${meta.finalisedAt.slice(0, 10)}` : "";
  return `Record of account: NZ Insights Pro v7 report, version ${meta.version} · ${meta.status}${finalised}.`;
}

// ── A3: the filters both surfaces share ─────────────────────────────────────────────────────────────────────────────────────

export type ReportRegisterRow = ReportNavFacts & {
  jobNumber: string; legacyJobNumber: string | null; clientId: string; client: string; title: string;
  ownerUserId: string | null; leadConsultant: string | null; reportingYear: number | null; stage: ReportStage;
};

export type ReportRegisterQuery = {
  /** "My clients" (the default) — the clients the viewer owns; "all" — every client. A view, not a permission. */
  whose: "mine" | "all";
  clientId: string | null;
  leadConsultant: string | null;
  stage: ReportStage | "all";
  year: number | null;
  eligibility: ReportEligibility | "all";
  search: string;
};

export const defaultReportRegisterQuery: ReportRegisterQuery = {
  whose: "mine", clientId: null, leadConsultant: null, stage: "all", year: null, eligibility: "all", search: "",
};

/** The query from a URL, so a filtered view can be shared and survives a reload; anything unreadable is the default. */
export function parseReportRegisterQuery(params: URLSearchParams, stages: readonly string[]): ReportRegisterQuery {
  const year = Number(params.get("year"));
  const stage = params.get("stage");
  const eligibility = params.get("eligibility");
  return {
    whose: params.get("whose") === "all" ? "all" : "mine",
    clientId: params.get("client") || null,
    leadConsultant: params.get("lead") || null,
    stage: stage && stages.includes(stage) ? stage as ReportStage : "all",
    year: Number.isInteger(year) && year > 1900 ? year : null,
    eligibility: eligibility === "compose-eligible" || eligibility === "v7-awaiting" || eligibility === "no-evidence" ? eligibility : "all",
    search: (params.get("q") ?? "").slice(0, 200),
  };
}

/** The URL for a query — only what differs from the default, so the default view has a clean address. */
export function reportRegisterQueryString(query: ReportRegisterQuery): string {
  const params = new URLSearchParams();
  if (query.whose === "all") params.set("whose", "all");
  if (query.clientId) params.set("client", query.clientId);
  if (query.leadConsultant) params.set("lead", query.leadConsultant);
  if (query.stage !== "all") params.set("stage", query.stage);
  if (query.year !== null) params.set("year", String(query.year));
  if (query.eligibility !== "all") params.set("eligibility", query.eligibility);
  if (query.search.trim()) params.set("q", query.search.trim());
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Every filter but the stage — what the stage counters count over, so the funnel answers "of the jobs I'm looking at, where
 * are they?" rather than counting everything.
 */
export function filterReportRegisterExceptStage<T extends ReportRegisterRow>(rows: readonly T[], query: ReportRegisterQuery, viewerUserId: string | null): T[] {
  const needle = query.search.trim().toLowerCase();
  return rows.filter((row) =>
    (query.whose === "all" || (viewerUserId !== null && row.ownerUserId === viewerUserId))
    && (!query.clientId || row.clientId === query.clientId)
    && (!query.leadConsultant || row.leadConsultant === query.leadConsultant)
    && (query.year === null || row.reportingYear === query.year)
    && (query.eligibility === "all" || reportEligibilityOf(row) === query.eligibility)
    && (!needle || [row.jobNumber, row.legacyJobNumber ?? "", row.client, row.title].some((text) => text.toLowerCase().includes(needle))));
}

/** The rows a query shows. Imported jobs are badged, never hidden: only an explicit eligibility filter narrows them. */
export function filterReportRegister<T extends ReportRegisterRow>(rows: readonly T[], query: ReportRegisterQuery, viewerUserId: string | null): T[] {
  return filterReportRegisterExceptStage(rows, query, viewerUserId).filter((row) => query.stage === "all" || row.stage === query.stage);
}
