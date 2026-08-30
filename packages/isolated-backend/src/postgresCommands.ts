import { createHash, randomUUID } from "node:crypto";
import { crpProfessionalManifest,resolveCrpCoreCharts,validateManifest } from "@nzi/charts";
import {
  commandDefinitions,
  crpScopeCategoryPath,
  isAllowedJobStageTransition,
  validateCommand,
  type CommandContext,
  type CommandInputMap,
  type CommandKey,
  type CommandOutcome,
  type ScopeQualityTier,
  type ScopeRowWriteFields,
  type WorkflowJobFamily,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantWrite } from "./postgres";

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different request.");
    this.name = "IdempotencyConflictError";
  }
}
export class CommandValidationError extends Error {
  constructor(readonly issues: ReturnType<typeof validateCommand>) {
    super("Command validation failed.");
    this.name = "CommandValidationError";
  }
}
type CommandResult<T extends Record<string, unknown>> = {
  data: T;
  entityType: string;
  entityId: string;
  topic: string;
};
type StoredOutcome<T extends Record<string, unknown>> = Extract<
  CommandOutcome<T>,
  { state: "success" }
>;

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
const requestHash = (key: CommandKey, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable({ key, input })))
    .digest("hex");

export function runPostgresCommand(
  pool:PoolLike,
  key:"emission.source.sync",
  input:CommandInputMap["emission.source.sync"],
  context:CommandContext,
  handler:(db:Queryable)=>Promise<CommandResult<{rowId:string;sourceId:string;created:boolean;version:number}>>,
):Promise<StoredOutcome<{rowId:string;sourceId:string;created:boolean;version:number}>>;
export function runPostgresCommand<
  K extends CommandKey,
  T extends Record<string, unknown>,
>(
  pool: PoolLike,
  key: K,
  input: CommandInputMap[K],
  context: CommandContext,
  handler: (db: Queryable) => Promise<CommandResult<T>>,
): Promise<StoredOutcome<T>>;
export async function runPostgresCommand(
  pool:PoolLike,
  key:CommandKey,
  input:CommandInputMap[CommandKey],
  context:CommandContext,
  handler:(db:Queryable)=>Promise<CommandResult<Record<string,unknown>>>,
):Promise<StoredOutcome<Record<string,unknown>>> {
  return withTenantWrite(pool, context.organisationId, (db) =>
    runPostgresCommandInTransaction(db, key, input, context, handler),
  );
}

export async function runPostgresCommandInTransaction<
  K extends CommandKey,
  T extends Record<string, unknown>,
>(
  db: Queryable,
  key: K,
  input: CommandInputMap[K],
  context: CommandContext,
  handler: (db: Queryable) => Promise<CommandResult<T>>,
): Promise<StoredOutcome<T>> {
  const issues = validateCommand(key, input, context);
  if (issues.length) throw new CommandValidationError(issues);
  const hash = requestHash(key, input);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${context.organisationId}:${context.idempotencyKey}`,
  ]);
  const replay = await db.query<{
    request_hash: string;
    outcome_json: StoredOutcome<T>;
  }>(
    `SELECT request_hash, outcome_json
    FROM nzi_console.command_idempotency WHERE organisation_id=$1 AND idempotency_key=$2`,
    [context.organisationId, context.idempotencyKey],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].request_hash !== hash)
      throw new IdempotencyConflictError();
    return { ...replay.rows[0].outcome_json, replayed: true };
  }
  const result = await handler(db);
  const auditEventId = randomUUID();
  const outcome: StoredOutcome<T> = {
    state: "success",
    data: result.data,
    auditEventId,
    correlationId: context.correlationId,
    replayed: false,
  };
  await db.query(
    `INSERT INTO nzi_console.audit_events
    (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      context.organisationId,
      auditEventId,
      context.actorId,
      context.principal,
      commandDefinitions[key].auditAction,
      result.entityType,
      result.entityId,
      context.correlationId,
      context.reason ?? null,
      JSON.stringify(result.data),
    ],
  );
  await db.query(
    `INSERT INTO nzi_console.transactional_outbox
    (organisation_id, outbox_id, topic, payload_json, correlation_id) VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [
      context.organisationId,
      randomUUID(),
      result.topic,
      JSON.stringify(result.data),
      context.correlationId,
    ],
  );
  await db.query(
    `INSERT INTO nzi_console.command_idempotency
    (organisation_id, idempotency_key, command_key, request_hash, outcome_json) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [
      context.organisationId,
      context.idempotencyKey,
      key,
      hash,
      JSON.stringify(outcome),
    ],
  );
  return outcome;
}

export type CreateClientResult = {
  clientId: string;
  name: string;
  status: CommandInputMap["client.create"]["status"];
};
export async function createClient(
  pool: PoolLike,
  input: CommandInputMap["client.create"],
  context: CommandContext,
): Promise<StoredOutcome<CreateClientResult>> {
  return runPostgresCommand(
    pool,
    "client.create",
    input,
    context,
    async (db) => {
      const clientId = randomUUID();
      await db.query(
        `INSERT INTO nzi_console.clients
      (organisation_id, client_id, name, status, sector, location, owner_name, member_since, completeness_percent, next_report_due_label, contact_name, contact_role, contact_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,extract(year from current_date)::int,0,'Not scheduled','','','')`,
        [
          context.organisationId,
          clientId,
          input.name.trim(),
          input.status,
          input.sector.trim(),
          input.location.trim(),
          input.owner.trim(),
        ],
      );
      return {
        data: { clientId, name: input.name.trim(), status: input.status },
        entityType: "client",
        entityId: clientId,
        topic: "client.created",
      };
    },
  );
}

export type CreateJobResult = {
  jobId: string;
  jobNumber: string;
  sequence: number;
  clientId: string;
  family: CommandInputMap["job.create"]["family"];
};
export async function createJob(
  pool: PoolLike,
  input: CommandInputMap["job.create"],
  context: CommandContext,
): Promise<StoredOutcome<CreateJobResult>> {
  return runPostgresCommand(pool, "job.create", input, context, async (db) => {
    const jobId = randomUUID();
    const allocated = await db.query<{ sequence: number }>(
      "SELECT nzi_console.allocate_job_sequence() AS sequence",
    );
    const sequence = allocated.rows[0]!.sequence;
    const detail =
      input.family === "crp"
        ? {
            kind: "crp",
            reportingPeriod: `${input.startDate}–${input.dueDate}`,
            includedScopes: [],
            reviewedRows: 0,
            totalRows: 0,
          }
        : input.family === "consultancy"
          ? {
              kind: "consultancy",
              scope: "",
              deliverables: [],
              plannedDays: 0,
              usedDays: 0,
            }
          : input.family === "lca"
            ? {
                kind: "lca",
                assessment: "",
                boundary: "",
                bomLines: 0,
                scenarios: 0,
              }
            : input.family === "pcf"
              ? {
                  kind: "pcf",
                  product: "",
                  functionalUnit: "",
                  bomLines: 0,
                  readinessPct: 0,
                }
              : {
                  kind: "training",
                  course: "",
                  sessions: 0,
                  bookings: 0,
                  attendancePct: 0,
                };
    const inserted = await db.query<{ job_number: string }>(
      `INSERT INTO nzi_console.jobs
      (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, owner_name, start_date, due_date, progress_percent, detail_json)
      VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,0,$12::jsonb) RETURNING job_number`,
      [
        context.organisationId,
        jobId,
        input.clientId,
        sequence,
        input.family,
        input.title.trim(),
        input.workflowStage.trim(),
        input.reportingYear ?? null,
        input.owner.trim(),
        input.startDate,
        input.dueDate,
        JSON.stringify(detail),
      ],
    );
    if (input.family === "crp") {
      const reportingFrom = input.reportingYear
        ? `${input.reportingYear}-01-01`
        : input.startDate;
      const reportingTo = input.reportingYear
        ? `${input.reportingYear}-12-31`
        : input.dueDate;
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
        [context.organisationId, jobId, reportingFrom, reportingTo],
      );
      await db.query(
        `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
        SELECT $1,$2,d.dataset_id,'automatic','Matched reporting period and geography.',$5 FROM nzi_console.emission_factor_datasets d
        WHERE d.organisation_id=$1 AND d.status='active' AND d.valid_from<=$3 AND d.valid_to>=$4 AND d.country_code IN ('GB','GLOBAL')
        ON CONFLICT DO NOTHING`,
        [
          context.organisationId,
          jobId,
          reportingFrom,
          reportingTo,
          context.actorId,
        ],
      );
    }
    return {
      data: {
        jobId,
        jobNumber: inserted.rows[0]!.job_number,
        sequence,
        clientId: input.clientId,
        family: input.family,
      },
      entityType: "job",
      entityId: jobId,
      topic: "job.created",
    };
  });
}

