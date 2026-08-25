import type { Queryable } from "./postgres";
import type { ScopeQualityTier, ScopeRowReadModel } from "@nzi/contracts";

export type ClientStatus = "active" | "onboarding" | "at-risk" | "prospect";
export type ClientScreenReadModel = {
  id: string; name: string; sector: string; location: string; status: ClientStatus; owner: string;
  memberSince: string; latestFootprint: string | null; yoy: string | null; completeness: number;
  openJobs: number; nextReportDue: string; contact: { name: string; role: string; email: string };
  jobs: Array<{ number: string; year: number; status: string }>;
};

export type JobFamily = "crp" | "consultancy" | "lca" | "pcf" | "training";
export type JobStageEvent = { id: string; fromStage: string; toStage: string; actorId: string; note?: string; occurredAt: string };
export type JobDetail =
  | { kind: "crp"; reportingPeriod: string; includedScopes: string[]; reviewedRows: number; totalRows: number }
  | { kind: "consultancy"; scope: string; deliverables: string[]; plannedDays: number; usedDays: number }
  | { kind: "lca"; assessment: string; boundary: string; bomLines: number; scenarios: number }
  | { kind: "pcf"; product: string; functionalUnit: string; bomLines: number; readinessPct: number }
  | { kind: "training"; course: string; sessions: number; bookings: number; attendancePct: number };
export type JobScreenReadModel = {
  header: {
    id: string; version: number; sequence: number; number: string; family: JobFamily; clientId: string; client: string;
    title: string; reportingYear?: number; status: "draft" | "open" | "on-hold" | "complete" | "cancelled";
    workflowStage: string; owner: string; startDate: string; dueDate: string; quoteId?: string; progressPct: number;
  };
  detail: JobDetail;
  stageHistory: JobStageEvent[];
};

type ClientRow = {
  client_id: string; name: string; status: ClientStatus; sector: string; location: string; owner_name: string;
  member_since: number; latest_footprint_tco2e: string | null; yoy_percent: string | null;
  completeness_percent: number; next_report_due_label: string; contact_name: string; contact_role: string;
  contact_email: string; open_jobs: string; jobs: Array<{ number: string; year: number; status: string }> | null;
};
type JobRow = {
  job_id: string; version: number; client_id: string; client_name: string; sequence: number; job_number: string; job_family: JobFamily;
  title: string; reporting_year: number | null; status: JobScreenReadModel["header"]["status"]; workflow_stage: string;
  owner_name: string; start_date: Date | string; due_date: Date | string; quote_id: string | null;
  progress_percent: number; detail_json: unknown; stage_history: JobStageEvent[] | null;
};
const dateOnly = (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const footprint = (value: string | null) => value === null ? null : `${Number(value).toLocaleString("en-GB")} tCO₂e`;
const percentage = (value: string | null) => value === null ? null : `${Number(value) > 0 ? "+" : "−"}${Math.abs(Number(value)).toFixed(1)}%`;
const asDetail = (family: JobFamily, value: unknown): JobDetail => {
  if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== family) throw new Error(`Invalid ${family} job detail payload.`);
  return value as JobDetail;
};

export async function listClients(db: Queryable): Promise<ClientScreenReadModel[]> {
  const { rows } = await db.query<ClientRow>(`SELECT c.client_id, c.name, c.status, c.sector, c.location, c.owner_name,
      c.member_since, c.latest_footprint_tco2e, c.yoy_percent, c.completeness_percent,
      c.next_report_due_label, c.contact_name, c.contact_role, c.contact_email,
      count(j.job_id) FILTER (WHERE j.status IN ('draft','open','on-hold'))::text AS open_jobs,
      coalesce(jsonb_agg(jsonb_build_object('number', j.job_number, 'year', coalesce(j.reporting_year, extract(year from j.start_date)::int), 'status', j.workflow_stage)
        ORDER BY j.sequence DESC) FILTER (WHERE j.job_id IS NOT NULL), '[]'::jsonb) AS jobs
    FROM nzi_console.clients c
    LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id)
    GROUP BY c.organisation_id, c.client_id
    ORDER BY lower(c.name), c.client_id`);
  return rows.map((row) => ({ id: row.client_id, name: row.name, sector: row.sector, location: row.location,
    status: row.status, owner: row.owner_name, memberSince: String(row.member_since),
    latestFootprint: footprint(row.latest_footprint_tco2e), yoy: percentage(row.yoy_percent),
    completeness: row.completeness_percent, openJobs: Number(row.open_jobs), nextReportDue: row.next_report_due_label,
    contact: { name: row.contact_name, role: row.contact_role, email: row.contact_email }, jobs: row.jobs ?? [] }));
}

