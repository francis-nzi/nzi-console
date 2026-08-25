import { createHash, randomUUID } from "node:crypto";
import { commandDefinitions, isAllowedJobStageTransition, validateCommand, type CommandContext, type CommandInputMap, type CommandKey, type CommandOutcome, type ScopeRowWriteFields, type WorkflowJobFamily } from "@nzi/contracts";
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
      provenance_json=$13::jsonb,lineage_json=$14::jsonb,enabled=$15,calculated_tco2e=NULL,review_status='pending',
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
    const updated=await db.query<{version:number;calculated_tco2e:string}>(`UPDATE nzi_console.job_scope_rows SET factor_version=$4,factor_label=$5,calculated_tco2e=quantity*$6::numeric/1000,provenance_json=$7::jsonb,lineage_json=$8::jsonb,review_status='pending',version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$9 RETURNING version,calculated_tco2e`,[context.organisationId,input.jobId,input.rowId,matched.version,matched.label,matched.kgco2e_per_unit,JSON.stringify(provenance),JSON.stringify(lineage),input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError();
    return {data:{rowId:input.rowId,jobId:input.jobId,version:updated.rows[0].version,calculatedTco2e:Number(updated.rows[0].calculated_tco2e)},entityType:"scope_row",entityId:input.rowId,topic:"scope.row.calculated"};
  });
}