export type ChangeJobStageResult = {
  jobId: string;
  fromStage: string;
  toStage: string;
  version: number;
  stageEventId: string;
};
export async function changeJobStage(
  pool: PoolLike,
  input: CommandInputMap["job.stage.change"],
  context: CommandContext,
): Promise<StoredOutcome<ChangeJobStageResult>> {
  return runPostgresCommand(
    pool,
    "job.stage.change",
    input,
    context,
    async (db) => {
      const found = await db.query<{
        job_family: WorkflowJobFamily;
        workflow_stage: string;
        version: number;
      }>(
        "SELECT job_family, workflow_stage, version FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE",
        [context.organisationId, input.jobId],
      );
      const job = found.rows[0];
      if (!job)
        throw new CommandValidationError([
          { field: "jobId", code: "NOT_FOUND", message: "Job was not found." },
        ]);
      if (
        job.version !== input.expectedVersion ||
        job.workflow_stage !== input.fromStage
      )
        throw new VersionConflictError();
      if (
        !isAllowedJobStageTransition(
          job.job_family,
          input.fromStage,
          input.toStage,
        )
      ) {
        throw new CommandValidationError([
          {
            field: "toStage",
            code: "INVALID_TRANSITION",
            message: "Move to an adjacent workflow stage.",
          },
        ]);
      }
      const stageEventId = randomUUID();
      await db.query(
        `INSERT INTO nzi_console.job_stage_history
      (organisation_id, stage_event_id, job_id, from_stage, to_stage, actor_id, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          context.organisationId,
          stageEventId,
          input.jobId,
          input.fromStage,
          input.toStage,
          context.actorId,
          input.note?.trim() || null,
        ],
      );
      const updated = await db.query<{ version: number }>(
        `UPDATE nzi_console.jobs SET workflow_stage=$3,
      version=version+1, updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND version=$4 RETURNING version`,
        [
          context.organisationId,
          input.jobId,
          input.toStage,
          input.expectedVersion,
        ],
      );
      if (!updated.rows[0]) throw new VersionConflictError();
      return {
        data: {
          jobId: input.jobId,
          fromStage: input.fromStage,
          toStage: input.toStage,
          version: updated.rows[0].version,
          stageEventId,
        },
        entityType: "job",
        entityId: input.jobId,
        topic: "job.stage.changed",
      };
    },
  );
}

const scopeEvidence = (
  input: ScopeRowWriteFields,
  context: CommandContext,
) => ({
  provenance: {
    capturedBy: context.actorId,
    capturedAt: new Date().toISOString(),
    datasetId: input.datasetId,
    factorId: input.factorId,
    factorVersion: input.factorVersion,
    qualityTier: input.qualityTier,
    overrideTco2e: input.overrideTco2e,
    overrideReason: input.overrideReason,
    assetIdentifier: input.assetIdentifier?.trim() || null,
    factorSource:input.factorSource??"dataset",
    clientFactorId:input.clientFactorId??null,
    applyPct:input.applyPct??100,
    dataConfidence:input.dataConfidence??null,
    sourceQuantity:input.sourceQuantity??null,
    sourceUnit:input.sourceUnit?.trim()||null,
    columnText:input.columnText?.trim()||null,
    reportLabel: input.reportLabel?.trim() || input.sourceLabel.trim(),
    categoryPath: crpScopeCategoryPath(input.scope),
    monthlyActivity: input.monthlyActivity ?? [],
  },
  lineage: [
    ...(input.quantity === null
      ? []
      : [
          {
            title: "Activity data captured",
            detail: `${input.quantity}${input.unit ? ` ${input.unit}` : ""}`,
          },
        ]),
    ...((input.monthlyActivity?.length??0)>0?[{title:"Monthly activity captured",detail:`${input.monthlyActivity!.filter(slot=>slot.quantity!==null).length}/${input.monthlyActivity!.length} months populated · annual roll-up ${input.quantity??0}${input.unit?` ${input.unit}`:""}`}]:[]),
    ...(input.factorId
      ? [
          {
            title: "Factor selected",
            detail: `${input.factorLabel ?? input.factorId}${input.factorVersion ? ` · ${input.factorVersion}` : ""}`,
          },
        ]
      : []),
    ...(input.overrideTco2e == null
      ? []
      : [{ title: "Calculated result overridden", detail: `${input.overrideTco2e} tCO₂e · ${input.overrideReason}` }]),
  ],
});
async function requireCrpJob(
  db: Queryable,
  organisationId: string,
  jobId: string,
) {
  const found = await db.query<{ job_family: string }>(
    "SELECT job_family FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2",
    [organisationId, jobId],
  );
  if (!found.rows[0])
    throw new CommandValidationError([
      { field: "jobId", code: "NOT_FOUND", message: "Job was not found." },
    ]);
  if (found.rows[0].job_family !== "crp")
    throw new CommandValidationError([
      {
        field: "jobId",
        code: "WRONG_FAMILY",
        message: "Scope rows are available only for CRP jobs.",
      },
    ]);
}
function reportingMonths(from:string,to:string):string[]{const months:string[]=[];const cursor=new Date(`${from.slice(0,7)}-01T00:00:00Z`),end=to.slice(0,7);while(cursor.toISOString().slice(0,7)<=end){months.push(cursor.toISOString().slice(0,7));cursor.setUTCMonth(cursor.getUTCMonth()+1);}return months;}
async function resolveMonthlyActivity(db:Queryable,organisationId:string,jobId:string,input:ScopeRowWriteFields){const slots=input.monthlyActivity??[];if(!slots.length)return{slots:[],quantity:input.quantity};const config=await db.query<{reporting_from:Date|string;reporting_to:Date|string}>(`SELECT reporting_from,reporting_to FROM nzi_console.job_emissions_config WHERE organisation_id=$1 AND job_id=$2`,[organisationId,jobId]);const row=config.rows[0];if(!row)throw new CommandValidationError([{field:"monthlyActivity",code:"REPORTING_PERIOD_MISSING",message:"Configure the CRP reporting period before entering monthly activity."}]);const dateOnly=(value:Date|string)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10),expected=reportingMonths(dateOnly(row.reporting_from),dateOnly(row.reporting_to)),actual=slots.map(slot=>slot.month);if(expected.length!==actual.length||expected.some((month,index)=>month!==actual[index]))throw new CommandValidationError([{field:"monthlyActivity",code:"REPORTING_PERIOD_MISMATCH",message:"Monthly activity must contain each reporting-period month once, in order."}]);const populated=slots.filter(slot=>slot.quantity!==null);return{slots,quantity:populated.length?populated.reduce((sum,slot)=>sum+(slot.quantity??0),0):null};}
async function requireSiteForJob(db:Queryable,organisationId:string,jobId:string,siteId:string|null){if(!siteId)return;const found=await db.query(`SELECT 1 FROM nzi_console.client_sites s JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(s.organisation_id,s.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2 AND s.site_id=$3`,[organisationId,jobId,siteId]);if(!found.rows[0])throw new CommandValidationError([{field:"siteId",code:"NOT_FOUND",message:"Site was not found for this job's client."}]);}

export async function createClientSite(pool:PoolLike,input:CommandInputMap["site.create"],context:CommandContext):Promise<StoredOutcome<{siteId:string;name:string}>>{return runPostgresCommand(pool,"site.create",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const job=await db.query<{client_id:string}>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`,[context.organisationId,input.jobId]),siteId=randomUUID(),name=input.name.trim();try{await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,site_id,client_id,name,created_by) VALUES ($1,$2,$3,$4,$5)`,[context.organisationId,siteId,job.rows[0]!.client_id,name,context.actorId]);}catch(error){if(error&&typeof error==="object"&&"code" in error&&(error as {code?:string}).code==="23505")throw new CommandValidationError([{field:"name",code:"DUPLICATE",message:"That client site already exists."}]);throw error;}return{data:{siteId,name},entityType:"client_site",entityId:siteId,topic:"client.site.created"};});}

async function requirePurchasedGoodsCategory(db:Queryable,organisationId:string,jobId:string,scope:string,categoryId:string|null){if(!categoryId)return;if(scope!=="3.1")throw new CommandValidationError([{field:"purchasedGoodsCategoryId",code:"WRONG_SCOPE",message:"Purchased-goods categories apply only to Scope 3.1 rows."}]);const found=await db.query(`SELECT 1 FROM nzi_console.purchased_goods_categories c JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(c.organisation_id,c.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2 AND c.category_id=$3`,[organisationId,jobId,categoryId]);if(!found.rows[0])throw new CommandValidationError([{field:"purchasedGoodsCategoryId",code:"NOT_FOUND",message:"Purchased-goods category was not found for this client."}]);}
export async function createPurchasedGoodsCategory(pool:PoolLike,input:CommandInputMap["purchased.goods.category.create"],context:CommandContext):Promise<StoredOutcome<{categoryId:string;name:string}>>{return runPostgresCommand(pool,"purchased.goods.category.create",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const job=await db.query<{client_id:string}>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`,[context.organisationId,input.jobId]),categoryId=randomUUID(),name=input.name.trim();try{await db.query(`INSERT INTO nzi_console.purchased_goods_categories(organisation_id,category_id,client_id,name,created_by) VALUES($1,$2,$3,$4,$5)`,[context.organisationId,categoryId,job.rows[0]!.client_id,name,context.actorId]);}catch(error){if(error&&typeof error==="object"&&"code" in error&&(error as {code?:string}).code==="23505")throw new CommandValidationError([{field:"name",code:"DUPLICATE",message:"That purchased-goods category already exists."}]);throw error;}return{data:{categoryId,name},entityType:"purchased_goods_category",entityId:categoryId,topic:"purchased.goods.category.created"};});}

export async function createClientFactor(pool:PoolLike,input:CommandInputMap["client.factor.create"],context:CommandContext):Promise<StoredOutcome<{clientFactorId:string;label:string}>>{return runPostgresCommand(pool,"client.factor.create",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const job=await db.query<{client_id:string}>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`,[context.organisationId,input.jobId]),clientFactorId=randomUUID(),label=input.reportLabel.trim();await db.query(`INSERT INTO nzi_console.client_factors(organisation_id,client_factor_id,client_id,job_id,scope,category_path_json,report_label,description,unit,ghg_unit,kgco2e_per_unit,geography,vintage_year,source,evidence_file_name,evidence_storage_provider,evidence_url,evidence_external_item_id,evidence_hash,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'kgCO2e',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[context.organisationId,clientFactorId,job.rows[0]!.client_id,input.reusable?null:input.jobId,input.scope,JSON.stringify(crpScopeCategoryPath(input.scope)),label,input.description.trim(),input.unit.trim(),input.kgco2ePerUnit,input.geography.trim().toUpperCase(),input.vintageYear,input.source.trim(),input.evidenceFileName?.trim()||null,input.evidenceStorageProvider,input.evidenceUrl?.trim()||null,input.evidenceExternalItemId?.trim()||null,input.evidenceHash?.trim()||null,context.actorId]);return{data:{clientFactorId,label},entityType:"client_factor",entityId:clientFactorId,topic:"client.factor.created"};});}

