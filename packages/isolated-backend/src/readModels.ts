import type { Queryable } from "./postgres";
import {rolePermissions,type StaffRole} from "./auth";
import type {CrpReportingChain, CrpReportVersionReadModel, DatasetOption, EmissionSource, EmissionSourceGroup, EmissionsTargetReadModel, FactorOption, IntensityTargetReadModel, PublishedCrpReportReadModel, PurchasedGoodsCategoryOption, ReportSectionEditorScreen, ReportSectionReadModel, ReviewedCrpSnapshotReadModel, SiteOption, ScopeQaReadiness, ScopeQualityTier, ScopeRowReadModel } from "@nzi/contracts";
import { buildReportingChain, resolveReportSections } from "@nzi/contracts";

export type ClientStatus = "active" | "onboarding" | "at-risk" | "prospect";
export type AuditEventReadModel={id:string;at:string;actor:string;principal:"staff"|"portal"|"system";organisation:string;action:string;entity:string;entityId:string;result:"allowed";severity:"info"|"warning";correlationId:string;before?:string;after?:string;reason?:string};
export type ReportVersionRegisterItem={reportVersionId:string;jobId:string;jobNumber:string;client:string;reportingYear:number|null;status:"draft"|"validated"|"published"|"superseded";manifestVersion:number;snapshotId:string;dataHash:string;createdAt:string;publishedAt:string|null;approvalCount:number;commentCount:number};
export type DatasetRegistryItem={id:string;name:string;version:string;validFrom:string;validTo:string;country:string;scopes:Array<"1"|"2"|"3">;method:"activity"|"spend"|"mixed";source:string;analysisType:"published-source";year:number;licence:string;status:"active"|"superseded"|"draft";factorCount:number;usedByJobs:number;synthetic:boolean};
export type DatasetRegistryIssue={id:string;severity:"warning"|"error";datasetId:string;jobNumber:string;message:string;state:"open"|"resolved"};
export type StaffRoleReadModel={id:StaffRole;name:string;members:number;permissions:string[];restricted:string[]};
export type ClientScreenReadModel = {
  id: string; name: string; sector: string; location: string; status: ClientStatus; owner: string;
  memberSince: string; latestFootprint: string | null; yoy: string | null; completeness: number;
  openJobs: number; nextReportDue: string; contact: { name: string; role: string; email: string };
  jobs: Array<{ number: string; year: number; status: string }>;
  sites: Array<{ id: string; name: string }>;
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
  sites: Array<{ id: string; name: string }> | null;
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
      ,coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.site_id, 'name', s.name) ORDER BY lower(s.name), s.site_id)
        FROM nzi_console.client_sites s WHERE (s.organisation_id,s.client_id)=(c.organisation_id,c.client_id)), '[]'::jsonb) AS sites
    FROM nzi_console.clients c
    LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id)
    GROUP BY c.organisation_id, c.client_id
    ORDER BY lower(c.name), c.client_id`);
  return rows.map((row) => ({ id: row.client_id, name: row.name, sector: row.sector, location: row.location,
    status: row.status, owner: row.owner_name, memberSince: String(row.member_since),
    latestFootprint: footprint(row.latest_footprint_tco2e), yoy: percentage(row.yoy_percent),
    completeness: row.completeness_percent, openJobs: Number(row.open_jobs), nextReportDue: row.next_report_due_label,
    contact: { name: row.contact_name, role: row.contact_role, email: row.contact_email }, jobs: row.jobs ?? [], sites: row.sites ?? [] }));
}

export async function listAuditEvents(db:Queryable,limit=100):Promise<AuditEventReadModel[]>{const safeLimit=Math.min(Math.max(Math.trunc(limit),1),250),{rows}=await db.query<{audit_event_id:string;occurred_at:Date|string;actor_id:string;principal_type:AuditEventReadModel["principal"];organisation_id:string;action:string;entity_type:string;entity_id:string;correlation_id:string;reason:string|null;before_json:unknown;after_json:unknown}>(`SELECT audit_event_id,occurred_at,actor_id,principal_type,organisation_id,action,entity_type,entity_id,correlation_id,reason,before_json,after_json FROM nzi_console.audit_events ORDER BY occurred_at DESC,audit_event_id DESC LIMIT $1`,[safeLimit]);const display=(value:unknown)=>value==null?undefined:typeof value==="string"?value:JSON.stringify(value);return rows.map(row=>({id:row.audit_event_id,at:row.occurred_at instanceof Date?row.occurred_at.toISOString():String(row.occurred_at),actor:row.actor_id,principal:row.principal_type,organisation:row.organisation_id,action:row.action,entity:row.entity_type,entityId:row.entity_id,result:"allowed",severity:row.reason?"warning":"info",correlationId:row.correlation_id,...(display(row.before_json)?{before:display(row.before_json)}:{}),...(display(row.after_json)?{after:display(row.after_json)}:{}),...(row.reason?{reason:row.reason}:{})}));}

export async function listReportVersionRegister(db:Queryable):Promise<ReportVersionRegisterItem[]>{const {rows}=await db.query<{report_version_id:string;job_id:string;job_number:string;client_name:string;reporting_year:number|null;status:ReportVersionRegisterItem["status"];manifest_version:number;reviewed_snapshot_id:string;data_hash:string;created_at:Date|string;published_at:Date|string|null;approval_count:string;comment_count:string}>(`SELECT r.report_version_id,r.job_id,j.job_number,c.name AS client_name,j.reporting_year,r.status,r.manifest_version,r.reviewed_snapshot_id,r.data_hash,r.created_at,r.published_at,count(DISTINCT a.approval_id)::text AS approval_count,count(DISTINCT m.comment_id)::text AS comment_count FROM nzi_console.report_versions r JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id) JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) LEFT JOIN nzi_console.portal_report_approvals a ON (a.organisation_id,a.report_version_id)=(r.organisation_id,r.report_version_id) LEFT JOIN nzi_console.portal_report_comments m ON (m.organisation_id,m.report_version_id)=(r.organisation_id,r.report_version_id) GROUP BY r.organisation_id,r.report_version_id,j.organisation_id,j.job_id,c.organisation_id,c.client_id ORDER BY r.created_at DESC,r.report_version_id DESC`);const iso=(value:Date|string)=>value instanceof Date?value.toISOString():String(value);return rows.map(row=>({reportVersionId:row.report_version_id,jobId:row.job_id,jobNumber:row.job_number,client:row.client_name,reportingYear:row.reporting_year,status:row.status,manifestVersion:row.manifest_version,snapshotId:row.reviewed_snapshot_id,dataHash:row.data_hash,createdAt:iso(row.created_at),publishedAt:row.published_at==null?null:iso(row.published_at),approvalCount:Number(row.approval_count),commentCount:Number(row.comment_count)}));}

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
  site_id:string|null;site_label:string|null;purchased_goods_category_id:string|null;purchased_goods_category_label:string|null;
  report_label:string;level_1:string;level_2:string;level_3:string|null;level_4:string|null;
  monthly_activity_json:ScopeRowReadModel["monthlyActivity"];
  notes:string|null;asset_identifier:string|null;factor_source:"dataset"|"client";client_factor_id:string|null;is_custom_entry:boolean;apply_pct:string;data_confidence:"H"|"M"|"L"|null;source_quantity:string|null;source_unit:string|null;column_text:string|null;client_factor_version_moved:boolean;category_code:string|null;
};

export async function listScopeRows(db: Queryable, jobId: string): Promise<ScopeRowReadModel[]> {
  const { rows } = await db.query<ScopeRow>(`SELECT r.scope_row_id, r.job_id, r.scope, r.source_label, r.quantity,
      r.unit, r.site_id,s.name AS site_label,r.purchased_goods_category_id,pgc.name AS purchased_goods_category_label,r.dataset_id, r.factor_id, r.factor_version, r.factor_label, r.quality_tier,
      r.calculated_tco2e, r.override_tco2e, r.override_reason, r.review_status,r.reviewed_row_version,r.reviewed_by,r.reviewed_at,r.reviewer_note, r.version, r.enabled,
      r.provenance_json, r.lineage_json,r.report_label,r.level_1,r.level_2,r.level_3,r.level_4,r.monthly_activity_json,r.notes,r.asset_identifier,r.factor_source,r.client_factor_id,r.is_custom_entry,r.apply_pct,r.data_confidence,r.source_quantity,r.source_unit,r.column_text,r.category_code,
      (r.factor_source='client' AND r.client_factor_id IS NOT NULL AND EXISTS(SELECT 1 FROM nzi_console.client_factors cf WHERE cf.organisation_id=r.organisation_id AND cf.client_factor_id=r.client_factor_id AND 'v'||cf.version::text <> coalesce(r.factor_version,''))) AS client_factor_version_moved
    FROM nzi_console.job_scope_rows r
    JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
    LEFT JOIN nzi_console.client_sites s ON (s.organisation_id,s.site_id)=(r.organisation_id,r.site_id)
    LEFT JOIN nzi_console.purchased_goods_categories pgc ON (pgc.organisation_id,pgc.category_id)=(r.organisation_id,r.purchased_goods_category_id)
    WHERE r.job_id=$1 AND j.job_family='crp'
    ORDER BY r.enabled DESC, split_part(r.scope,'.',1)::int, nullif(split_part(r.scope,'.',2),'')::int NULLS FIRST, lower(r.source_label), r.scope_row_id`, [jobId]);
  return rows.map((row) => ({ id: row.scope_row_id, jobId: row.job_id, scope: row.scope, sourceLabel: row.source_label,assetIdentifier:row.asset_identifier??null,factorSource:row.factor_source??"dataset",clientFactorId:row.client_factor_id??null,isCustomEntry:row.is_custom_entry??false,applyPct:Number(row.apply_pct??100),dataConfidence:row.data_confidence??null,sourceQuantity:row.source_quantity==null?null:Number(row.source_quantity),sourceUnit:row.source_unit??null,columnText:row.column_text??null,reportLabel:row.report_label??row.source_label,notes:row.notes??null,categoryPath:[row.level_1,row.level_2,row.level_3,row.level_4].filter((value):value is string=>typeof value==="string"),categoryCode:row.category_code??null,monthlyActivity:row.monthly_activity_json??[],siteId:row.site_id,siteLabel:row.site_label,purchasedGoodsCategoryId:row.purchased_goods_category_id,purchasedGoodsCategoryLabel:row.purchased_goods_category_label,
    quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, datasetId: row.dataset_id,
    factorId: row.factor_id, factorVersion: row.factor_version, factorLabel: row.factor_label, qualityTier: row.quality_tier,
    calculatedTco2e: row.calculated_tco2e === null ? null : Number(row.calculated_tco2e), clientFactorVersionMoved: row.client_factor_version_moved === true,
    overrideTco2e: row.override_tco2e === null ? null : Number(row.override_tco2e), overrideReason: row.override_reason,
    reviewStatus: row.review_status,reviewedRowVersion:row.reviewed_row_version??null,reviewedBy:row.reviewed_by??null,reviewedAt:row.reviewed_at==null?null:row.reviewed_at instanceof Date?row.reviewed_at.toISOString():String(row.reviewed_at),reviewerNote:row.reviewer_note??null, version: row.version, enabled: row.enabled,
    provenance: row.provenance_json ?? {}, lineage: row.lineage_json ?? [] }));
}

export async function listJobSites(db:Queryable,jobId:string):Promise<SiteOption[]>{const {rows}=await db.query<{site_id:string;name:string}>(`SELECT s.site_id,s.name FROM nzi_console.client_sites s JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(s.organisation_id,s.client_id) WHERE j.job_id=$1 ORDER BY lower(s.name),s.site_id`,[jobId]);return rows.map(row=>({id:row.site_id,name:row.name}));}
export async function listJobPurchasedGoodsCategories(db:Queryable,jobId:string):Promise<PurchasedGoodsCategoryOption[]>{const {rows}=await db.query<{category_id:string;name:string}>(`SELECT c.category_id,c.name FROM nzi_console.purchased_goods_categories c JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(c.organisation_id,c.client_id) WHERE j.job_id=$1 ORDER BY lower(c.name),c.category_id`,[jobId]);return rows.map(row=>({id:row.category_id,name:row.name}));}
export async function listJobReportingMonths(db:Queryable,jobId:string):Promise<string[]>{const {rows}=await db.query<{reporting_from:Date|string;reporting_to:Date|string}>(`SELECT reporting_from,reporting_to FROM nzi_console.job_emissions_config WHERE job_id=$1`,[jobId]),row=rows[0];if(!row)return[];const dateOnly=(value:Date|string)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10),months:string[]=[],cursor=new Date(`${dateOnly(row.reporting_from).slice(0,7)}-01T00:00:00Z`),end=dateOnly(row.reporting_to).slice(0,7);while(cursor.toISOString().slice(0,7)<=end){months.push(cursor.toISOString().slice(0,7));cursor.setUTCMonth(cursor.getUTCMonth()+1);}return months;}

const FACTOR_VERSION_MOVED_SQL=`(s.factor_source='dataset' AND s.dataset_id IS NOT NULL AND EXISTS(SELECT 1 FROM nzi_console.emission_factor_datasets d1 JOIN nzi_console.emission_factor_datasets d2 ON d2.organisation_id=d1.organisation_id AND d2.name=d1.name AND d2.dataset_id<>d1.dataset_id JOIN nzi_console.job_dataset_selections sel ON sel.organisation_id=d2.organisation_id AND sel.dataset_id=d2.dataset_id AND sel.job_id=s.job_id WHERE d1.organisation_id=s.organisation_id AND d1.dataset_id=s.dataset_id))`;
export async function listJobEmissionSourceRegister(db:Queryable,jobId:string):Promise<{groups:EmissionSourceGroup[];sources:EmissionSource[];rollups:import("@nzi/contracts").EmissionGroupRollup[]}>{const groups=await db.query<{group_id:string;job_id:string;name:string;dataset_id:string|null;factor_id:string|null;factor_label:string|null;unit:string|null}>(`SELECT group_id,job_id,name,dataset_id,factor_id,factor_label,unit FROM nzi_console.job_emission_groups WHERE job_id=$1 ORDER BY lower(name),group_id`,[jobId]),
  rollupRows=await db.query<{group_id:string;scope_row_id:string;scope:string;auto_pair_kind:string|null;review_status:"pending"|"approved"|"rejected";enabled:boolean;quantity:string|null;member_count:string;enabled_member_count:string;stale:boolean}>(`SELECT r.group_id,r.scope_row_id,r.scope,r.auto_pair_kind,r.review_status,r.enabled,r.quantity,(SELECT count(*) FROM nzi_console.job_emission_sources m WHERE (m.organisation_id,m.group_id)=(r.organisation_id,r.group_id) AND m.voided_at IS NULL)::text AS member_count,(SELECT count(*) FROM nzi_console.job_emission_sources m WHERE (m.organisation_id,m.group_id)=(r.organisation_id,r.group_id) AND m.enabled=true AND m.voided_at IS NULL)::text AS enabled_member_count,EXISTS(SELECT 1 FROM nzi_console.job_emission_sources m WHERE (m.organisation_id,m.group_id)=(r.organisation_id,r.group_id) AND m.voided_at IS NULL AND m.updated_at>r.updated_at) AS stale FROM nzi_console.job_scope_rows r WHERE r.job_id=$1 AND r.group_id IS NOT NULL`,[jobId]),sources=await db.query<{source_id:string;job_id:string;group_id:string|null;scope:string;source_type:EmissionSource["sourceType"];source_subtype:string|null;site_id:string|null;source_name:string;asset_identifier:string|null;purchased_goods_category_id:string|null;rolled_forward_from_source_id:string|null;factor_version_moved:boolean;yoy_prior_quantity:string|null;yoy_prior_unit:string|null;dataset_id:string|null;factor_id:string|null;factor_source:EmissionSource["factorSource"];client_factor_id:string|null;quantity:string|null;unit:string|null;apply_pct:string;data_source:string;data_confidence:EmissionSource["dataConfidence"];monthly_activity_json:EmissionSource["monthlyActivity"];detail_json:EmissionSource["detail"];notes:string|null;calculated_tco2e:string|null;enabled:boolean;submitted_by_portal:boolean;review_status:EmissionSource["reviewStatus"];version:number;scope_row_id:string|null;scope_row_version:number|null;scope_row_review_status:EmissionSource["scopeRowReviewStatus"]}>(`SELECT s.source_id,s.job_id,s.group_id,s.scope,s.source_type,s.source_subtype,s.site_id,s.source_name,s.asset_identifier,s.purchased_goods_category_id,s.rolled_forward_from_source_id,${FACTOR_VERSION_MOVED_SQL} AS factor_version_moved,prior.quantity AS yoy_prior_quantity,prior.unit AS yoy_prior_unit,s.dataset_id,s.factor_id,s.factor_source,s.client_factor_id,s.quantity,s.unit,s.apply_pct,s.data_source,s.data_confidence,s.monthly_activity_json,s.detail_json,s.notes,s.calculated_tco2e,s.enabled,s.submitted_by_portal,s.review_status,s.version,r.scope_row_id,r.version AS scope_row_version,r.review_status AS scope_row_review_status FROM nzi_console.job_emission_sources s LEFT JOIN nzi_console.job_scope_rows r ON (r.organisation_id,r.source_id)=(s.organisation_id,s.source_id) LEFT JOIN nzi_console.job_emission_sources prior ON (prior.organisation_id,prior.source_id)=(s.organisation_id,s.rolled_forward_from_source_id) WHERE s.job_id=$1 AND s.voided_at IS NULL ORDER BY s.enabled DESC,s.source_type,lower(s.source_name),s.source_id`,[jobId]);return{rollups:rollupRows.rows.map(row=>({groupId:row.group_id,rowId:row.scope_row_id,scope:row.scope,autoPairKind:row.auto_pair_kind,reviewStatus:row.review_status,memberCount:Number(row.member_count),enabledMemberCount:Number(row.enabled_member_count),summedQuantity:row.quantity===null?null:Number(row.quantity),enabled:row.enabled,stale:row.stale===true})),groups:groups.rows.map(row=>({id:row.group_id,jobId:row.job_id,name:row.name,datasetId:row.dataset_id,factorId:row.factor_id,factorLabel:row.factor_label,unit:row.unit})),sources:sources.rows.map(row=>({id:row.source_id,jobId:row.job_id,groupId:row.group_id,scope:row.scope,sourceType:row.source_type,sourceSubtype:row.source_subtype,siteId:row.site_id,sourceName:row.source_name,assetIdentifier:row.asset_identifier,purchasedGoodsCategoryId:row.purchased_goods_category_id,rolledForwardFromSourceId:row.rolled_forward_from_source_id??null,factorVersionMoved:row.factor_version_moved===true,yoyPriorQuantity:row.yoy_prior_quantity==null?null:Number(row.yoy_prior_quantity),yoyPriorUnit:row.yoy_prior_unit??null,datasetId:row.dataset_id,factorId:row.factor_id,factorSource:row.factor_source,clientFactorId:row.client_factor_id,quantity:row.quantity===null?null:Number(row.quantity),unit:row.unit,applyPct:Number(row.apply_pct),dataSource:row.data_source,dataConfidence:row.data_confidence,monthlyActivity:row.monthly_activity_json??[],detail:row.detail_json,notes:row.notes,calculatedTco2e:row.calculated_tco2e===null?null:Number(row.calculated_tco2e),enabled:row.enabled,submittedByPortal:row.submitted_by_portal,reviewStatus:row.review_status,version:row.version,scopeRowId:row.scope_row_id,scopeRowVersion:row.scope_row_version,scopeRowReviewStatus:row.scope_row_review_status}))};}

export async function listSpendRollforwardPreview(db:Queryable,jobId:string):Promise<import("@nzi/contracts").SpendRollforwardPreview>{
  const target=await db.query<{client_id:string;reporting_year:number|null;start_date:Date|string}>(`SELECT client_id,reporting_year,start_date FROM nzi_console.jobs WHERE job_id=$1 AND job_family='crp'`,[jobId]);
  const t=target.rows[0];
  if(!t)return{priorJob:null,lines:[]};
  const targetYear=t.reporting_year??Number((t.start_date instanceof Date?t.start_date.toISOString():String(t.start_date)).slice(0,4));
  const prior=await db.query<{job_id:string;job_number:string;reporting_year:number}>(`SELECT j.job_id,j.job_number,coalesce(j.reporting_year,extract(year from j.start_date)::int) AS reporting_year FROM nzi_console.jobs j WHERE j.client_id=$1 AND j.job_family='crp' AND j.job_id<>$2 AND coalesce(j.reporting_year,extract(year from j.start_date)::int)<$3 AND EXISTS(SELECT 1 FROM nzi_console.job_emission_sources s WHERE s.organisation_id=j.organisation_id AND s.job_id=j.job_id AND s.source_type='spend' AND s.enabled=true) ORDER BY coalesce(j.reporting_year,extract(year from j.start_date)::int) DESC,j.sequence DESC LIMIT 1`,[t.client_id,jobId,targetYear]);
  const p=prior.rows[0];
  if(!p)return{priorJob:null,lines:[]};
  const lines=await db.query<{prior_source_id:string;description:string;gl_code:string|null;purchased_goods_category_id:string|null;category_label:string|null;factor_source:import("@nzi/contracts").FactorSource;factor_label:string|null;pinned_version:string|null;current_version:string|null;dataset_in_selection:boolean;already_rolled_forward:boolean}>(`SELECT s.source_id AS prior_source_id,s.source_name AS description,s.source_subtype AS gl_code,s.purchased_goods_category_id,pgc.name AS category_label,s.factor_source,coalesce(cf.report_label,f.label) AS factor_label,coalesce('v'||cf.version::text,d.version) AS pinned_version,(SELECT d2.version FROM nzi_console.emission_factor_datasets d1 JOIN nzi_console.emission_factor_datasets d2 ON d2.organisation_id=d1.organisation_id AND d2.name=d1.name JOIN nzi_console.job_dataset_selections sel ON sel.organisation_id=d2.organisation_id AND sel.dataset_id=d2.dataset_id AND sel.job_id=$2 WHERE d1.organisation_id=s.organisation_id AND d1.dataset_id=s.dataset_id ORDER BY (d2.dataset_id=s.dataset_id) DESC LIMIT 1) AS current_version,EXISTS(SELECT 1 FROM nzi_console.job_dataset_selections sel WHERE sel.organisation_id=s.organisation_id AND sel.job_id=$2 AND sel.dataset_id=s.dataset_id) AS dataset_in_selection,EXISTS(SELECT 1 FROM nzi_console.job_emission_sources rf WHERE rf.organisation_id=s.organisation_id AND rf.job_id=$2 AND rf.rolled_forward_from_source_id=s.source_id) AS already_rolled_forward FROM nzi_console.job_emission_sources s LEFT JOIN nzi_console.purchased_goods_categories pgc ON (pgc.organisation_id,pgc.category_id)=(s.organisation_id,s.purchased_goods_category_id) LEFT JOIN nzi_console.client_factors cf ON (cf.organisation_id,cf.client_factor_id)=(s.organisation_id,s.client_factor_id) LEFT JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id,f.factor_id)=(s.organisation_id,s.dataset_id,s.factor_id) LEFT JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.job_id=$1 AND s.source_type='spend' AND s.enabled=true ORDER BY lower(s.source_name),s.source_id`,[p.job_id,jobId]);
  return{priorJob:{id:p.job_id,number:p.job_number,reportingYear:p.reporting_year},lines:lines.rows.map(row=>({priorSourceId:row.prior_source_id,description:row.description,glCode:row.gl_code,purchasedGoodsCategoryId:row.purchased_goods_category_id,purchasedGoodsCategoryLabel:row.category_label,factorSource:row.factor_source,factorLabel:row.factor_label,pinnedFactorVersion:row.pinned_version,currentFactorVersion:row.current_version,factorVersionMoved:row.current_version!=null&&row.current_version!==row.pinned_version,datasetInJobSelection:row.dataset_in_selection===true,alreadyRolledForward:row.already_rolled_forward===true}))};
}

export async function getScopeQaReadiness(db:Queryable,jobId:string):Promise<ScopeQaReadiness>{const {rows}=await db.query<{total:string;enabled:string;approved:string;pending:string;rejected:string;calculation_missing:string;quality_missing:string;independent_review_pending:string}>(`SELECT count(*)::text AS total,count(*) FILTER(WHERE enabled)::text AS enabled,count(*) FILTER(WHERE enabled AND review_status='approved')::text AS approved,count(*) FILTER(WHERE enabled AND review_status='pending')::text AS pending,count(*) FILTER(WHERE enabled AND review_status='rejected')::text AS rejected,count(*) FILTER(WHERE enabled AND calculated_tco2e IS NULL AND override_tco2e IS NULL)::text AS calculation_missing,count(*) FILTER(WHERE enabled AND quality_tier IS NULL)::text AS quality_missing,count(*) FILTER(WHERE enabled AND review_status<>'approved')::text AS independent_review_pending FROM nzi_console.job_scope_rows WHERE job_id=$1`,[jobId]);const r=rows[0]??{total:"0",enabled:"0",approved:"0",pending:"0",rejected:"0",calculation_missing:"0",quality_missing:"0",independent_review_pending:"0"};const result={total:Number(r.total),enabled:Number(r.enabled),approved:Number(r.approved),pending:Number(r.pending),rejected:Number(r.rejected),calculationMissing:Number(r.calculation_missing),qualityMissing:Number(r.quality_missing),independentReviewPending:Number(r.independent_review_pending),readyForReporting:false};result.readyForReporting=result.enabled>0&&result.calculationMissing===0&&result.qualityMissing===0&&result.independentReviewPending===0;return result;}

type TargetRow={job_id:string;baseline_year:number;baseline_tco2e:string;interim_year:number;interim_reduction_percent:string;net_zero_year:number;version:number;updated_by:string;updated_at:Date|string};
const mapTarget=(row:TargetRow):EmissionsTargetReadModel=>({jobId:row.job_id,baselineYear:row.baseline_year,baselineTco2e:Number(row.baseline_tco2e),interimYear:row.interim_year,interimReductionPercent:Number(row.interim_reduction_percent),netZeroYear:row.net_zero_year,version:row.version,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():String(row.updated_at),updatedBy:row.updated_by});
export async function getJobEmissionsTarget(db:Queryable,jobId:string):Promise<EmissionsTargetReadModel|null>{const {rows}=await db.query<TargetRow>(`SELECT job_id,baseline_year,baseline_tco2e,interim_year,interim_reduction_percent,net_zero_year,version,updated_by,updated_at FROM nzi_console.job_emissions_targets WHERE job_id=$1`,[jobId]);return rows[0]?mapTarget(rows[0]):null;}
type IntensityRow={job_id:string;metric:IntensityTargetReadModel["metric"];denominator_unit:string;reporting_denominator:string;baseline_year:number;baseline_intensity:string;interim_year:number;interim_reduction_percent:string;net_zero_year:number;version:number;updated_by:string;updated_at:Date|string};
const mapIntensity=(row:IntensityRow):IntensityTargetReadModel=>({jobId:row.job_id,metric:row.metric,denominatorUnit:row.denominator_unit,reportingDenominator:Number(row.reporting_denominator),baselineYear:row.baseline_year,baselineIntensity:Number(row.baseline_intensity),interimYear:row.interim_year,interimReductionPercent:Number(row.interim_reduction_percent),netZeroYear:row.net_zero_year,version:row.version,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():String(row.updated_at),updatedBy:row.updated_by});
export async function getJobIntensityTarget(db:Queryable,jobId:string):Promise<IntensityTargetReadModel|null>{const {rows}=await db.query<IntensityRow>(`SELECT job_id,metric,denominator_unit,reporting_denominator,baseline_year,baseline_intensity,interim_year,interim_reduction_percent,net_zero_year,version,updated_by,updated_at FROM nzi_console.job_intensity_targets WHERE job_id=$1`,[jobId]);return rows[0]?mapIntensity(rows[0]):null;}

type SnapshotRow={snapshot_id:string;job_id:string;snapshot_version:number;job_version:number;data_hash:string;payload_json:{jobNumber:string;client:string;reportingYear:number;target?:EmissionsTargetReadModel|null;intensityTarget?:IntensityTargetReadModel|null;annualComparison?:ReviewedCrpSnapshotReadModel["annualComparison"];sections?:ReportSectionReadModel[];measurements:ReviewedCrpSnapshotReadModel["measurements"]};created_by:string;created_at:Date|string};

/** R2 (NZC-048) — the working editable report sections for a job, in report order. */
type ReportSectionRow={section_key:string;content_source:ReportSectionReadModel["contentSource"];body_html:string;version:number;updated_by:string;updated_at:Date|string};
export async function listReportSections(db:Queryable,jobId:string):Promise<ReportSectionReadModel[]>{
  const {rows}=await db.query<ReportSectionRow>(`SELECT section_key,content_source,body_html,version,updated_by,updated_at FROM nzi_console.report_sections WHERE job_id=$1`,[jobId]);
  return resolveReportSections(rows.map(row=>({key:row.section_key,contentSource:row.content_source,bodyHtml:row.body_html,version:row.version,updatedBy:row.updated_by,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():String(row.updated_at)})));
}

/**
 * DA1 (NZC-059) — the baseline / prior-year chain for a CRP job's assurance
 * trend. Baseline year from the job's emissions target; prior years are the
 * latest reviewed CRP snapshot per distinct reporting year for the same client
 * (< current); current year is this job's own reviewed snapshot or `live`.
 */
export async function resolveCrpReportingChain(db: Queryable, jobId: string): Promise<CrpReportingChain | null> {
  const jobResult = await db.query<{ client_id: string; reporting_year: number | null; start_date: Date | string; job_family: string }>(
    `SELECT client_id, reporting_year, start_date, job_family FROM nzi_console.jobs WHERE job_id=$1`, [jobId],
  );
  const job = jobResult.rows[0];
  if (!job || job.job_family !== "crp") return null;
  const currentYear = job.reporting_year ?? Number((job.start_date instanceof Date ? job.start_date.toISOString() : String(job.start_date)).slice(0, 4));

  const [targetResult, priorResult, currentResult] = await Promise.all([
    db.query<{ baseline_year: number }>(`SELECT baseline_year FROM nzi_console.job_emissions_targets WHERE job_id=$1`, [jobId]),
    db.query<{ snapshot_id: string; data_hash: string; reporting_year: number }>(
      `SELECT DISTINCT ON ((s.payload_json->>'reportingYear')::integer)
         s.snapshot_id, s.data_hash, (s.payload_json->>'reportingYear')::integer AS reporting_year
       FROM nzi_console.reviewed_crp_snapshots s
       JOIN nzi_console.jobs pj ON (pj.organisation_id, pj.job_id) = (s.organisation_id, s.job_id)
       WHERE pj.client_id = $1 AND pj.job_family = 'crp' AND (s.payload_json->>'reportingYear')::integer < $2
       ORDER BY (s.payload_json->>'reportingYear')::integer, s.snapshot_version DESC`,
      [job.client_id, currentYear],
    ),
    db.query<{ snapshot_id: string; data_hash: string }>(
      `SELECT snapshot_id, data_hash FROM nzi_console.reviewed_crp_snapshots WHERE job_id=$1 ORDER BY snapshot_version DESC LIMIT 1`, [jobId],
    ),
  ]);

  return buildReportingChain({
    jobId,
    clientId: job.client_id,
    currentYear,
    baselineYear: targetResult.rows[0]?.baseline_year ?? null,
    priorSnapshots: priorResult.rows.map((row) => ({ year: row.reporting_year, snapshotId: row.snapshot_id, dataHash: row.data_hash })),
    currentSnapshot: currentResult.rows[0] ? { snapshotId: currentResult.rows[0].snapshot_id, dataHash: currentResult.rows[0].data_hash } : null,
  });
}

/** R4 — the working-sections editor screen: sections + live (unreviewed) figures. */
export async function getReportSectionsEditorScreen(db:Queryable,jobId:string):Promise<ReportSectionEditorScreen|null>{
  const jobResult=await db.query<{job_number:string;reporting_year:number|null;start_date:Date|string;job_family:string}>(`SELECT job_number,reporting_year,start_date,job_family FROM nzi_console.jobs WHERE job_id=$1`,[jobId]);
  const job=jobResult.rows[0];
  if(!job||job.job_family!=="crp")return null;
  const reportingYear=job.reporting_year??Number((job.start_date instanceof Date?job.start_date.toISOString():String(job.start_date)).slice(0,4));
  const [sections,rowResult,target,intensity]=await Promise.all([
    listReportSections(db,jobId),
    db.query<{scope:string;tco2e:string|null}>(`SELECT split_part(scope,'.',1) AS scope,coalesce(override_tco2e,calculated_tco2e)::text AS tco2e FROM nzi_console.job_scope_rows WHERE job_id=$1 AND enabled=true`,[jobId]),
    getJobEmissionsTarget(db,jobId),
    getJobIntensityTarget(db,jobId),
  ]);
  const measurements=rowResult.rows
    .filter((row):row is {scope:"1"|"2"|"3";tco2e:string}=>row.tco2e!==null&&(row.scope==="1"||row.scope==="2"||row.scope==="3"))
    .map(row=>({scope:row.scope,tco2e:Number(row.tco2e)}));
  return {
    jobId,jobNumber:job.job_number,reportingYear,sections,
    figures:{
      reportingYear,
      measurements,
      target:target?{baselineYear:target.baselineYear,baselineTco2e:target.baselineTco2e,interimYear:target.interimYear,interimReductionPercent:target.interimReductionPercent,netZeroYear:target.netZeroYear}:null,
      intensityTarget:intensity?{denominatorUnit:intensity.denominatorUnit,reportingDenominator:intensity.reportingDenominator}:null,
    },
  };
}
export async function listReviewedCrpSnapshots(db:Queryable,jobId:string):Promise<ReviewedCrpSnapshotReadModel[]>{const {rows}=await db.query<SnapshotRow>(`SELECT snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by,created_at FROM nzi_console.reviewed_crp_snapshots WHERE job_id=$1 ORDER BY snapshot_version DESC`,[jobId]);return rows.map(row=>({id:row.snapshot_id,jobId:row.job_id,jobNumber:row.payload_json.jobNumber,client:row.payload_json.client,reportingYear:row.payload_json.reportingYear,version:row.snapshot_version,jobVersion:row.job_version,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),createdBy:row.created_by,dataHash:row.data_hash,target:row.payload_json.target??null,intensityTarget:row.payload_json.intensityTarget??null,annualComparison:row.payload_json.annualComparison??[],sections:row.payload_json.sections??resolveReportSections([]),measurements:row.payload_json.measurements}));}

type PublishedReportRow=SnapshotRow&{report_version_id:string;manifest_version:number;report_data_hash:string;published_at:Date|string};
type ReportVersionDetailRow=SnapshotRow&{report_version_id:string;status:CrpReportVersionReadModel["status"];manifest_version:number;report_data_hash:string;published_at:Date|string|null};
export async function getCrpReportVersion(db:Queryable,reportVersionId:string):Promise<CrpReportVersionReadModel|null>{const {rows}=await db.query<ReportVersionDetailRow>(`SELECT r.report_version_id,r.status,r.manifest_version,r.data_hash AS report_data_hash,r.published_at,s.snapshot_id,s.job_id,s.snapshot_version,s.job_version,s.data_hash,s.payload_json,s.created_by,s.created_at FROM nzi_console.report_versions r JOIN nzi_console.reviewed_crp_snapshots s ON (s.organisation_id,s.snapshot_id)=(r.organisation_id,r.reviewed_snapshot_id) JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id) WHERE r.report_version_id=$1 AND r.status IN ('validated','published','superseded') AND j.job_family='crp'`,[reportVersionId]);const row=rows[0];if(!row)return null;if(row.report_data_hash!==row.data_hash)throw new Error("Report version evidence hash does not match its reviewed snapshot.");return{reportVersionId:row.report_version_id,status:row.status,manifestVersion:row.manifest_version,publishedAt:row.published_at==null?null:row.published_at instanceof Date?row.published_at.toISOString():String(row.published_at),dataHash:row.report_data_hash,snapshot:{id:row.snapshot_id,jobId:row.job_id,jobNumber:row.payload_json.jobNumber,client:row.payload_json.client,reportingYear:row.payload_json.reportingYear,version:row.snapshot_version,jobVersion:row.job_version,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),createdBy:row.created_by,dataHash:row.data_hash,target:row.payload_json.target??null,intensityTarget:row.payload_json.intensityTarget??null,annualComparison:row.payload_json.annualComparison??[],sections:row.payload_json.sections??resolveReportSections([]),measurements:row.payload_json.measurements}};}
export async function getCurrentPublishedCrpReport(db:Queryable,jobId:string):Promise<PublishedCrpReportReadModel|null>{const {rows}=await db.query<PublishedReportRow>(`SELECT r.report_version_id,r.manifest_version,r.data_hash AS report_data_hash,r.published_at,s.snapshot_id,s.job_id,s.snapshot_version,s.job_version,s.data_hash,s.payload_json,s.created_by,s.created_at FROM nzi_console.report_versions r JOIN nzi_console.reviewed_crp_snapshots s ON (s.organisation_id,s.snapshot_id)=(r.organisation_id,r.reviewed_snapshot_id) JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id) WHERE r.job_id=$1 AND r.status='published' AND j.job_family='crp'`,[jobId]);const row=rows[0];if(!row)return null;if(row.report_data_hash!==row.data_hash)throw new Error("Published report evidence hash does not match its reviewed snapshot.");const snapshot:ReviewedCrpSnapshotReadModel={id:row.snapshot_id,jobId:row.job_id,jobNumber:row.payload_json.jobNumber,client:row.payload_json.client,reportingYear:row.payload_json.reportingYear,version:row.snapshot_version,jobVersion:row.job_version,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),createdBy:row.created_by,dataHash:row.data_hash,target:row.payload_json.target??null,intensityTarget:row.payload_json.intensityTarget??null,annualComparison:row.payload_json.annualComparison??[],sections:row.payload_json.sections??resolveReportSections([]),measurements:row.payload_json.measurements};return{reportVersionId:row.report_version_id,manifestVersion:row.manifest_version,publishedAt:row.published_at instanceof Date?row.published_at.toISOString():String(row.published_at),dataHash:row.report_data_hash,snapshot};}
export async function getGrantedPublishedCrpReport(db:Queryable,input:{portalUserId:string;clientId:string;jobId:string}):Promise<PublishedCrpReportReadModel|null>{const granted=await db.query(`SELECT 1 FROM nzi_console.portal_access_grants g JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id,j.client_id)=(g.organisation_id,g.job_id,g.client_id) WHERE g.portal_user_id=$1 AND g.client_id=$2 AND g.job_id=$3 AND g.revoked_at IS NULL`,[input.portalUserId,input.clientId,input.jobId]);if(!granted.rows[0])return null;return getCurrentPublishedCrpReport(db,input.jobId);}

export async function listDatasetRegistry(db:Queryable):Promise<{datasets:DatasetRegistryItem[];issues:DatasetRegistryIssue[]}>{const datasets=await db.query<{dataset_id:string;name:string;version:string;valid_from:string;valid_to:string;country_code:string;status:DatasetRegistryItem["status"];source_name:string;licence:string;synthetic:boolean;factor_count:string;job_count:string;scopes:string[];spend_count:string;activity_count:string}>(`SELECT d.dataset_id,d.name,d.version,d.valid_from::text,d.valid_to::text,d.country_code,d.status,d.source_name,d.licence,d.synthetic,count(DISTINCT f.factor_id)::text AS factor_count,count(DISTINCT s.job_id)::text AS job_count,coalesce(array_agg(DISTINCT scope) FILTER (WHERE scope IN ('1','2','3')),'{}') AS scopes,count(DISTINCT f.factor_id) FILTER (WHERE upper(f.activity_unit) IN ('GBP','USD','EUR'))::text AS spend_count,count(DISTINCT f.factor_id) FILTER (WHERE upper(f.activity_unit) NOT IN ('GBP','USD','EUR'))::text AS activity_count FROM nzi_console.emission_factor_datasets d LEFT JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(d.organisation_id,d.dataset_id) LEFT JOIN LATERAL unnest(f.scopes) scope ON true LEFT JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(d.organisation_id,d.dataset_id) GROUP BY d.organisation_id,d.dataset_id ORDER BY d.valid_from DESC,d.name,d.version`),warnings=await db.query<{dataset_id:string;job_number:string;warning:string}>(`SELECT s.dataset_id,j.job_number,w.warning FROM nzi_console.job_dataset_selections s JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(s.organisation_id,s.job_id) CROSS JOIN LATERAL jsonb_array_elements_text(s.warnings_json) w(warning) ORDER BY s.selected_at DESC`);return{datasets:datasets.rows.map(row=>{const spend=Number(row.spend_count),activity=Number(row.activity_count);return{id:row.dataset_id,name:row.name,version:row.version,validFrom:row.valid_from,validTo:row.valid_to,country:row.country_code,scopes:row.scopes as Array<"1"|"2"|"3">,method:spend&&activity?"mixed":spend?"spend":"activity",source:row.source_name,analysisType:"published-source",year:Number(row.valid_from.slice(0,4)),licence:row.licence,status:row.status,factorCount:Number(row.factor_count),usedByJobs:Number(row.job_count),synthetic:row.synthetic}}),issues:warnings.rows.map((row,index)=>({id:`${row.dataset_id}:${row.job_number}:${index}`,severity:"warning",datasetId:row.dataset_id,jobNumber:row.job_number,message:row.warning,state:"open"}))};}

export async function listStaffRoleGovernance(db:Queryable):Promise<StaffRoleReadModel[]>{const {rows}=await db.query<{role_id:StaffRole;members:string}>(`SELECT role_id,count(*) FILTER (WHERE status='active')::text AS members FROM nzi_console.memberships GROUP BY role_id`),counts=new Map(rows.map(row=>[row.role_id,Number(row.members)])),all=Array.from(new Set(Object.values(rolePermissions).flat()));return(Object.keys(rolePermissions) as StaffRole[]).map(role=>({id:role,name:role.split("-").map(word=>word[0]!.toUpperCase()+word.slice(1)).join(" "),members:counts.get(role)??0,permissions:[...rolePermissions[role]],restricted:all.filter(permission=>!rolePermissions[role].includes(permission))}));}
export type PortalReportApproval={approvalId:string;reportVersionId:string;approvedAt:string;statementVersion:1};
export async function getPortalReportApproval(db:Queryable,input:{portalUserId:string;reportVersionId:string}):Promise<PortalReportApproval|null>{const {rows}=await db.query<{approval_id:string;report_version_id:string;approved_at:Date|string;statement_version:1}>(`SELECT approval_id,report_version_id,approved_at,statement_version FROM nzi_console.portal_report_approvals WHERE portal_user_id=$1 AND report_version_id=$2`,[input.portalUserId,input.reportVersionId]);const row=rows[0];return row?{approvalId:row.approval_id,reportVersionId:row.report_version_id,approvedAt:row.approved_at instanceof Date?row.approved_at.toISOString():String(row.approved_at),statementVersion:row.statement_version}:null;}
export async function listGrantedPortalJobs(db:Queryable,input:{portalUserId:string;clientId:string}){const {rows}=await db.query<{job_id:string;job_number:string;title:string;reporting_year:number|null;report_version_id:string|null;approved_at:Date|string|null;has_unread_nzi_response:boolean}>(`SELECT j.job_id,j.job_number,j.title,j.reporting_year,pr.report_version_id,a.approved_at,EXISTS(SELECT 1 FROM nzi_console.portal_report_comments m LEFT JOIN nzi_console.portal_report_thread_reads rd ON (rd.organisation_id,rd.report_version_id,rd.portal_user_id)=(m.organisation_id,m.report_version_id,g.portal_user_id) WHERE (m.organisation_id,m.report_version_id)=(j.organisation_id,pr.report_version_id) AND m.author_principal='staff' AND (rd.last_read_at IS NULL OR m.created_at>rd.last_read_at)) AS has_unread_nzi_response FROM nzi_console.portal_access_grants g JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id,j.client_id)=(g.organisation_id,g.job_id,g.client_id) LEFT JOIN LATERAL (SELECT r.report_version_id FROM nzi_console.report_versions r WHERE (r.organisation_id,r.job_id)=(j.organisation_id,j.job_id) AND r.status='published' LIMIT 1) pr ON true LEFT JOIN nzi_console.portal_report_approvals a ON (a.organisation_id,a.report_version_id,a.portal_user_id)=(j.organisation_id,pr.report_version_id,g.portal_user_id) WHERE g.portal_user_id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL ORDER BY j.sequence DESC`,[input.portalUserId,input.clientId]);return rows.map(row=>({id:row.job_id,number:row.job_number,title:row.title,reportingYear:row.reporting_year,hasPublishedReport:row.report_version_id!==null,approved:row.approved_at!==null,approvedAt:row.approved_at===null?null:row.approved_at instanceof Date?row.approved_at.toISOString():String(row.approved_at),hasUnreadNziResponse:row.has_unread_nzi_response}));}

type FactorRow = { dataset_id: string|null; dataset_name: string; dataset_version: string; factor_id: string; label: string; activity_unit: string; kgco2e_per_unit: string; scopes: string[]; selection_source: FactorOption["selectionSource"];factor_source:FactorOption["factorSource"];client_factor_id:string|null;evidence_hash:string|null; synthetic: boolean; warnings_json: string[] };
export async function listJobFactorOptions(db: Queryable, jobId: string): Promise<FactorOption[]> {
  const { rows } = await db.query<FactorRow>(`SELECT * FROM (SELECT d.dataset_id,d.name AS dataset_name,d.version AS dataset_version,
      f.factor_id,f.label,f.activity_unit,f.kgco2e_per_unit::text,f.scopes,s.selection_source,'dataset'::text AS factor_source,NULL::text AS client_factor_id,NULL::text AS evidence_hash,d.synthetic,s.warnings_json
    FROM nzi_console.job_dataset_selections s
    JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(s.organisation_id,s.dataset_id)
    JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(d.organisation_id,d.dataset_id)
    WHERE s.job_id=$1 AND f.active=true
    UNION ALL
    SELECT NULL::text,'Client factors','v'||cf.version::text,cf.client_factor_id,cf.report_label,cf.unit,cf.kgco2e_per_unit::text,ARRAY[cf.scope],'client','client',cf.client_factor_id,cf.evidence_hash,false,'[]'::jsonb
    FROM nzi_console.client_factors cf JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id)
    WHERE j.job_id=$1 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false) options
    ORDER BY lower(dataset_name),lower(label),factor_id`,[jobId]);
  return rows.map((row) => ({ datasetId: row.dataset_id,datasetName: row.dataset_name,datasetVersion: row.dataset_version,
    factorId: row.factor_id,label: row.label,activityUnit: row.activity_unit,kgco2ePerUnit:Number(row.kgco2e_per_unit),
    scopes:row.scopes,selectionSource:row.selection_source,factorSource:row.factor_source,clientFactorId:row.client_factor_id,evidenceHash:row.evidence_hash,synthetic:row.synthetic,warnings:row.warnings_json ?? [] }));
}

// NZC-046 / UX1a — the scope→category accordion's applicable-category list.
//  crm    → the completeness view: every taxonomy category for an included scope
//           (all 15 Scope 3 when Scope 3 is included), empties flagged `noData`.
//  portal → only the categories the client's bucket grants authorise.
// Included scopes = the top-level scopes present in the job's active
// selected-dataset factors, unioned with any scope that already has a row.
export async function listJobApplicableCategories(db:Queryable,jobId:string,audience:"crm"|"portal"):Promise<import("@nzi/contracts").JobApplicableCategories>{
  const {emissionCategoryTaxonomy}=await import("@nzi/contracts");
  const scopeRows=await db.query<{scope:string}>(`SELECT DISTINCT scope FROM (SELECT split_part(unnest(f.scopes),'.',1) AS scope FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.job_id=$1 AND f.active=true UNION ALL SELECT split_part(r.scope,'.',1) FROM nzi_console.job_scope_rows r WHERE r.job_id=$1) x WHERE scope<>''`,[jobId]);
  const includedScopes=(["1","2","3"] as const).filter(scope=>scopeRows.rows.some(row=>row.scope===scope));
  const metrics=await db.query<{code:string;entry_count:string;tco2e:string;complete_count:string}>(`SELECT coalesce(nullif(category_code,''),scope) AS code,count(*) FILTER (WHERE enabled)::text AS entry_count,coalesce(sum(coalesce(override_tco2e,calculated_tco2e,0)) FILTER (WHERE enabled),0)::text AS tco2e,count(*) FILTER (WHERE enabled AND review_status='approved' AND (calculated_tco2e IS NOT NULL OR override_tco2e IS NOT NULL) AND quality_tier IS NOT NULL)::text AS complete_count FROM nzi_console.job_scope_rows WHERE job_id=$1 GROUP BY 1`,[jobId]);
  const byCode=new Map(metrics.rows.map(row=>[row.code,row]));
  let authorisedCodes:Set<string>|null=null;
  if(audience==="portal"){
    const grants=await db.query<{code:string}>(`SELECT DISTINCT coalesce(nullif(r.category_code,''),r.scope) AS code FROM nzi_console.portal_data_entry_bucket_grants b JOIN nzi_console.portal_access_grants g ON (g.organisation_id,g.grant_id)=(b.organisation_id,b.access_grant_id) JOIN nzi_console.job_scope_rows r ON (r.organisation_id,r.scope_row_id)=(b.organisation_id,b.scope_row_id) WHERE g.job_id=$1 AND b.revoked_at IS NULL AND g.revoked_at IS NULL`,[jobId]);
    authorisedCodes=new Set(grants.rows.map(row=>row.code));
  }
  const categories=emissionCategoryTaxonomy
    .filter(category=>includedScopes.includes(category.scope))
    .filter(category=>audience==="crm"||authorisedCodes!.has(category.code))
    .map(category=>{
      const m=byCode.get(category.code),entryCount=m?Number(m.entry_count):0;
      return{...category,entryCount,tco2e:m?Number(m.tco2e):0,completeness:entryCount===0?0:Math.round((Number(m!.complete_count)/entryCount)*100),noData:entryCount===0,...(audience==="portal"?{authorised:true}:{})};
    });
  return{audience,includedScopes:[...includedScopes],categories};
}

// S2 — client factor lifecycle (NZC-041). The client's reusable factors + (when a
// job is given) that job's pinned ones, each with a usage count of the enabled
// canonical rows that reference it, so the surface can guard archive.
export type ClientFactorRecord = { clientFactorId:string; clientId:string; jobId:string|null; scope:string; categoryPath:string[]; reportLabel:string; description:string; unit:string; ghgUnit:string; kgco2ePerUnit:number; geography:string; vintageYear:number; version:number; source:string; evidenceFileName:string|null; evidenceStorageProvider:"local"|"sharepoint"|null; evidenceUrl:string|null; evidenceExternalItemId:string|null; evidenceHash:string|null; archived:boolean; usageCount:number; createdBy:string; createdAt:string; updatedBy:string|null; updatedAt:string|null };
export async function listClientFactors(db:Queryable,organisationId:string,clientId:string,options?:{jobId?:string|null}):Promise<ClientFactorRecord[]>{
  const jobId=options?.jobId?.trim()||null;
  const {rows}=await db.query<{client_factor_id:string;client_id:string;job_id:string|null;scope:string;category_path_json:string[];report_label:string;description:string;unit:string;ghg_unit:string;kgco2e_per_unit:string;geography:string;vintage_year:number;version:number;source:string;evidence_file_name:string|null;evidence_storage_provider:"local"|"sharepoint"|null;evidence_url:string|null;evidence_external_item_id:string|null;evidence_hash:string|null;archived:boolean;usage_count:number;created_by:string;created_at:Date|string;updated_by:string|null;updated_at:Date|string|null}>(
    `SELECT cf.client_factor_id,cf.client_id,cf.job_id,cf.scope,cf.category_path_json,cf.report_label,cf.description,cf.unit,cf.ghg_unit,cf.kgco2e_per_unit::text,cf.geography,cf.vintage_year,cf.version,cf.source,cf.evidence_file_name,cf.evidence_storage_provider,cf.evidence_url,cf.evidence_external_item_id,cf.evidence_hash,cf.archived,cf.created_by,cf.created_at,cf.updated_by,cf.updated_at,(SELECT count(*) FROM nzi_console.job_scope_rows r WHERE r.organisation_id=cf.organisation_id AND r.client_factor_id=cf.client_factor_id AND r.enabled=true)::int AS usage_count
     FROM nzi_console.client_factors cf
     WHERE cf.organisation_id=$1 AND cf.client_id=$2 AND ($3::text IS NULL OR cf.job_id IS NULL OR cf.job_id=$3)
     ORDER BY cf.archived,lower(cf.report_label),cf.client_factor_id`,
    [organisationId,clientId,jobId],
  );
  return rows.map((row)=>({clientFactorId:row.client_factor_id,clientId:row.client_id,jobId:row.job_id,scope:row.scope,categoryPath:Array.isArray(row.category_path_json)?row.category_path_json:[],reportLabel:row.report_label,description:row.description,unit:row.unit,ghgUnit:row.ghg_unit,kgco2ePerUnit:Number(row.kgco2e_per_unit),geography:row.geography,vintageYear:row.vintage_year,version:row.version,source:row.source,evidenceFileName:row.evidence_file_name,evidenceStorageProvider:row.evidence_storage_provider,evidenceUrl:row.evidence_url,evidenceExternalItemId:row.evidence_external_item_id,evidenceHash:row.evidence_hash,archived:row.archived,usageCount:Number(row.usage_count),createdBy:row.created_by,createdAt:new Date(row.created_at).toISOString(),updatedBy:row.updated_by,updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null}));
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
