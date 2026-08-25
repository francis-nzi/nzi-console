import { createHash, randomUUID } from "node:crypto";
import { commandDefinitions, isAllowedJobStageTransition, validateCommand, type CommandContext, type CommandInputMap, type CommandKey, type CommandOutcome, type ScopeQualityTier, type ScopeRowWriteFields, type WorkflowJobFamily } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantWrite } from "./postgres";

export class IdempotencyConflictError extends Error {
  constructor() { super("The idempotency key was already used for a different request."); this.name = "IdempotencyConflictError"; }
}
export class CommandValidationError extends Error {
  constructor(readonly issues: ReturnType<typeof validateCommand>) { super("Command validation failed."); this.name = "CommandValidationError"; }
}
type CommandResult<T extends Record<string, unknown>> = { data: T; entityType: string; entityId: string; topic: string };
type StoredOutcome<T extends Record<string, unknown>> = Extract<CommandOutcome<T>, { state: "success" }>;

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const requestHash = (key: CommandKey, input: unknown) => createHash("sha256").update(JSON.stringify(stable({ key, input }))).digest("hex");

export async function runPostgresCommand<K extends CommandKey, T extends Record<string, unknown>>(
  pool: PoolLike,
  key: K,
  input: CommandInputMap[K],
  context: CommandContext,
  handler: (db: Queryable) => Promise<CommandResult<T>>,
): Promise<StoredOutcome<T>> {
  return withTenantWrite(pool, context.organisationId, (db) => runPostgresCommandInTransaction(db, key, input, context, handler));
}

export async function runPostgresCommandInTransaction<K extends CommandKey, T extends Record<string, unknown>>(
  db: Queryable,
  key: K,
  input: CommandInputMap[K],
  context: CommandContext,
  handler: (db: Queryable) => Promise<CommandResult<T>>,
): Promise<StoredOutcome<T>> {
  const issues = validateCommand(key, input, context);
  if (issues.length) throw new CommandValidationError(issues);
  const hash = requestHash(key, input);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.organisationId}:${context.idempotencyKey}`]);
  const replay = await db.query<{ request_hash: string; outcome_json: StoredOutcome<T> }>(`SELECT request_hash, outcome_json
    FROM nzi_console.command_idempotency WHERE organisation_id=$1 AND idempotency_key=$2`, [context.organisationId, context.idempotencyKey]);
  if (replay.rows[0]) {
    if (replay.rows[0].request_hash !== hash) throw new IdempotencyConflictError();
    return { ...replay.rows[0].outcome_json, replayed: true };
  }
  const result = await handler(db);
  const auditEventId = randomUUID();
  const outcome: StoredOutcome<T> = { state: "success", data: result.data, auditEventId, correlationId: context.correlationId, replayed: false };
  await db.query(`INSERT INTO nzi_console.audit_events
    (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [context.organisationId, auditEventId, context.actorId, context.principal, commandDefinitions[key].auditAction, result.entityType, result.entityId, context.correlationId, context.reason ?? null, JSON.stringify(result.data)]);
  await db.query(`INSERT INTO nzi_console.transactional_outbox
    (organisation_id, outbox_id, topic, payload_json, correlation_id) VALUES ($1,$2,$3,$4::jsonb,$5)`, [context.organisationId, randomUUID(), result.topic, JSON.stringify(result.data), context.correlationId]);
  await db.query(`INSERT INTO nzi_console.command_idempotency
    (organisation_id, idempotency_key, command_key, request_hash, outcome_json) VALUES ($1,$2,$3,$4,$5::jsonb)`, [context.organisationId, context.idempotencyKey, key, hash, JSON.stringify(outcome)]);
  return outcome;
}