export async function listJobs(db: Queryable): Promise<JobScreenReadModel[]> {
  const { rows } = await db.query<JobRow>(`SELECT j.job_id, j.version, j.client_id, c.name AS client_name, j.sequence, j.job_number,
      j.job_family, j.title, j.reporting_year, j.status, j.workflow_stage, j.owner_name, j.start_date, j.due_date,
      j.quote_id, j.progress_percent, j.detail_json,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.stage_event_id, 'fromStage', h.from_stage,
        'toStage', h.to_stage, 'actorId', h.actor_id, 'note', h.note, 'occurredAt', h.occurred_at)
        ORDER BY h.occurred_at DESC) FROM nzi_console.job_stage_history h
        WHERE (h.organisation_id, h.job_id) = (j.organisation_id, j.job_id)), '[]'::jsonb) AS stage_history
    FROM nzi_console.jobs j
    JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
    ORDER BY j.sequence DESC`);
  return rows.map((row) => ({ header: { id: row.job_id, version: row.version, sequence: row.sequence, number: row.job_number,
    family: row.job_family, clientId: row.client_id, client: row.client_name, title: row.title,
    ...(row.reporting_year === null ? {} : { reportingYear: row.reporting_year }), status: row.status,
    workflowStage: row.workflow_stage, owner: row.owner_name, startDate: dateOnly(row.start_date), dueDate: dateOnly(row.due_date),
    ...(row.quote_id === null ? {} : { quoteId: row.quote_id }), progressPct: row.progress_percent },
    detail: asDetail(row.job_family, row.detail_json), stageHistory: row.stage_history ?? [] }));
}

type ScopeRow = {
  scope_row_id: string; job_id: string; scope: string; source_label: string; quantity: string | null; unit: string | null;
  dataset_id: string | null; factor_id: string | null; factor_version: string | null; factor_label: string | null;
  quality_tier: ScopeQualityTier | null; calculated_tco2e: string | null; override_tco2e: string | null;
  override_reason: string | null; review_status: ScopeRowReadModel["reviewStatus"]; version: number; enabled: boolean;
  provenance_json: Record<string, unknown>; lineage_json: ScopeRowReadModel["lineage"];
};

export async function listScopeRows(db: Queryable, jobId: string): Promise<ScopeRowReadModel[]> {
  const { rows } = await db.query<ScopeRow>(`SELECT r.scope_row_id, r.job_id, r.scope, r.source_label, r.quantity,
      r.unit, r.dataset_id, r.factor_id, r.factor_version, r.factor_label, r.quality_tier,
      r.calculated_tco2e, r.override_tco2e, r.override_reason, r.review_status, r.version, r.enabled,
      r.provenance_json, r.lineage_json
    FROM nzi_console.job_scope_rows r
    JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
    WHERE r.job_id=$1 AND j.job_family='crp'
    ORDER BY r.enabled DESC, split_part(r.scope,'.',1)::int, nullif(split_part(r.scope,'.',2),'')::int NULLS FIRST, lower(r.source_label), r.scope_row_id`, [jobId]);
  return rows.map((row) => ({ id: row.scope_row_id, jobId: row.job_id, scope: row.scope, sourceLabel: row.source_label,
    quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, datasetId: row.dataset_id,
    factorId: row.factor_id, factorVersion: row.factor_version, factorLabel: row.factor_label, qualityTier: row.quality_tier,
    calculatedTco2e: row.calculated_tco2e === null ? null : Number(row.calculated_tco2e),
    overrideTco2e: row.override_tco2e === null ? null : Number(row.override_tco2e), overrideReason: row.override_reason,
    reviewStatus: row.review_status, version: row.version, enabled: row.enabled,
    provenance: row.provenance_json ?? {}, lineage: row.lineage_json ?? [] }));
}