export async function createEmissionSourceGroup(pool:PoolLike,input:CommandInputMap["emission.source.group.create"],context:CommandContext):Promise<StoredOutcome<{groupId:string;name:string}>>{return runPostgresCommand(pool,"emission.source.group.create",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const groupId=randomUUID(),name=input.name.trim();await db.query(`INSERT INTO nzi_console.job_emission_groups(organisation_id,group_id,job_id,name,created_by) VALUES($1,$2,$3,$4,$5)`,[context.organisationId,groupId,input.jobId,name,context.actorId]);return{data:{groupId,name},entityType:"emission_source_group",entityId:groupId,topic:"emission.source.group.created"};});}

export async function createEmissionSource(pool:PoolLike,input:CommandInputMap["emission.source.create"],context:CommandContext):Promise<StoredOutcome<{sourceId:string;sourceName:string}>>{return runPostgresCommand(pool,"emission.source.create",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);if(input.groupId){const group=await db.query(`SELECT 1 FROM nzi_console.job_emission_groups WHERE organisation_id=$1 AND job_id=$2 AND group_id=$3`,[context.organisationId,input.jobId,input.groupId]);if(!group.rows[0])throw new CommandValidationError([{field:"groupId",code:"NOT_FOUND",message:"Source group was not found for this job."}]);}await requireSiteForJob(db,context.organisationId,input.jobId,input.siteId);if(input.factorSource==="client"&&input.clientFactorId){const factor=await db.query(`SELECT 1 FROM nzi_console.client_factors cf JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2 AND cf.client_factor_id=$3 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false`,[context.organisationId,input.jobId,input.clientFactorId]);if(!factor.rows[0])throw new CommandValidationError([{field:"clientFactorId",code:"NOT_FOUND",message:"Client factor was not found for this job."}]);}if(input.factorSource==="dataset"&&input.factorId){const factor=await db.query(`SELECT 1 FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.organisation_id=$1 AND s.job_id=$2 AND f.factor_id=$3 AND f.dataset_id=$4 AND f.active=true`,[context.organisationId,input.jobId,input.factorId,input.datasetId]);if(!factor.rows[0])throw new CommandValidationError([{field:"factorId",code:"NOT_FOUND",message:"Factor was not found in the job's selected datasets."}]);}const sourceId=randomUUID(),sourceName=input.sourceName.trim();await db.query(`INSERT INTO nzi_console.job_emission_sources(organisation_id,source_id,job_id,group_id,scope,source_type,source_subtype,site_id,source_name,asset_identifier,dataset_id,factor_id,factor_source,client_factor_id,quantity,unit,apply_pct,data_source,data_confidence,monthly_activity_json,detail_json,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22)`,[context.organisationId,sourceId,input.jobId,input.groupId,input.scope,input.sourceType,input.sourceSubtype?.trim()||null,input.siteId,sourceName,input.assetIdentifier?.trim()||null,input.datasetId,input.factorId,input.factorSource,input.clientFactorId,input.quantity,input.unit?.trim()||null,input.applyPct,input.dataSource.trim(),input.dataConfidence,JSON.stringify(input.monthlyActivity),JSON.stringify(input.detail),input.notes?.trim()||null]);return{data:{sourceId,sourceName},entityType:"emission_source",entityId:sourceId,topic:"emission.source.created"};});}

export async function updateEmissionSourceActivity(pool:PoolLike,input:CommandInputMap["emission.source.activity.update"],context:CommandContext):Promise<StoredOutcome<{sourceId:string;version:number}>>{return runPostgresCommand(pool,"emission.source.activity.update",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const updated=await db.query<{version:number}>(`UPDATE nzi_console.job_emission_sources SET quantity=$5,unit=$6,apply_pct=$7,data_confidence=$8,notes=$9,calculated_tco2e=NULL,review_status='pending',version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND source_id=$3 AND version=$4 AND enabled=true RETURNING version`,[context.organisationId,input.jobId,input.sourceId,input.expectedVersion,input.quantity,input.unit?.trim()||null,input.applyPct,input.dataConfidence,input.notes?.trim()||null]);if(!updated.rows[0]){const current=await db.query<{version:number}>(`SELECT version FROM nzi_console.job_emission_sources WHERE organisation_id=$1 AND job_id=$2 AND source_id=$3`,[context.organisationId,input.jobId,input.sourceId]);if(current.rows[0])throw new VersionConflictError(input.expectedVersion,current.rows[0].version);throw new CommandValidationError([{field:"sourceId",code:"NOT_FOUND",message:"Enabled emission source was not found for this job."}]);}return{data:{sourceId:input.sourceId,version:updated.rows[0].version},entityType:"emission_source",entityId:input.sourceId,topic:"emission.source.activity.updated"};});}