export type CreateClientResult = { clientId: string; name: string; status: CommandInputMap["client.create"]["status"] };
export async function createClient(pool: PoolLike, input: CommandInputMap["client.create"], context: CommandContext): Promise<StoredOutcome<CreateClientResult>> {
  return runPostgresCommand(pool, "client.create", input, context, async (db) => {
    const clientId = randomUUID();
    await db.query(`INSERT INTO nzi_console.clients
      (organisation_id, client_id, name, status, sector, location, owner_name, member_since, completeness_percent, next_report_due_label, contact_name, contact_role, contact_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,extract(year from current_date)::int,0,'Not scheduled','','','')`,
      [context.organisationId, clientId, input.name.trim(), input.status, input.sector.trim(), input.location.trim(), input.owner.trim()]);
    return { data: { clientId, name: input.name.trim(), status: input.status }, entityType: "client", entityId: clientId, topic: "client.created" };
  });
}

export type CreateJobResult = { jobId: string; jobNumber: string; sequence: number; clientId: string; family: CommandInputMap["job.create"]["family"] };
export async function createJob(pool: PoolLike, input: CommandInputMap["job.create"], context: CommandContext): Promise<StoredOutcome<CreateJobResult>> {
  return runPostgresCommand(pool, "job.create", input, context, async (db) => {
    const jobId = randomUUID();
    const allocated = await db.query<{ sequence: number }>("SELECT nzi_console.allocate_job_sequence() AS sequence");
    const sequence = allocated.rows[0]!.sequence;
    const detail = input.family === "crp"
      ? { kind: "crp", reportingPeriod: `${input.startDate}–${input.dueDate}`, includedScopes: [], reviewedRows: 0, totalRows: 0 }
      : input.family === "consultancy"
        ? { kind: "consultancy", scope: "", deliverables: [], plannedDays: 0, usedDays: 0 }
        : input.family === "lca"
          ? { kind: "lca", assessment: "", boundary: "", bomLines: 0, scenarios: 0 }
          : input.family === "pcf"
            ? { kind: "pcf", product: "", functionalUnit: "", bomLines: 0, readinessPct: 0 }
            : { kind: "training", course: "", sessions: 0, bookings: 0, attendancePct: 0 };
    const inserted = await db.query<{ job_number: string }>(`INSERT INTO nzi_console.jobs
      (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, owner_name, start_date, due_date, progress_percent, detail_json)
      VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,0,$12::jsonb) RETURNING job_number`,
      [context.organisationId, jobId, input.clientId, sequence, input.family, input.title.trim(), input.workflowStage.trim(), input.reportingYear ?? null, input.owner.trim(), input.startDate, input.dueDate, JSON.stringify(detail)]);
    if (input.family === "crp") {
      const reportingFrom = input.reportingYear ? `${input.reportingYear}-01-01` : input.startDate;
      const reportingTo = input.reportingYear ? `${input.reportingYear}-12-31` : input.dueDate;
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,[context.organisationId,jobId,reportingFrom,reportingTo]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
        SELECT $1,$2,d.dataset_id,'automatic','Matched reporting period and geography.',$5 FROM nzi_console.emission_factor_datasets d
        WHERE d.organisation_id=$1 AND d.status='active' AND d.valid_from<=$3 AND d.valid_to>=$4 AND d.country_code IN ('GB','GLOBAL')
        ON CONFLICT DO NOTHING`,[context.organisationId,jobId,reportingFrom,reportingTo,context.actorId]);
    }
    return { data: { jobId, jobNumber: inserted.rows[0]!.job_number, sequence, clientId: input.clientId, family: input.family }, entityType: "job", entityId: jobId, topic: "job.created" };
  });
}

export type ChangeJobStageResult = { jobId: string; fromStage: string; toStage: string; version: number; stageEventId: string };
export async function changeJobStage(pool: PoolLike, input: CommandInputMap["job.stage.change"], context: CommandContext): Promise<StoredOutcome<ChangeJobStageResult>> {
  return runPostgresCommand(pool, "job.stage.change", input, context, async (db) => {
    const found = await db.query<{ job_family: WorkflowJobFamily; workflow_stage: string; version: number }>(
      "SELECT job_family, workflow_stage, version FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE",
      [context.organisationId, input.jobId],
    );
    const job = found.rows[0];
    if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
    if (job.version !== input.expectedVersion || job.workflow_stage !== input.fromStage) throw new VersionConflictError();
    if (!isAllowedJobStageTransition(job.job_family, input.fromStage, input.toStage)) {
      throw new CommandValidationError([{ field: "toStage", code: "INVALID_TRANSITION", message: "Move to an adjacent workflow stage." }]);
    }
    const stageEventId = randomUUID();
    await db.query(`INSERT INTO nzi_console.job_stage_history
      (organisation_id, stage_event_id, job_id, from_stage, to_stage, actor_id, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.organisationId, stageEventId, input.jobId, input.fromStage, input.toStage, context.actorId, input.note?.trim() || null]);
    const updated = await db.query<{ version: number }>(`UPDATE nzi_console.jobs SET workflow_stage=$3,
      version=version+1, updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND version=$4 RETURNING version`,
      [context.organisationId, input.jobId, input.toStage, input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError();
    return { data: { jobId: input.jobId, fromStage: input.fromStage, toStage: input.toStage, version: updated.rows[0].version, stageEventId }, entityType: "job", entityId: input.jobId, topic: "job.stage.changed" };
  });
}

const scopeEvidence = (input: ScopeRowWriteFields, context: CommandContext) => ({
  provenance: { capturedBy: context.actorId, capturedAt: new Date().toISOString(), datasetId: input.datasetId, factorId: input.factorId, factorVersion: input.factorVersion, qualityTier: input.qualityTier },
  lineage: [
    ...(input.quantity === null ? [] : [{ title: "Activity data captured", detail: `${input.quantity}${input.unit ? ` ${input.unit}` : ""}` }]),
    ...(input.factorId ? [{ title: "Factor selected", detail: `${input.factorLabel ?? input.factorId}${input.factorVersion ? ` · ${input.factorVersion}` : ""}` }] : []),
  ],
});
async function requireCrpJob(db: Queryable, organisationId: string, jobId: string) {
  const found = await db.query<{ job_family: string }>("SELECT job_family FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2", [organisationId, jobId]);
  if (!found.rows[0]) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
  if (found.rows[0].job_family !== "crp") throw new CommandValidationError([{ field: "jobId", code: "WRONG_FAMILY", message: "Scope rows are available only for CRP jobs." }]);
}

export type CreateScopeRowResult = { rowId: string; jobId: string; version: number };
export async function createScopeRow(pool: PoolLike, input: CommandInputMap["scope.row.create"], context: CommandContext): Promise<StoredOutcome<CreateScopeRowResult>> {
  return runPostgresCommand(pool, "scope.row.create", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const rowId = randomUUID(); const evidence = scopeEvidence(input, context);
    await db.query(`INSERT INTO nzi_console.job_scope_rows
      (organisation_id,scope_row_id,job_id,scope,source_label,quantity,unit,dataset_id,factor_id,factor_version,factor_label,quality_tier,provenance_json,lineage_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
      [context.organisationId,rowId,input.jobId,input.scope,input.sourceLabel.trim(),input.quantity,input.unit?.trim()||null,input.datasetId,input.factorId,input.factorVersion,input.factorLabel,input.qualityTier,JSON.stringify(evidence.provenance),JSON.stringify(evidence.lineage)]);
    return { data: { rowId, jobId: input.jobId, version: 1 }, entityType: "scope_row", entityId: rowId, topic: "scope.row.created" };
  });
}

export type UpdateScopeRowResult = { rowId: string; jobId: string; version: number };
export async function updateScopeRow(pool: PoolLike, input: CommandInputMap["scope.row.update"], context: CommandContext): Promise<StoredOutcome<UpdateScopeRowResult>> {
  return runPostgresCommand(pool, "scope.row.update", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId); const evidence = scopeEvidence(input, context);
    const updated = await db.query<{ version: number }>(`UPDATE nzi_console.job_scope_rows SET scope=$4,source_label=$5,
      quantity=$6,unit=$7,dataset_id=$8,factor_id=$9,factor_version=$10,factor_label=$11,quality_tier=$12,
      provenance_json=$13::jsonb,lineage_json=$14::jsonb,enabled=$15,calculated_tco2e=NULL,review_status='pending',reviewed_row_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,
      version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$16 RETURNING version`,
      [context.organisationId,input.jobId,input.rowId,input.scope,input.sourceLabel.trim(),input.quantity,input.unit?.trim()||null,input.datasetId,input.factorId,input.factorVersion,input.factorLabel,input.qualityTier,JSON.stringify(evidence.provenance),JSON.stringify(evidence.lineage),input.enabled,input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError();
    return { data: { rowId: input.rowId, jobId: input.jobId, version: updated.rows[0].version }, entityType: "scope_row", entityId: input.rowId, topic: "scope.row.updated" };
  });
}

export type CalculateScopeRowResult = { rowId: string; jobId: string; version: number; calculatedTco2e: number };
export async function calculateScopeRow(pool: PoolLike,input: CommandInputMap["scope.row.calculate"],context: CommandContext): Promise<StoredOutcome<CalculateScopeRowResult>> {
  return runPostgresCommand(pool,"scope.row.calculate",input,context,async (db) => {
    await requireCrpJob(db,context.organisationId,input.jobId);
    const found = await db.query<{ version:number; quantity:string|null; unit:string|null; scope:string; dataset_id:string|null; factor_id:string|null }>(`SELECT version,quantity,unit,scope,dataset_id,factor_id FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 FOR UPDATE`,[context.organisationId,input.jobId,input.rowId]);
    const row=found.rows[0];
    if (!row) throw new CommandValidationError([{field:"rowId",code:"NOT_FOUND",message:"Scope row was not found."}]);
    if (row.version!==input.expectedVersion) throw new VersionConflictError();
    if (row.quantity===null || !row.unit || !row.dataset_id || !row.factor_id) throw new CommandValidationError([{field:"rowId",code:"INCOMPLETE",message:"Quantity, unit and a selected factor are required before calculation."}]);
    const factor = await db.query<{ label:string; activity_unit:string; kgco2e_per_unit:string; version:string; synthetic:boolean }>(`SELECT f.label,f.activity_unit,f.kgco2e_per_unit,d.version,d.synthetic FROM nzi_console.emission_factors f
      JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(f.organisation_id,f.dataset_id)
      JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id) AND s.job_id=$2
      WHERE f.organisation_id=$1 AND f.dataset_id=$3 AND f.factor_id=$4 AND f.active=true AND (split_part($5,'.',1)=ANY(f.scopes))`,[context.organisationId,input.jobId,row.dataset_id,row.factor_id,row.scope]);
    const matched=factor.rows[0];
    if (!matched) throw new CommandValidationError([{field:"factorId",code:"NOT_SELECTED",message:"The factor is not active, selected for this job, or valid for this scope."}]);
    if (row.unit.trim().toLowerCase()!==matched.activity_unit.trim().toLowerCase()) throw new CommandValidationError([{field:"unit",code:"UNIT_MISMATCH",message:`Activity unit must be ${matched.activity_unit} for the selected factor.`}]);
    const lineage=[{title:"Activity data captured",detail:`${row.quantity} ${row.unit}`},{title:"Factor resolved",detail:`${matched.label} · ${matched.version}`},{title:"Emissions calculated",detail:"quantity × kgCO₂e per unit ÷ 1,000"}];
    const provenance={calculatedBy:context.actorId,calculatedAt:new Date().toISOString(),datasetId:row.dataset_id,factorId:row.factor_id,factorVersion:matched.version,kgCo2ePerUnit:matched.kgco2e_per_unit,synthetic:matched.synthetic};
    const updated=await db.query<{version:number;calculated_tco2e:string}>(`UPDATE nzi_console.job_scope_rows SET factor_version=$4,factor_label=$5,calculated_tco2e=quantity*$6::numeric/1000,provenance_json=$7::jsonb,lineage_json=$8::jsonb,review_status='pending',reviewed_row_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$9 RETURNING version,calculated_tco2e`,[context.organisationId,input.jobId,input.rowId,matched.version,matched.label,matched.kgco2e_per_unit,JSON.stringify(provenance),JSON.stringify(lineage),input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError();
    return {data:{rowId:input.rowId,jobId:input.jobId,version:updated.rows[0].version,calculatedTco2e:Number(updated.rows[0].calculated_tco2e)},entityType:"scope_row",entityId:input.rowId,topic:"scope.row.calculated"};
  });
}

export type AddManualDatasetResult={jobId:string;datasetId:string;selectionSource:"manual";warnings:string[]};
export async function addManualDataset(pool:PoolLike,input:CommandInputMap["dataset.override.add"],context:CommandContext):Promise<StoredOutcome<AddManualDatasetResult>> {
  return runPostgresCommand(pool,"dataset.override.add",input,context,async(db)=>{
    await requireCrpJob(db,context.organisationId,input.jobId);
    const found=await db.query<{valid_from:Date|string;valid_to:Date|string;dataset_country:string;status:string;reporting_from:Date|string;reporting_to:Date|string;job_country:string}>(`SELECT d.valid_from,d.valid_to,d.country_code AS dataset_country,d.status,c.reporting_from,c.reporting_to,c.country_code AS job_country
      FROM nzi_console.emission_factor_datasets d JOIN nzi_console.job_emissions_config c ON c.organisation_id=d.organisation_id AND c.job_id=$2
      WHERE d.organisation_id=$1 AND d.dataset_id=$3`,[context.organisationId,input.jobId,input.datasetId]);
    const item=found.rows[0]; if(!item)throw new CommandValidationError([{field:"datasetId",code:"NOT_FOUND",message:"Dataset was not found."}]);
    const day=(value:Date|string)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);const validFrom=day(item.valid_from),validTo=day(item.valid_to),reportingFrom=day(item.reporting_from),reportingTo=day(item.reporting_to);const warnings:string[]=[];
    if(validFrom>reportingFrom||validTo<reportingTo)warnings.push("Dataset does not cover the complete reporting period.");if(item.dataset_country!==item.job_country&&item.dataset_country!=="GLOBAL")warnings.push(`Dataset geography ${item.dataset_country} differs from job geography ${item.job_country}.`);if(item.status!=="active")warnings.push(`Dataset status is ${item.status}.`);
    const inserted=await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,warnings_json,selected_by) VALUES ($1,$2,$3,'manual',$4,$5::jsonb,$6) ON CONFLICT (organisation_id,job_id,dataset_id) DO NOTHING RETURNING dataset_id`,[context.organisationId,input.jobId,input.datasetId,context.reason,JSON.stringify(warnings),context.actorId]);
    if(!inserted.rows[0])throw new CommandValidationError([{field:"datasetId",code:"ALREADY_SELECTED",message:"Dataset is already selected for this job."}]);
    return {data:{jobId:input.jobId,datasetId:input.datasetId,selectionSource:"manual",warnings},entityType:"job_dataset_selection",entityId:`${input.jobId}:${input.datasetId}`,topic:"dataset.override.added"};
  });
}

