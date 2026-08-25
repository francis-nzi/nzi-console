import { createHash, randomUUID } from "node:crypto";
import { commandDefinitions, isAllowedJobStageTransition, validateCommand, type CommandContext, type CommandInputMap, type CommandKey, type CommandOutcome, type WorkflowJobFamily } from "@nzi/contracts";
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