export async function syncEmissionSourceToScope(pool:PoolLike,input:CommandInputMap["emission.source.sync"],context:CommandContext):Promise<StoredOutcome<{rowId:string;sourceId:string;created:boolean;version:number}>>{return runPostgresCommand(pool,"emission.source.sync",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const found=await db.query<{source_id:string;scope:string;source_name:string;site_id:string|null;asset_identifier:string|null;dataset_id:string|null;factor_id:string|null;factor_source:"dataset"|"client";client_factor_id:string|null;quantity:string|null;unit:string|null;apply_pct:string;data_source:string;data_confidence:"H"|"M"|"L"|null;monthly_activity_json:unknown;detail_json:unknown;notes:string|null;factor_label:string|null;factor_version:string|null}>(`SELECT s.source_id,s.scope,s.source_name,s.site_id,s.asset_identifier,s.dataset_id,s.factor_id,s.factor_source,s.client_factor_id,s.quantity,s.unit,s.apply_pct,s.data_source,s.data_confidence,s.monthly_activity_json,s.detail_json,s.notes,coalesce(cf.report_label,f.label) AS factor_label,coalesce('v'||cf.version::text,d.version) AS factor_version FROM nzi_console.job_emission_sources s LEFT JOIN nzi_console.client_factors cf ON (cf.organisation_id,cf.client_factor_id)=(s.organisation_id,s.client_factor_id) LEFT JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id,f.factor_id)=(s.organisation_id,s.dataset_id,s.factor_id) LEFT JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.organisation_id=$1 AND s.job_id=$2 AND s.source_id=$3 AND s.enabled=true FOR UPDATE OF s`,[context.organisationId,input.jobId,input.sourceId]),source=found.rows[0];if(!source)throw new CommandValidationError([{field:"sourceId",code:"NOT_FOUND",message:"Enabled emission source was not found for this job."}]);const existing=await db.query<{scope_row_id:string;version:number}>(`SELECT scope_row_id,version FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND source_id=$3 FOR UPDATE`,[context.organisationId,input.jobId,input.sourceId]),rowId=existing.rows[0]?.scope_row_id??randomUUID(),categoryPath=crpScopeCategoryPath(source.scope),quantity=source.quantity===null?null:Number(source.quantity),applyPct=Number(source.apply_pct),provenance=JSON.stringify({sourceId:source.source_id,sourceType:"register",dataSource:source.data_source,detail:source.detail_json,factorSource:source.factor_source,clientFactorId:source.client_factor_id,applyPct}),lineage=JSON.stringify([{title:"Synced from source register",detail:`${source.source_name} · ${source.source_id}`}]);if(existing.rows[0]){const updated=await db.query<{version:number}>(`UPDATE nzi_console.job_scope_rows SET scope=$4,source_label=$5,site_id=$6,quantity=$7,unit=$8,dataset_id=$9,factor_id=$10,factor_version=$11,factor_label=$12,quality_tier=NULL,calculated_tco2e=NULL,override_tco2e=NULL,override_reason=NULL,review_status='pending',reviewed_row_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,provenance_json=$13::jsonb,lineage_json=$14::jsonb,report_label=$5,level_1=$15,level_2=$16,level_3=NULL,level_4=NULL,monthly_activity_json=$17::jsonb,notes=$18,asset_identifier=$19,factor_source=$20,client_factor_id=$21,is_custom_entry=$22,apply_pct=$23,data_confidence=$24,source_quantity=$7,source_unit=$8,is_auto_generated=true,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND source_id=$3 RETURNING version`,[context.organisationId,input.jobId,input.sourceId,source.scope,source.source_name,source.site_id,quantity,source.unit,source.dataset_id,source.factor_id,source.factor_version,source.factor_label,provenance,lineage,categoryPath[0],categoryPath[1],JSON.stringify(source.monthly_activity_json??[]),source.notes,source.asset_identifier,source.factor_source,source.client_factor_id,source.factor_source==="client",applyPct,source.data_confidence]);return{data:{rowId,sourceId:source.source_id,created:false,version:updated.rows[0]!.version},entityType:"scope_row",entityId:rowId,topic:"emission.source.synced"};}await db.query(`INSERT INTO nzi_console.job_scope_rows(organisation_id,scope_row_id,job_id,scope,source_label,site_id,quantity,unit,dataset_id,factor_id,factor_version,factor_label,provenance_json,lineage_json,report_label,level_1,level_2,monthly_activity_json,notes,asset_identifier,factor_source,client_factor_id,is_custom_entry,apply_pct,data_confidence,source_quantity,source_unit,source_id,is_auto_generated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$5,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$7,$8,$25,true)`,[context.organisationId,rowId,input.jobId,source.scope,source.source_name,source.site_id,quantity,source.unit,source.dataset_id,source.factor_id,source.factor_version,source.factor_label,provenance,lineage,categoryPath[0],categoryPath[1],JSON.stringify(source.monthly_activity_json??[]),source.notes,source.asset_identifier,source.factor_source,source.client_factor_id,source.factor_source==="client",applyPct,source.data_confidence,source.source_id]);return{data:{rowId,sourceId:source.source_id,created:true,version:1},entityType:"scope_row",entityId:rowId,topic:"emission.source.synced"};});}

export type CreateScopeRowResult = {
  rowId: string;
  jobId: string;
  version: number;
};
export async function createScopeRow(
  pool: PoolLike,
  input: CommandInputMap["scope.row.create"],
  context: CommandContext,
): Promise<StoredOutcome<CreateScopeRowResult>> {
  return runPostgresCommand(
    pool,
    "scope.row.create",
    input,
    context,
    async (db) => {
      await requireCrpJob(db, context.organisationId, input.jobId);
      await requireSiteForJob(db,context.organisationId,input.jobId,input.siteId??null);
      await requirePurchasedGoodsCategory(db,context.organisationId,input.jobId,input.scope,input.purchasedGoodsCategoryId??null);
      const rowId = randomUUID();
      const activity=await resolveMonthlyActivity(db,context.organisationId,input.jobId,input);
      const evidence = scopeEvidence({...input,quantity:activity.quantity,monthlyActivity:activity.slots}, context);
      const categoryPath = crpScopeCategoryPath(input.scope);
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows
      (organisation_id,scope_row_id,job_id,scope,source_label,site_id,purchased_goods_category_id,quantity,unit,dataset_id,factor_id,factor_version,factor_label,quality_tier,override_tco2e,override_reason,provenance_json,lineage_json,report_label,level_1,level_2,monthly_activity_json,notes,asset_identifier,factor_source,client_factor_id,is_custom_entry,apply_pct,data_confidence,source_quantity,source_unit,column_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
        [
          context.organisationId,
          rowId,
          input.jobId,
          input.scope,
          input.sourceLabel.trim(),
          input.siteId??null,
          input.purchasedGoodsCategoryId??null,
          activity.quantity,
          input.unit?.trim() || null,
          input.datasetId,
          input.factorId,
          input.factorVersion,
          input.factorLabel,
          input.qualityTier,
          input.overrideTco2e ?? null,
          input.overrideReason?.trim() || null,
          JSON.stringify(evidence.provenance),
          JSON.stringify(evidence.lineage),
          input.reportLabel?.trim() || input.sourceLabel.trim(),
          categoryPath[0],
          categoryPath[1],
          JSON.stringify(activity.slots),
          input.notes?.trim()||null,
          input.assetIdentifier?.trim()||null,
          input.factorSource??"dataset",
          input.clientFactorId??null,
          input.isCustomEntry??false,
          input.applyPct??100,
          input.dataConfidence??null,
          input.sourceQuantity??null,
          input.sourceUnit?.trim()||null,
          input.columnText?.trim()||null,
        ],
      );
      return {
        data: { rowId, jobId: input.jobId, version: 1 },
        entityType: "scope_row",
        entityId: rowId,
        topic: "scope.row.created",
      };
    },
  );
}

export type UpdateScopeRowResult = {
  rowId: string;
  jobId: string;
  version: number;
};
export async function updateScopeRow(
  pool: PoolLike,
  input: CommandInputMap["scope.row.update"],
  context: CommandContext,
): Promise<StoredOutcome<UpdateScopeRowResult>> {
  return runPostgresCommand(
    pool,
    "scope.row.update",
    input,
    context,
    async (db) => {
      await requireCrpJob(db, context.organisationId, input.jobId);
      await requireSiteForJob(db,context.organisationId,input.jobId,input.siteId??null);
      await requirePurchasedGoodsCategory(db,context.organisationId,input.jobId,input.scope,input.purchasedGoodsCategoryId??null);
      const activity=await resolveMonthlyActivity(db,context.organisationId,input.jobId,input);
      const evidence = scopeEvidence({...input,quantity:activity.quantity,monthlyActivity:activity.slots}, context);
      const categoryPath = crpScopeCategoryPath(input.scope);
      const updated = await db.query<{ version: number }>(
        `UPDATE nzi_console.job_scope_rows SET scope=$4,source_label=$5,site_id=$6,purchased_goods_category_id=$7,
      quantity=$8,unit=$9,dataset_id=$10,factor_id=$11,factor_version=$12,factor_label=$13,quality_tier=$14,override_tco2e=$15,override_reason=$16,
      provenance_json=$17::jsonb,lineage_json=$18::jsonb,enabled=$19,calculated_tco2e=NULL,review_status='pending',reviewed_row_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,
      report_label=$21,level_1=$22,level_2=$23,level_3=NULL,level_4=NULL,monthly_activity_json=$24::jsonb,notes=$25,asset_identifier=$26,factor_source=$27,client_factor_id=$28,is_custom_entry=$29,apply_pct=$30,data_confidence=$31,source_quantity=$32,source_unit=$33,column_text=$34,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$20 RETURNING version`,
        [
          context.organisationId,
          input.jobId,
          input.rowId,
          input.scope,
          input.sourceLabel.trim(),
          input.siteId??null,
          input.purchasedGoodsCategoryId??null,
          activity.quantity,
          input.unit?.trim() || null,
          input.datasetId,
          input.factorId,
          input.factorVersion,
          input.factorLabel,
          input.qualityTier,
          input.overrideTco2e ?? null,
          input.overrideReason?.trim() || null,
          JSON.stringify(evidence.provenance),
          JSON.stringify(evidence.lineage),
          input.enabled,
          input.expectedVersion,
          input.reportLabel?.trim() || input.sourceLabel.trim(),
          categoryPath[0],
          categoryPath[1],
          JSON.stringify(activity.slots),
          input.notes?.trim()||null,
          input.assetIdentifier?.trim()||null,
          input.factorSource??"dataset",
          input.clientFactorId??null,
          input.isCustomEntry??false,
          input.applyPct??100,
          input.dataConfidence??null,
          input.sourceQuantity??null,
          input.sourceUnit?.trim()||null,
          input.columnText?.trim()||null,
        ],
      );
      if (!updated.rows[0]) throw new VersionConflictError();
      return {
        data: {
          rowId: input.rowId,
          jobId: input.jobId,
          version: updated.rows[0].version,
        },
        entityType: "scope_row",
        entityId: input.rowId,
        topic: "scope.row.updated",
      };
    },
  );
}