export type ReviewScopeRowResult={jobId:string;rowId:string;decision:"approved"|"rejected";version:number;reviewEventId:string};
async function reviewScopeRow<K extends "scope.review.approve"|"scope.review.reject">(pool:PoolLike,key:K,input:CommandInputMap[K],context:CommandContext):Promise<StoredOutcome<ReviewScopeRowResult>>{
 return runPostgresCommand(pool,key,input,context,async(db)=>{await requireCrpJob(db,context.organisationId,input.jobId);if(input.rowIds.length!==1)throw new CommandValidationError([{field:"rowIds",code:"SINGLE_ROW_REQUIRED",message:"Review one row at a time so each decision retains its exact version and evidence."}]);const rowId=input.rowIds[0]!;const found=await db.query<{version:number;enabled:boolean;calculated_tco2e:string|null;override_tco2e:string|null;quality_tier:string|null;provenance_json:Record<string,unknown>}>(`SELECT version,enabled,calculated_tco2e,override_tco2e,quality_tier,provenance_json FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 FOR UPDATE`,[context.organisationId,input.jobId,rowId]);const row=found.rows[0];if(!row)throw new CommandValidationError([{field:"rowIds",code:"NOT_FOUND",message:"Scope row was not found."}]);if(row.version!==input.expectedReviewVersion)throw new VersionConflictError();const decision=key==="scope.review.approve"?"approved":"rejected";if(decision==="approved"){if(!row.enabled)throw new CommandValidationError([{field:"rowIds",code:"DISABLED",message:"A disabled row cannot be approved."}]);if(row.calculated_tco2e===null&&row.override_tco2e===null)throw new CommandValidationError([{field:"rowIds",code:"CALCULATION_REQUIRED",message:"A calculated or justified override result is required before approval."}]);if(!row.quality_tier)throw new CommandValidationError([{field:"rowIds",code:"QUALITY_REQUIRED",message:"Set the data-quality tier before approval."}]);const editor=row.provenance_json?.calculatedBy??row.provenance_json?.capturedBy;if(editor===context.actorId)throw new CommandValidationError([{field:"rowIds",code:"INDEPENDENT_REVIEW_REQUIRED",message:"The most recent editor or calculator cannot approve this row."}]);}const note="reviewerNote" in input?input.reviewerNote?.trim()||null:null;const reviewEventId=randomUUID();await db.query(`INSERT INTO nzi_console.scope_row_review_history (organisation_id,review_event_id,job_id,scope_row_id,row_version,decision,reviewer_id,reviewer_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[context.organisationId,reviewEventId,input.jobId,rowId,row.version,decision,context.actorId,note]);const updated=await db.query<{version:number}>(`UPDATE nzi_console.job_scope_rows SET review_status=$4,reviewed_row_version=$5,reviewed_by=$6,reviewed_at=now(),reviewer_note=$7,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$5 RETURNING version`,[context.organisationId,input.jobId,rowId,decision,row.version,context.actorId,note]);if(!updated.rows[0])throw new VersionConflictError();return{data:{jobId:input.jobId,rowId,decision,version:updated.rows[0].version,reviewEventId},entityType:"scope_row",entityId:rowId,topic:`scope.row.${decision}`};});
}
export const approveScopeRow=(pool:PoolLike,input:CommandInputMap["scope.review.approve"],context:CommandContext)=>reviewScopeRow(pool,"scope.review.approve",input,context);
export const rejectScopeRow=(pool:PoolLike,input:CommandInputMap["scope.review.reject"],context:CommandContext)=>reviewScopeRow(pool,"scope.review.reject",input,context);

export type CreateReviewedSnapshotResult={snapshotId:string;jobId:string;version:number;dataHash:string;reused:boolean};
export async function createReviewedCrpSnapshot(pool:PoolLike,input:CommandInputMap["report.snapshot.create"],context:CommandContext):Promise<StoredOutcome<CreateReviewedSnapshotResult>>{
 // TypeScript narrows the first branch's boolean literal while inferring this union handler; both branches satisfy the declared result.
 // @ts-expect-error handler intentionally returns reused true or false
 return runPostgresCommand(pool,"report.snapshot.create",input,context,async(db)=>{const jobResult=await db.query<{version:number;job_family:string;job_number:string;reporting_year:number|null;start_date:Date|string;client_name:string}>(`SELECT j.version,j.job_family,j.job_number,j.reporting_year,j.start_date,c.name AS client_name FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2 FOR UPDATE`,[context.organisationId,input.jobId]);const job=jobResult.rows[0];if(!job)throw new CommandValidationError([{field:"jobId",code:"NOT_FOUND",message:"Job was not found."}]);if(job.job_family!=="crp")throw new CommandValidationError([{field:"jobId",code:"WRONG_FAMILY",message:"Reviewed CRP snapshots are available only for CRP jobs."}]);if(job.version!==input.expectedJobVersion)throw new VersionConflictError();const rowResult=await db.query<{scope_row_id:string;version:number;scope:string;source_label:string;calculated_tco2e:string|null;override_tco2e:string|null;factor_label:string|null;factor_version:string|null;quality_tier:ScopeQualityTier|null;review_status:string;reviewed_by:string|null;enabled:boolean}>(`SELECT scope_row_id,version,scope,source_label,calculated_tco2e,override_tco2e,factor_label,factor_version,quality_tier,review_status,reviewed_by,enabled FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 ORDER BY scope_row_id FOR SHARE`,[context.organisationId,input.jobId]);const enabled=rowResult.rows.filter(row=>row.enabled);if(enabled.length===0)throw new CommandValidationError([{field:"jobId",code:"NO_ENABLED_ROWS",message:"At least one enabled scope row is required."}]);const incomplete=enabled.filter(row=>row.review_status!=="approved"||(row.calculated_tco2e===null&&row.override_tco2e===null)||!row.quality_tier||!row.reviewed_by);if(incomplete.length)throw new CommandValidationError([{field:"jobId",code:"QA_INCOMPLETE",message:`${incomplete.length} enabled scope row(s) are not calculation-complete and independently approved.`}]);const reportingYear=job.reporting_year??Number((job.start_date instanceof Date?job.start_date.toISOString():String(job.start_date)).slice(0,4));const payload={jobId:input.jobId,jobNumber:job.job_number,client:job.client_name,reportingYear,jobVersion:job.version,measurements:enabled.map(row=>({rowId:row.scope_row_id,rowVersion:row.version,scope:row.scope.split(".")[0],sourceLabel:row.source_label,tco2e:Number(row.override_tco2e??row.calculated_tco2e),factorSet:[row.factor_label,row.factor_version].filter(Boolean).join(" · "),qualityTier:row.quality_tier,reviewedBy:row.reviewed_by}))};const dataHash=`sha256:${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")}`;const existing=await db.query<{snapshot_id:string;snapshot_version:number}>(`SELECT snapshot_id,snapshot_version FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND job_id=$2 AND data_hash=$3`,[context.organisationId,input.jobId,dataHash]);if(existing.rows[0])return{data:{snapshotId:existing.rows[0].snapshot_id,jobId:input.jobId,version:existing.rows[0].snapshot_version,dataHash,reused:true},entityType:"reviewed_crp_snapshot",entityId:existing.rows[0].snapshot_id,topic:"report.snapshot.reused"};await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${context.organisationId}:${input.jobId}:snapshot-version`]);const next=await db.query<{version:number}>(`SELECT coalesce(max(snapshot_version),0)+1 AS version FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND job_id=$2`,[context.organisationId,input.jobId]);const version=Number(next.rows[0]!.version),snapshotId=randomUUID();await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[context.organisationId,snapshotId,input.jobId,version,job.version,dataHash,JSON.stringify(payload),context.actorId]);return{data:{snapshotId,jobId:input.jobId,version,dataHash,reused:false},entityType:"reviewed_crp_snapshot",entityId:snapshotId,topic:"report.snapshot.created"};});
}
