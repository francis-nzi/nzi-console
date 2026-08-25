import type { Queryable } from "./postgres";
import type { DatasetOption, EmissionsTargetReadModel, FactorOption, ReviewedCrpSnapshotReadModel, ScopeQaReadiness, ScopeQualityTier, ScopeRowReadModel } from "@nzi/contracts";

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
  reviewed_row_version:number|null;reviewed_by:string|null;reviewed_at:Date|string|null;reviewer_note:string|null;
  provenance_json: Record<string, unknown>; lineage_json: ScopeRowReadModel["lineage"];
};

export async function listScopeRows(db: Queryable, jobId: string): Promise<ScopeRowReadModel[]> {
  const { rows } = await db.query<ScopeRow>(`SELECT r.scope_row_id, r.job_id, r.scope, r.source_label, r.quantity,
      r.unit, r.dataset_id, r.factor_id, r.factor_version, r.factor_label, r.quality_tier,
      r.calculated_tco2e, r.override_tco2e, r.override_reason, r.review_status,r.reviewed_row_version,r.reviewed_by,r.reviewed_at,r.reviewer_note, r.version, r.enabled,
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
    reviewStatus: row.review_status,reviewedRowVersion:row.reviewed_row_version??null,reviewedBy:row.reviewed_by??null,reviewedAt:row.reviewed_at==null?null:row.reviewed_at instanceof Date?row.reviewed_at.toISOString():String(row.reviewed_at),reviewerNote:row.reviewer_note??null, version: row.version, enabled: row.enabled,
    provenance: row.provenance_json ?? {}, lineage: row.lineage_json ?? [] }));
}

export async function getScopeQaReadiness(db:Queryable,jobId:string):Promise<ScopeQaReadiness>{const {rows}=await db.query<{total:string;enabled:string;approved:string;pending:string;rejected:string;calculation_missing:string;quality_missing:string;independent_review_pending:string}>(`SELECT count(*)::text AS total,count(*) FILTER(WHERE enabled)::text AS enabled,count(*) FILTER(WHERE enabled AND review_status='approved')::text AS approved,count(*) FILTER(WHERE enabled AND review_status='pending')::text AS pending,count(*) FILTER(WHERE enabled AND review_status='rejected')::text AS rejected,count(*) FILTER(WHERE enabled AND calculated_tco2e IS NULL AND override_tco2e IS NULL)::text AS calculation_missing,count(*) FILTER(WHERE enabled AND quality_tier IS NULL)::text AS quality_missing,count(*) FILTER(WHERE enabled AND review_status<>'approved')::text AS independent_review_pending FROM nzi_console.job_scope_rows WHERE job_id=$1`,[jobId]);const r=rows[0]??{total:"0",enabled:"0",approved:"0",pending:"0",rejected:"0",calculation_missing:"0",quality_missing:"0",independent_review_pending:"0"};const result={total:Number(r.total),enabled:Number(r.enabled),approved:Number(r.approved),pending:Number(r.pending),rejected:Number(r.rejected),calculationMissing:Number(r.calculation_missing),qualityMissing:Number(r.quality_missing),independentReviewPending:Number(r.independent_review_pending),readyForReporting:false};result.readyForReporting=result.enabled>0&&result.calculationMissing===0&&result.qualityMissing===0&&result.independentReviewPending===0;return result;}

type TargetRow={job_id:string;baseline_year:number;baseline_tco2e:string;interim_year:number;interim_reduction_percent:string;net_zero_year:number;version:number;updated_by:string;updated_at:Date|string};
const mapTarget=(row:TargetRow):EmissionsTargetReadModel=>({jobId:row.job_id,baselineYear:row.baseline_year,baselineTco2e:Number(row.baseline_tco2e),interimYear:row.interim_year,interimReductionPercent:Number(row.interim_reduction_percent),netZeroYear:row.net_zero_year,version:row.version,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():String(row.updated_at),updatedBy:row.updated_by});
export async function getJobEmissionsTarget(db:Queryable,jobId:string):Promise<EmissionsTargetReadModel|null>{const {rows}=await db.query<TargetRow>(`SELECT job_id,baseline_year,baseline_tco2e,interim_year,interim_reduction_percent,net_zero_year,version,updated_by,updated_at FROM nzi_console.job_emissions_targets WHERE job_id=$1`,[jobId]);return rows[0]?mapTarget(rows[0]):null;}

type SnapshotRow={snapshot_id:string;job_id:string;snapshot_version:number;job_version:number;data_hash:string;payload_json:{jobNumber:string;client:string;reportingYear:number;target?:EmissionsTargetReadModel|null;measurements:ReviewedCrpSnapshotReadModel["measurements"]};created_by:string;created_at:Date|string};
export async function listReviewedCrpSnapshots(db:Queryable,jobId:string):Promise<ReviewedCrpSnapshotReadModel[]>{const {rows}=await db.query<SnapshotRow>(`SELECT snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by,created_at FROM nzi_console.reviewed_crp_snapshots WHERE job_id=$1 ORDER BY snapshot_version DESC`,[jobId]);return rows.map(row=>({id:row.snapshot_id,jobId:row.job_id,jobNumber:row.payload_json.jobNumber,client:row.payload_json.client,reportingYear:row.payload_json.reportingYear,version:row.snapshot_version,jobVersion:row.job_version,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),createdBy:row.created_by,dataHash:row.data_hash,target:row.payload_json.target??null,measurements:row.payload_json.measurements}));}

type FactorRow = { dataset_id: string; dataset_name: string; dataset_version: string; factor_id: string; label: string; activity_unit: string; kgco2e_per_unit: string; scopes: string[]; selection_source: FactorOption["selectionSource"]; synthetic: boolean; warnings_json: string[] };
export async function listJobFactorOptions(db: Queryable, jobId: string): Promise<FactorOption[]> {
  const { rows } = await db.query<FactorRow>(`SELECT d.dataset_id,d.name AS dataset_name,d.version AS dataset_version,
      f.factor_id,f.label,f.activity_unit,f.kgco2e_per_unit,f.scopes,s.selection_source,d.synthetic,s.warnings_json
    FROM nzi_console.job_dataset_selections s
    JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(s.organisation_id,s.dataset_id)
    JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(d.organisation_id,d.dataset_id)
    WHERE s.job_id=$1 AND f.active=true ORDER BY lower(d.name),lower(f.label),f.factor_id`,[jobId]);
  return rows.map((row) => ({ datasetId: row.dataset_id,datasetName: row.dataset_name,datasetVersion: row.dataset_version,
    factorId: row.factor_id,label: row.label,activityUnit: row.activity_unit,kgco2ePerUnit:Number(row.kgco2e_per_unit),
    scopes:row.scopes,selectionSource:row.selection_source,synthetic:row.synthetic,warnings:row.warnings_json ?? [] }));
}

type DatasetRow = { dataset_id:string;name:string;version:string;valid_from:Date|string;valid_to:Date|string;country_code:string;status:DatasetOption["status"];synthetic:boolean;selection_source:"automatic"|"manual"|null;reporting_from:Date|string;reporting_to:Date|string;job_country_code:string };
export async function listJobDatasetOptions(db:Queryable,jobId:string):Promise<DatasetOption[]> {
  const {rows}=await db.query<DatasetRow>(`SELECT d.dataset_id,d.name,d.version,d.valid_from,d.valid_to,d.country_code,d.status,d.synthetic,
      s.selection_source,c.reporting_from,c.reporting_to,c.country_code AS job_country_code
    FROM nzi_console.job_emissions_config c
    JOIN nzi_console.emission_factor_datasets d ON d.organisation_id=c.organisation_id
    LEFT JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.job_id,s.dataset_id)=(c.organisation_id,c.job_id,d.dataset_id)
    WHERE c.job_id=$1 ORDER BY (s.dataset_id IS NULL),lower(d.name),d.valid_from DESC`,[jobId]);
  return rows.map((row)=>{const reportingFrom=dateOnly(row.reporting_from),reportingTo=dateOnly(row.reporting_to),validFrom=dateOnly(row.valid_from),validTo=dateOnly(row.valid_to);const warnings:string[]=[];if(validFrom>reportingFrom||validTo<reportingTo)warnings.push("Does not cover the complete reporting period.");if(row.country_code!==row.job_country_code&&row.country_code!=="GLOBAL")warnings.push(`Geography ${row.country_code} differs from job geography ${row.job_country_code}.`);if(row.status!=="active")warnings.push(`Dataset status is ${row.status}.`);return {datasetId:row.dataset_id,name:row.name,version:row.version,validFrom,validTo,countryCode:row.country_code,status:row.status,synthetic:row.synthetic,selected:row.selection_source!==null,selectionSource:row.selection_source,applicable:warnings.length===0,warnings,reportingFrom,reportingTo,jobCountryCode:row.job_country_code};});
}