export type CalculateScopeRowResult = {
  rowId: string;
  jobId: string;
  version: number;
  calculatedTco2e: number;
};
export async function calculateScopeRow(
  pool: PoolLike,
  input: CommandInputMap["scope.row.calculate"],
  context: CommandContext,
): Promise<StoredOutcome<CalculateScopeRowResult>> {
  return runPostgresCommand(
    pool,
    "scope.row.calculate",
    input,
    context,
    async (db) => {
      await requireCrpJob(db, context.organisationId, input.jobId);
      const found = await db.query<{
        version: number;
        quantity: string | null;
        unit: string | null;
        scope: string;
        dataset_id: string | null;
        factor_id: string | null;
        factor_source:"dataset"|"client";
        client_factor_id:string|null;
        override_tco2e: string | null;
        override_reason: string | null;
        monthly_activity_json:Array<{month:string;quantity:number|null}>;
      }>(
        `SELECT version,quantity,unit,scope,dataset_id,factor_id,factor_source,client_factor_id,override_tco2e,override_reason,monthly_activity_json FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 FOR UPDATE`,
        [context.organisationId, input.jobId, input.rowId],
      );
      const row = found.rows[0];
      if (!row)
        throw new CommandValidationError([
          {
            field: "rowId",
            code: "NOT_FOUND",
            message: "Scope row was not found.",
          },
        ]);
      if (row.version !== input.expectedVersion)
        throw new VersionConflictError();
      if (
        row.quantity === null ||
        !row.unit ||
        !row.factor_id ||
        (row.factor_source==="dataset"&&!row.dataset_id) ||
        (row.factor_source==="client"&&!row.client_factor_id)
      )
        throw new CommandValidationError([
          {
            field: "rowId",
            code: "INCOMPLETE",
            message:
              "Quantity, unit and a selected factor are required before calculation.",
          },
        ]);
      const factor = row.factor_source==="client"?await db.query<{
        label: string;
        activity_unit: string;
        kgco2e_per_unit: string;
        version: string;
        synthetic: boolean;
        evidence_hash:string|null;
      }>(`SELECT cf.report_label AS label,cf.unit AS activity_unit,cf.kgco2e_per_unit::text,cf.version::text,false AS synthetic,cf.evidence_hash FROM nzi_console.client_factors cf JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id) WHERE cf.organisation_id=$1 AND j.job_id=$2 AND cf.client_factor_id=$3 AND cf.scope=$4 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false`,[context.organisationId,input.jobId,row.client_factor_id,row.scope]):await db.query<{
        label: string;
        activity_unit: string;
        kgco2e_per_unit: string;
        version: string;
        synthetic: boolean;
        evidence_hash:string|null;
      }>(
        `SELECT f.label,f.activity_unit,f.kgco2e_per_unit,d.version,d.synthetic,NULL::text AS evidence_hash FROM nzi_console.emission_factors f
      JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(f.organisation_id,f.dataset_id)
      JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id) AND s.job_id=$2
      WHERE f.organisation_id=$1 AND f.dataset_id=$3 AND f.factor_id=$4 AND f.active=true AND (split_part($5,'.',1)=ANY(f.scopes))`,
        [
          context.organisationId,
          input.jobId,
          row.dataset_id,
          row.factor_id,
          row.scope,
        ],
      );
      const matched = factor.rows[0];
      if (!matched)
        throw new CommandValidationError([
          {
            field: "factorId",
            code: "NOT_SELECTED",
            message:
              "The factor is not active, selected for this job, or valid for this scope.",
          },
        ]);
      if (
        row.unit.trim().toLowerCase() !==
        matched.activity_unit.trim().toLowerCase()
      )
        throw new CommandValidationError([
          {
            field: "unit",
            code: "UNIT_MISMATCH",
            message: `Activity unit must be ${matched.activity_unit} for the selected factor.`,
          },
        ]);
      const lineage = [
        {
          title: "Activity data captured",
          detail: `${row.quantity} ${row.unit}`,
        },
        {
          title: row.factor_source==="client"?"Client factor resolved":"Factor resolved",
          detail: `${matched.label} · ${matched.version}`,
        },
        {
          title: "Emissions calculated",
          detail: "quantity × kgCO₂e per unit ÷ 1,000",
        },
        ...((row.monthly_activity_json?.length??0)>0?[{title:"Monthly activity retained",detail:`${row.monthly_activity_json.filter(slot=>slot.quantity!==null).length}/${row.monthly_activity_json.length} months populated`}]:[]),
        ...(row.override_tco2e === null
          ? []
          : [{ title: "Calculated result overridden", detail: `${row.override_tco2e} tCO₂e · ${row.override_reason}` }]),
      ];
      const provenance = {
        calculatedBy: context.actorId,
        calculatedAt: new Date().toISOString(),
        datasetId: row.dataset_id,
        factorId: row.factor_id,
        factorSource:row.factor_source,
        clientFactorId:row.client_factor_id,
        evidenceHash:matched.evidence_hash,
        factorVersion: matched.version,
        kgCo2ePerUnit: matched.kgco2e_per_unit,
        synthetic: matched.synthetic,
        monthlyActivity:row.monthly_activity_json??[],
      };
      const updated = await db.query<{
        version: number;
        calculated_tco2e: string;
      }>(
        `UPDATE nzi_console.job_scope_rows SET factor_version=$4,factor_label=$5,calculated_tco2e=quantity*$6::numeric/1000,provenance_json=$7::jsonb,lineage_json=$8::jsonb,review_status='pending',reviewed_row_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$9 RETURNING version,calculated_tco2e`,
        [
          context.organisationId,
          input.jobId,
          input.rowId,
          matched.version,
          matched.label,
          matched.kgco2e_per_unit,
          JSON.stringify(provenance),
          JSON.stringify(lineage),
          input.expectedVersion,
        ],
      );
      if (!updated.rows[0]) throw new VersionConflictError();
      return {
        data: {
          rowId: input.rowId,
          jobId: input.jobId,
          version: updated.rows[0].version,
          calculatedTco2e: Number(updated.rows[0].calculated_tco2e),
        },
        entityType: "scope_row",
        entityId: input.rowId,
        topic: "scope.row.calculated",
      };
    },
  );
}

export type AddManualDatasetResult = {
  jobId: string;
  datasetId: string;
  selectionSource: "manual";
  warnings: string[];
};
export async function addManualDataset(
  pool: PoolLike,
  input: CommandInputMap["dataset.override.add"],
  context: CommandContext,
): Promise<StoredOutcome<AddManualDatasetResult>> {
  return runPostgresCommand(
    pool,
    "dataset.override.add",
    input,
    context,
    async (db) => {
      await requireCrpJob(db, context.organisationId, input.jobId);
      const found = await db.query<{
        valid_from: Date | string;
        valid_to: Date | string;
        dataset_country: string;
        status: string;
        reporting_from: Date | string;
        reporting_to: Date | string;
        job_country: string;
      }>(
        `SELECT d.valid_from,d.valid_to,d.country_code AS dataset_country,d.status,c.reporting_from,c.reporting_to,c.country_code AS job_country
      FROM nzi_console.emission_factor_datasets d JOIN nzi_console.job_emissions_config c ON c.organisation_id=d.organisation_id AND c.job_id=$2
      WHERE d.organisation_id=$1 AND d.dataset_id=$3`,
        [context.organisationId, input.jobId, input.datasetId],
      );
      const item = found.rows[0];
      if (!item)
        throw new CommandValidationError([
          {
            field: "datasetId",
            code: "NOT_FOUND",
            message: "Dataset was not found.",
          },
        ]);
      const day = (value: Date | string) =>
        value instanceof Date
          ? value.toISOString().slice(0, 10)
          : String(value).slice(0, 10);
      const validFrom = day(item.valid_from),
        validTo = day(item.valid_to),
        reportingFrom = day(item.reporting_from),
        reportingTo = day(item.reporting_to);
      const warnings: string[] = [];
      if (validFrom > reportingFrom || validTo < reportingTo)
        warnings.push("Dataset does not cover the complete reporting period.");
      if (
        item.dataset_country !== item.job_country &&
        item.dataset_country !== "GLOBAL"
      )
        warnings.push(
          `Dataset geography ${item.dataset_country} differs from job geography ${item.job_country}.`,
        );
      if (item.status !== "active")
        warnings.push(`Dataset status is ${item.status}.`);
      const inserted = await db.query(
        `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,warnings_json,selected_by) VALUES ($1,$2,$3,'manual',$4,$5::jsonb,$6) ON CONFLICT (organisation_id,job_id,dataset_id) DO NOTHING RETURNING dataset_id`,
        [
          context.organisationId,
          input.jobId,
          input.datasetId,
          context.reason,
          JSON.stringify(warnings),
          context.actorId,
        ],
      );
      if (!inserted.rows[0])
        throw new CommandValidationError([
          {
            field: "datasetId",
            code: "ALREADY_SELECTED",
            message: "Dataset is already selected for this job.",
          },
        ]);
      return {
        data: {
          jobId: input.jobId,
          datasetId: input.datasetId,
          selectionSource: "manual",
          warnings,
        },
        entityType: "job_dataset_selection",
        entityId: `${input.jobId}:${input.datasetId}`,
        topic: "dataset.override.added",
      };
    },
  );
}

export type ReviewScopeRowResult = {
  jobId: string;
  rowId: string;
  decision: "approved" | "rejected";
  version: number;
  reviewEventId: string;
};
async function reviewScopeRow<
  K extends "scope.review.approve" | "scope.review.reject",
>(
  pool: PoolLike,
  key: K,
  input: CommandInputMap[K],
  context: CommandContext,
): Promise<StoredOutcome<ReviewScopeRowResult>> {
  return runPostgresCommand(pool, key, input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    if (input.rowIds.length !== 1)
      throw new CommandValidationError([
        {
          field: "rowIds",
          code: "SINGLE_ROW_REQUIRED",
          message:
            "Review one row at a time so each decision retains its exact version and evidence.",
        },
      ]);
    const rowId = input.rowIds[0]!;
    const found = await db.query<{
      version: number;
      enabled: boolean;
      calculated_tco2e: string | null;
      override_tco2e: string | null;
      quality_tier: string | null;
      provenance_json: Record<string, unknown>;
    }>(
      `SELECT version,enabled,calculated_tco2e,override_tco2e,quality_tier,provenance_json FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 FOR UPDATE`,
      [context.organisationId, input.jobId, rowId],
    );
    const row = found.rows[0];
    if (!row)
      throw new CommandValidationError([
        {
          field: "rowIds",
          code: "NOT_FOUND",
          message: "Scope row was not found.",
        },
      ]);
    if (row.version !== input.expectedReviewVersion)
      throw new VersionConflictError();
    const decision = key === "scope.review.approve" ? "approved" : "rejected";
    if (decision === "approved") {
      if (!row.enabled)
        throw new CommandValidationError([
          {
            field: "rowIds",
            code: "DISABLED",
            message: "A disabled row cannot be approved.",
          },
        ]);
      if (row.calculated_tco2e === null && row.override_tco2e === null)
        throw new CommandValidationError([
          {
            field: "rowIds",
            code: "CALCULATION_REQUIRED",
            message:
              "A calculated or justified override result is required before approval.",
          },
        ]);
      if (!row.quality_tier)
        throw new CommandValidationError([
          {
            field: "rowIds",
            code: "QUALITY_REQUIRED",
            message: "Set the data-quality tier before approval.",
          },
        ]);
      const editor =
        row.provenance_json?.calculatedBy ?? row.provenance_json?.capturedBy;
      if (editor === context.actorId)
        throw new CommandValidationError([
          {
            field: "rowIds",
            code: "INDEPENDENT_REVIEW_REQUIRED",
            message:
              "The most recent editor or calculator cannot approve this row.",
          },
        ]);
    }
    const note =
      "reviewerNote" in input ? input.reviewerNote?.trim() || null : null;
    const reviewEventId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.scope_row_review_history (organisation_id,review_event_id,job_id,scope_row_id,row_version,decision,reviewer_id,reviewer_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        context.organisationId,
        reviewEventId,
        input.jobId,
        rowId,
        row.version,
        decision,
        context.actorId,
        note,
      ],
    );
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_scope_rows SET review_status=$4,reviewed_row_version=$5,reviewed_by=$6,reviewed_at=now(),reviewer_note=$7,version=version+1,updated_at=now() WHERE organisation_id=$1 AND job_id=$2 AND scope_row_id=$3 AND version=$5 RETURNING version`,
      [
        context.organisationId,
        input.jobId,
        rowId,
        decision,
        row.version,
        context.actorId,
        note,
      ],
    );
    if (!updated.rows[0]) throw new VersionConflictError();
    return {
      data: {
        jobId: input.jobId,
        rowId,
        decision,
        version: updated.rows[0].version,
        reviewEventId,
      },
      entityType: "scope_row",
      entityId: rowId,
      topic: `scope.row.${decision}`,
    };
  });
}
export const approveScopeRow = (
  pool: PoolLike,
  input: CommandInputMap["scope.review.approve"],
  context: CommandContext,
) => reviewScopeRow(pool, "scope.review.approve", input, context);
export const rejectScopeRow = (
  pool: PoolLike,
  input: CommandInputMap["scope.review.reject"],
  context: CommandContext,
) => reviewScopeRow(pool, "scope.review.reject", input, context);

export type UpsertEmissionsTargetResult = { jobId: string; version: number };
export async function upsertEmissionsTarget(
  pool: PoolLike,
  input: CommandInputMap["emissions.target.upsert"],
  context: CommandContext,
): Promise<StoredOutcome<UpsertEmissionsTargetResult>> {
  return runPostgresCommand(
    pool,
    "emissions.target.upsert",
    input,
    context,
    async (db) => {
      await requireCrpJob(db, context.organisationId, input.jobId);
      const current = await db.query<{ version: number }>(
        `SELECT version FROM nzi_console.job_emissions_targets WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE`,
        [context.organisationId, input.jobId],
      );
      const version = current.rows[0]?.version ?? 0;
      if (version !== input.expectedVersion) throw new VersionConflictError();
      const saved = await db.query<{ version: number }>(
        `INSERT INTO nzi_console.job_emissions_targets (organisation_id,job_id,baseline_year,baseline_tco2e,interim_year,interim_reduction_percent,net_zero_year,version,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8) ON CONFLICT (organisation_id,job_id) DO UPDATE SET baseline_year=EXCLUDED.baseline_year,baseline_tco2e=EXCLUDED.baseline_tco2e,interim_year=EXCLUDED.interim_year,interim_reduction_percent=EXCLUDED.interim_reduction_percent,net_zero_year=EXCLUDED.net_zero_year,version=job_emissions_targets.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version`,
        [
          context.organisationId,
          input.jobId,
          input.baselineYear,
          input.baselineTco2e,
          input.interimYear,
          input.interimReductionPercent,
          input.netZeroYear,
          context.actorId,
        ],
      );
      return {
        data: { jobId: input.jobId, version: saved.rows[0]!.version },
        entityType: "job_emissions_target",
        entityId: input.jobId,
        topic: "emissions.target.saved",
      };
    },
  );
}
export async function upsertIntensityTarget(pool:PoolLike,input:CommandInputMap["emissions.intensity.upsert"],context:CommandContext):Promise<StoredOutcome<{jobId:string;version:number}>>{return runPostgresCommand(pool,"emissions.intensity.upsert",input,context,async db=>{await requireCrpJob(db,context.organisationId,input.jobId);const current=await db.query<{version:number}>(`SELECT version FROM nzi_console.job_intensity_targets WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE`,[context.organisationId,input.jobId]);if((current.rows[0]?.version??0)!==input.expectedVersion)throw new VersionConflictError();const saved=await db.query<{version:number}>(`INSERT INTO nzi_console.job_intensity_targets (organisation_id,job_id,metric,denominator_unit,reporting_denominator,baseline_year,baseline_intensity,interim_year,interim_reduction_percent,net_zero_year,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11) ON CONFLICT(organisation_id,job_id) DO UPDATE SET metric=EXCLUDED.metric,denominator_unit=EXCLUDED.denominator_unit,reporting_denominator=EXCLUDED.reporting_denominator,baseline_year=EXCLUDED.baseline_year,baseline_intensity=EXCLUDED.baseline_intensity,interim_year=EXCLUDED.interim_year,interim_reduction_percent=EXCLUDED.interim_reduction_percent,net_zero_year=EXCLUDED.net_zero_year,version=job_intensity_targets.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version`,[context.organisationId,input.jobId,input.metric,input.denominatorUnit.trim(),input.reportingDenominator,input.baselineYear,input.baselineIntensity,input.interimYear,input.interimReductionPercent,input.netZeroYear,context.actorId]);return{data:{jobId:input.jobId,version:saved.rows[0]!.version},entityType:"job_intensity_target",entityId:input.jobId,topic:"emissions.intensity.saved"};});}

export async function validateCrpReport(pool:PoolLike,input:CommandInputMap["report.validate"],context:CommandContext):Promise<StoredOutcome<{reportVersionId:string;jobId:string;reviewedSnapshotId:string;manifestVersion:number;status:"validated";dataHash:string}>>{return runPostgresCommand(pool,"report.validate",input,context,async db=>{if(input.manifestVersion!==crpProfessionalManifest.version)throw new CommandValidationError([{field:"manifestVersion",code:"VERSION_MISMATCH",message:`CRP professional manifest v${crpProfessionalManifest.version} is required.`}]);const found=await db.query<{job_id:string;data_hash:string;created_at:Date|string;payload_json:{jobNumber:string;client:string;reportingYear:number;target?:unknown;intensityTarget?:unknown;annualComparison?:unknown[];measurements:Array<Record<string,unknown>>}}>(`SELECT job_id,data_hash,created_at,payload_json FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND snapshot_id=$2`,[context.organisationId,input.reviewedSnapshotId]);const snapshot=found.rows[0];if(!snapshot)throw new CommandValidationError([{field:"reviewedSnapshotId",code:"NOT_FOUND",message:"Reviewed snapshot was not found."}]);const payload=snapshot.payload_json;const charts=resolveCrpCoreCharts({id:input.reviewedSnapshotId,jobId:snapshot.job_id,jobNumber:payload.jobNumber,client:payload.client,reportingYear:payload.reportingYear,generatedAt:snapshot.created_at instanceof Date?snapshot.created_at.toISOString():String(snapshot.created_at),dataHash:snapshot.data_hash,target:payload.target as never,intensityTarget:payload.intensityTarget as never,annualComparison:payload.annualComparison as never,measurements:payload.measurements as never});const validation=validateManifest(crpProfessionalManifest,charts,input.reviewedSnapshotId);if(!validation.valid)throw new CommandValidationError(validation.issues.map(issue=>({field:issue.chartId,code:issue.code.toUpperCase(),message:issue.message})));const reportVersionId=randomUUID();await db.query(`INSERT INTO nzi_console.report_versions(organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash) VALUES($1,$2,$3,'validated',$4,$5,$6)`,[context.organisationId,reportVersionId,snapshot.job_id,input.manifestVersion,input.reviewedSnapshotId,snapshot.data_hash]);return{data:{reportVersionId,jobId:snapshot.job_id,reviewedSnapshotId:input.reviewedSnapshotId,manifestVersion:input.manifestVersion,status:"validated",dataHash:snapshot.data_hash},entityType:"report_version",entityId:reportVersionId,topic:"report.validated"};});}

export async function publishCrpReport(pool:PoolLike,input:CommandInputMap["report.publish"],context:CommandContext):Promise<StoredOutcome<{reportVersionId:string;jobId:string;reviewedSnapshotId:string;manifestVersion:number;status:"published";publishedAt:string}>>{return runPostgresCommand(pool,"report.publish",input,context,async db=>{const found=await db.query<{job_id:string;status:string;manifest_version:number;reviewed_snapshot_id:string}>(`SELECT job_id,status,manifest_version,reviewed_snapshot_id FROM nzi_console.report_versions WHERE organisation_id=$1 AND report_version_id=$2 FOR UPDATE`,[context.organisationId,input.reportVersionId]);const report=found.rows[0];if(!report)throw new CommandValidationError([{field:"reportVersionId",code:"NOT_FOUND",message:"Validated report version was not found."}]);if(report.status!==input.expectedStatus)throw new CommandValidationError([{field:"expectedStatus",code:"PRECONDITION",message:"Only a validated report version may be published."}]);if(report.manifest_version!==input.manifestVersion||report.reviewed_snapshot_id!==input.reviewedSnapshotId)throw new CommandValidationError([{field:"reportVersionId",code:"EVIDENCE_MISMATCH",message:"The report version does not match the reviewed snapshot and manifest supplied."}]);await db.query(`UPDATE nzi_console.report_versions SET status='superseded',version=version+1 WHERE organisation_id=$1 AND job_id=$2 AND status='published'`,[context.organisationId,report.job_id]);const published=await db.query<{published_at:Date|string}>(`UPDATE nzi_console.report_versions SET status='published',published_at=now(),version=version+1 WHERE organisation_id=$1 AND report_version_id=$2 AND status='validated' RETURNING published_at`,[context.organisationId,input.reportVersionId]);if(!published.rows[0])throw new VersionConflictError();const publishedAt=published.rows[0].published_at instanceof Date?published.rows[0].published_at.toISOString():String(published.rows[0].published_at);return{data:{reportVersionId:input.reportVersionId,jobId:report.job_id,reviewedSnapshotId:report.reviewed_snapshot_id,manifestVersion:report.manifest_version,status:"published",publishedAt},entityType:"report_version",entityId:input.reportVersionId,topic:"portal.report.published"};});}

export type CreateReviewedSnapshotResult = {
  snapshotId: string;
  jobId: string;
  version: number;
  dataHash: string;
  reused: boolean;
};
export async function createReviewedCrpSnapshot(
  pool: PoolLike,
  input: CommandInputMap["report.snapshot.create"],
  context: CommandContext,
): Promise<StoredOutcome<CreateReviewedSnapshotResult>> {
  return runPostgresCommand<"report.snapshot.create",CreateReviewedSnapshotResult>(
    pool,
    "report.snapshot.create",
    input,
    context,
    async (db) => {
      const jobResult = await db.query<{
        version: number;
        job_family: string;
        job_number: string;
        client_id: string;
        reporting_year: number | null;
        start_date: Date | string;
        client_name: string;
      }>(
        `SELECT j.version,j.job_family,j.job_number,j.client_id,j.reporting_year,j.start_date,c.name AS client_name FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2 FOR UPDATE`,
        [context.organisationId, input.jobId],
      );
      const job = jobResult.rows[0];
      if (!job)
        throw new CommandValidationError([
          { field: "jobId", code: "NOT_FOUND", message: "Job was not found." },
        ]);
      if (job.job_family !== "crp")
        throw new CommandValidationError([
          {
            field: "jobId",
            code: "WRONG_FAMILY",
            message: "Reviewed CRP snapshots are available only for CRP jobs.",
          },
        ]);
      if (job.version !== input.expectedJobVersion)
        throw new VersionConflictError();
      const targetResult = await db.query<{
        job_id:string;baseline_year:number;baseline_tco2e:string;interim_year:number;interim_reduction_percent:string;net_zero_year:number;version:number;updated_by:string;updated_at:Date|string;
      }>(`SELECT job_id,baseline_year,baseline_tco2e,interim_year,interim_reduction_percent,net_zero_year,version,updated_by,updated_at FROM nzi_console.job_emissions_targets WHERE organisation_id=$1 AND job_id=$2 FOR SHARE`,[context.organisationId,input.jobId]);
      const targetRow=targetResult.rows[0];
      const target=targetRow?{jobId:targetRow.job_id,baselineYear:targetRow.baseline_year,baselineTco2e:Number(targetRow.baseline_tco2e),interimYear:targetRow.interim_year,interimReductionPercent:Number(targetRow.interim_reduction_percent),netZeroYear:targetRow.net_zero_year,version:targetRow.version,updatedAt:targetRow.updated_at instanceof Date?targetRow.updated_at.toISOString():String(targetRow.updated_at),updatedBy:targetRow.updated_by}:null;
      const intensityResult=await db.query<{job_id:string;metric:"turnover"|"employee"|"floor-area";denominator_unit:string;reporting_denominator:string;baseline_year:number;baseline_intensity:string;interim_year:number;interim_reduction_percent:string;net_zero_year:number;version:number;updated_by:string;updated_at:Date|string}>(`SELECT job_id,metric,denominator_unit,reporting_denominator,baseline_year,baseline_intensity,interim_year,interim_reduction_percent,net_zero_year,version,updated_by,updated_at FROM nzi_console.job_intensity_targets WHERE organisation_id=$1 AND job_id=$2 FOR SHARE`,[context.organisationId,input.jobId]);
      const intensityRow=intensityResult.rows[0],intensityTarget=intensityRow?{jobId:intensityRow.job_id,metric:intensityRow.metric,denominatorUnit:intensityRow.denominator_unit,reportingDenominator:Number(intensityRow.reporting_denominator),baselineYear:intensityRow.baseline_year,baselineIntensity:Number(intensityRow.baseline_intensity),interimYear:intensityRow.interim_year,interimReductionPercent:Number(intensityRow.interim_reduction_percent),netZeroYear:intensityRow.net_zero_year,version:intensityRow.version,updatedAt:intensityRow.updated_at instanceof Date?intensityRow.updated_at.toISOString():String(intensityRow.updated_at),updatedBy:intensityRow.updated_by}:null;
      const rowResult = await db.query<{
        scope_row_id: string;
        version: number;
        scope: string;
        source_label: string;
        report_label:string;
        level_1:string;
        level_2:string;
        level_3:string|null;
        level_4:string|null;
        monthly_activity_json:Array<{month:string;quantity:number|null}>;
        notes:string|null;
        asset_identifier:string|null;
        factor_source:"dataset"|"client";client_factor_id:string|null;is_custom_entry:boolean;apply_pct:string;data_confidence:"H"|"M"|"L"|null;source_quantity:string|null;source_unit:string|null;column_text:string|null;
        site_id:string|null;
        site_label:string|null;
        purchased_goods_category_id:string|null;
        purchased_goods_category_label:string|null;
        calculated_tco2e: string | null;
        override_tco2e: string | null;
        factor_label: string | null;
        factor_version: string | null;
        quality_tier: ScopeQualityTier | null;
        review_status: string;
        reviewed_by: string | null;
        enabled: boolean;
      }>(
        `SELECT scope_row_id,r.version,r.scope,r.source_label,r.asset_identifier,r.factor_source,r.client_factor_id,r.is_custom_entry,r.apply_pct,r.data_confidence,r.source_quantity,r.source_unit,r.column_text,r.report_label,r.level_1,r.level_2,r.level_3,r.level_4,r.monthly_activity_json,r.notes,r.site_id,s.name AS site_label,r.purchased_goods_category_id,pgc.name AS purchased_goods_category_label,r.calculated_tco2e,r.override_tco2e,r.factor_label,r.factor_version,r.quality_tier,r.review_status,r.reviewed_by,r.enabled FROM nzi_console.job_scope_rows r LEFT JOIN nzi_console.client_sites s ON (s.organisation_id,s.site_id)=(r.organisation_id,r.site_id) LEFT JOIN nzi_console.purchased_goods_categories pgc ON (pgc.organisation_id,pgc.category_id)=(r.organisation_id,r.purchased_goods_category_id) WHERE r.organisation_id=$1 AND r.job_id=$2 ORDER BY r.scope_row_id FOR SHARE OF r`,
        [context.organisationId, input.jobId],
      );
      const enabled = rowResult.rows.filter((row) => row.enabled);
      if (enabled.length === 0)
        throw new CommandValidationError([
          {
            field: "jobId",
            code: "NO_ENABLED_ROWS",
            message: "At least one enabled scope row is required.",
          },
        ]);
      const incomplete = enabled.filter(
        (row) =>
          row.review_status !== "approved" ||
          (row.calculated_tco2e === null && row.override_tco2e === null) ||
          !row.quality_tier ||
          !row.reviewed_by,
      );
      if (incomplete.length)
        throw new CommandValidationError([
          {
            field: "jobId",
            code: "QA_INCOMPLETE",
            message: `${incomplete.length} enabled scope row(s) are not calculation-complete and independently approved.`,
          },
        ]);
      const reportingYear =
        job.reporting_year ??
        Number(
          (job.start_date instanceof Date
            ? job.start_date.toISOString()
            : String(job.start_date)
          ).slice(0, 4),
        );
      const historicalResult=await db.query<{snapshot_id:string;data_hash:string;reporting_year:number;measurements:Array<{scope:string;tco2e:number}>}>(`SELECT DISTINCT ON ((s.payload_json->>'reportingYear')::integer) s.snapshot_id,s.data_hash,(s.payload_json->>'reportingYear')::integer AS reporting_year,s.payload_json->'measurements' AS measurements FROM nzi_console.reviewed_crp_snapshots s JOIN nzi_console.jobs previous_job ON (previous_job.organisation_id,previous_job.job_id)=(s.organisation_id,s.job_id) WHERE s.organisation_id=$1 AND previous_job.client_id=$2 AND previous_job.job_family='crp' AND (s.payload_json->>'reportingYear')::integer<$3 ORDER BY (s.payload_json->>'reportingYear')::integer,s.snapshot_version DESC`,[context.organisationId,job.client_id,reportingYear]);
      const scopeValues=(measurements:Array<{scope:string;tco2e:number}>)=>(["1","2","3"] as const).map(scope=>({scope,value:measurements.filter(row=>row.scope===scope).reduce((sum,row)=>sum+Number(row.tco2e),0)}));
      const currentMeasurements=enabled.map(row=>({scope:row.scope.split(".")[0]!,tco2e:Number(row.override_tco2e??row.calculated_tco2e)}));
      const annualComparison=[...historicalResult.rows.map(row=>({year:row.reporting_year,sourceSnapshotId:row.snapshot_id,sourceDataHash:row.data_hash,values:scopeValues(row.measurements)})),{year:reportingYear,sourceSnapshotId:"current",sourceDataHash:"current",values:scopeValues(currentMeasurements)}];
      const payload = {
        jobId: input.jobId,
        jobNumber: job.job_number,
        client: job.client_name,
        reportingYear,
        jobVersion: job.version,
        target,
        intensityTarget,
        annualComparison,
        measurements: enabled.map((row) => ({
          rowId: row.scope_row_id,
          rowVersion: row.version,
          scope: row.scope.split(".")[0],
          scopeCode:row.scope,
          sourceLabel: row.source_label,
          assetIdentifier:row.asset_identifier??null,
          factorSource:row.factor_source,clientFactorId:row.client_factor_id,isCustomEntry:row.is_custom_entry,applyPct:Number(row.apply_pct),dataConfidence:row.data_confidence,sourceQuantity:row.source_quantity===null?null:Number(row.source_quantity),sourceUnit:row.source_unit,columnText:row.column_text,
          reportLabel:row.report_label,
          categoryPath:[row.level_1,row.level_2,row.level_3,row.level_4].filter((value):value is string=>typeof value==="string"),
          monthlyActivity:row.monthly_activity_json??[],
          notes:row.notes??null,
          siteId:row.site_id,
          siteLabel:row.site_label,
          purchasedGoodsCategoryId:row.purchased_goods_category_id,
          purchasedGoodsCategoryLabel:row.purchased_goods_category_label,
          tco2e: Number(row.override_tco2e ?? row.calculated_tco2e),
          factorSet: [row.factor_label, row.factor_version]
            .filter(Boolean)
            .join(" · "),
          qualityTier: row.quality_tier,
          reviewedBy: row.reviewed_by,
        })),
      };
      const dataHash = `sha256:${createHash("sha256")
        .update(JSON.stringify(stable(payload)))
        .digest("hex")}`;
      const existing = await db.query<{
        snapshot_id: string;
        snapshot_version: number;
      }>(
        `SELECT snapshot_id,snapshot_version FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND job_id=$2 AND data_hash=$3`,
        [context.organisationId, input.jobId, dataHash],
      );
      if (existing.rows[0])
        return {
          data: {
            snapshotId: existing.rows[0].snapshot_id,
            jobId: input.jobId,
            version: existing.rows[0].snapshot_version,
            dataHash,
            reused: true,
          },
          entityType: "reviewed_crp_snapshot",
          entityId: existing.rows[0].snapshot_id,
          topic: "report.snapshot.reused",
        };
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${context.organisationId}:${input.jobId}:snapshot-version`,
      ]);
      const next = await db.query<{ version: number }>(
        `SELECT coalesce(max(snapshot_version),0)+1 AS version FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND job_id=$2`,
        [context.organisationId, input.jobId],
      );
      const version = Number(next.rows[0]!.version),
        snapshotId = randomUUID();
      await db.query(
        `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          context.organisationId,
          snapshotId,
          input.jobId,
          version,
          job.version,
          dataHash,
          JSON.stringify(payload),
          context.actorId,
        ],
      );
      return {
        data: {
          snapshotId,
          jobId: input.jobId,
          version,
          dataHash,
          reused: false,
        },
        entityType: "reviewed_crp_snapshot",
        entityId: snapshotId,
        topic: "report.snapshot.created",
      };
    },
  );
}
