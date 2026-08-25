export type CommandKey =
  | "client.create"
  | "job.create"
  | "job.stage.change"
  | "scope.row.create"
  | "scope.row.update"
  | "scope.row.calculate"
  | "scope.review.approve"
  | "scope.review.reject"
  | "report.publish"
  | "report.snapshot.create"
  | "emissions.target.upsert"
  | "site.create"
  | "emissions.intensity.upsert"
  | "purchased.goods.category.create"
  | "dataset.override.add"
  | "portal.access.grant"
  | "sales.opportunity.convert";

export const jobWorkflowStages = {
  crp: ["Setup", "Data entry", "Factor mapping", "Review & QA", "Report & publish"],
  consultancy: ["Scope", "Plan", "Delivery", "Client review", "Complete"],
  lca: ["Goal & scope", "Inventory", "Impact assessment", "Interpretation", "Report"],
  pcf: ["Product boundary", "BOM", "Factor mapping", "Review", "Report"],
  training: ["Course setup", "Bookings", "Delivery", "Attendance", "Certificates"],
} as const;
export type WorkflowJobFamily = keyof typeof jobWorkflowStages;
export type ScopeQualityTier = "measured" | "estimated" | "spend-based" | "survey";
export type ScopeRowWriteFields = { scope: string; sourceLabel: string; siteId?:string|null;siteLabel?:string|null;purchasedGoodsCategoryId?:string|null;purchasedGoodsCategoryLabel?:string|null;quantity: number | null; unit: string | null; datasetId: string | null; factorId: string | null; factorVersion: string | null; factorLabel: string | null; qualityTier: ScopeQualityTier | null };
export type SiteOption={id:string;name:string};
export type PurchasedGoodsCategoryOption={id:string;name:string};
export type ScopeRowReadModel = ScopeRowWriteFields & { id: string; jobId: string; calculatedTco2e: number | null; overrideTco2e: number | null; overrideReason: string | null; reviewStatus: "pending" | "approved" | "rejected"; reviewedRowVersion:number|null;reviewedBy:string|null;reviewedAt:string|null;reviewerNote:string|null; version: number; enabled: boolean; provenance: Record<string, unknown>; lineage: Array<{ title: string; detail: string }> };
export type ScopeQaReadiness={total:number;enabled:number;approved:number;pending:number;rejected:number;calculationMissing:number;qualityMissing:number;independentReviewPending:number;readyForReporting:boolean};
export type EmissionsTargetReadModel={jobId:string;baselineYear:number;baselineTco2e:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;version:number;updatedAt:string;updatedBy:string};
export type IntensityTargetReadModel={jobId:string;metric:"turnover"|"employee"|"floor-area";denominatorUnit:string;reportingDenominator:number;baselineYear:number;baselineIntensity:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;version:number;updatedAt:string;updatedBy:string};
export type AnnualScopeComparison={year:number;sourceSnapshotId:string;sourceDataHash:string;values:Array<{scope:"1"|"2"|"3";value:number}>};
export type ReviewedCrpSnapshotReadModel={id:string;jobId:string;jobNumber:string;client:string;reportingYear:number;version:number;jobVersion:number;createdAt:string;createdBy:string;dataHash:string;target:EmissionsTargetReadModel|null;intensityTarget:IntensityTargetReadModel|null;annualComparison:AnnualScopeComparison[];measurements:Array<{rowId:string;rowVersion:number;scope:"1"|"2"|"3";scopeCode?:string;sourceLabel:string;siteId?:string|null;siteLabel?:string|null;purchasedGoodsCategoryId?:string|null;purchasedGoodsCategoryLabel?:string|null;tco2e:number;factorSet:string;qualityTier:ScopeQualityTier;reviewedBy:string}>};
export type FactorOption = { datasetId: string; datasetName: string; datasetVersion: string; factorId: string; label: string; activityUnit: string; kgco2ePerUnit: number; scopes: string[]; selectionSource: "automatic" | "manual"; synthetic: boolean; warnings: string[] };
export type DatasetOption = { datasetId: string; name: string; version: string; validFrom: string; validTo: string; countryCode: string; status: "active" | "superseded" | "draft"; synthetic: boolean; selected: boolean; selectionSource: "automatic" | "manual" | null; applicable: boolean; warnings: string[]; reportingFrom: string; reportingTo: string; jobCountryCode: string };
export function isAllowedJobStageTransition(family: WorkflowJobFamily, from: string, to: string): boolean {
  const stages: readonly string[] = jobWorkflowStages[family];
  const fromIndex = stages.indexOf(from); const toIndex = stages.indexOf(to);
  return fromIndex >= 0 && toIndex >= 0 && Math.abs(toIndex - fromIndex) === 1;
}

export type CommandContext = {
  organisationId: string;
  actorId: string;
  principal: "staff";
  idempotencyKey: string;
  correlationId: string;
  reason?: string;
};
export type CommandIssue = { field: string; code: string; message: string };
export type CommandOutcome<T = Record<string, unknown>> =
  | { state: "success"; data: T; auditEventId: string; correlationId: string; replayed: boolean }
  | { state: "conflict"; code: string; message: string; correlationId: string }
  | { state: "denied"; permission: string; message: string; correlationId: string }
  | { state: "validation_failed"; issues: CommandIssue[]; correlationId: string }
  | { state: "failed"; code: string; message: string; retryable: boolean; correlationId: string };

export type CommandInputMap = {
  "client.create": { name: string; status: "active" | "onboarding" | "at-risk" | "prospect"; sector: string; location: string; owner: string };
  "job.create": { clientId: string; family: "crp" | "consultancy" | "lca" | "pcf" | "training"; title: string; workflowStage: string; owner: string; startDate: string; dueDate: string; reportingYear?: number };
  "job.stage.change": { jobId: string; fromStage: string; toStage: string; expectedVersion: number; note?: string };
  "scope.row.create": { jobId: string } & ScopeRowWriteFields;
  "scope.row.update": { jobId: string; rowId: string; expectedVersion: number; enabled: boolean } & ScopeRowWriteFields;
  "scope.row.calculate": { jobId: string; rowId: string; expectedVersion: number };
  "scope.review.approve": { jobId: string; rowIds: string[]; expectedReviewVersion: number; reviewerNote?: string };
  "scope.review.reject": { jobId: string; rowIds: string[]; expectedReviewVersion: number; reviewerNote: string };
  "report.publish": { reportVersionId: string; expectedStatus: "validated"; manifestVersion: number; reviewedSnapshotId: string };
  "report.snapshot.create": { jobId:string;expectedJobVersion:number };
  "emissions.target.upsert": { jobId:string;baselineYear:number;baselineTco2e:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;expectedVersion:number };
  "site.create": {jobId:string;name:string};
  "emissions.intensity.upsert":{jobId:string;metric:"turnover"|"employee"|"floor-area";denominatorUnit:string;reportingDenominator:number;baselineYear:number;baselineIntensity:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;expectedVersion:number};
  "purchased.goods.category.create":{jobId:string;name:string};
  "dataset.override.add": { jobId: string; scope: string; datasetId: string; reportingFrom: string; reportingTo: string };
  "portal.access.grant": { clientId: string; jobIds: string[]; userId: string; dataEntryExpiresAt?: string };
  "sales.opportunity.convert": { opportunityId: string; expectedStatus: "WON"; quoteId: string; createJob: boolean };
};

export type CommandDefinition<K extends CommandKey = CommandKey> = {
  key: K; label: string; permission: string; reasonRequired: boolean; transaction: string; auditAction: string;
  validate: (input: CommandInputMap[K], context: CommandContext) => CommandIssue[];
};
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === "string" && allowed.includes(value as T);
const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const baseIssues = (context: CommandContext, reasonRequired: boolean) => {
  const issues: CommandIssue[] = [];
  if (!text(context.organisationId)) issues.push({ field: "organisationId", code: "REQUIRED", message: "Organisation context is required." });
  if (!text(context.actorId)) issues.push({ field: "actorId", code: "REQUIRED", message: "Actor is required." });
  if (!text(context.idempotencyKey)) issues.push({ field: "idempotencyKey", code: "REQUIRED", message: "Idempotency key is required." });
  if (!text(context.correlationId)) issues.push({ field: "correlationId", code: "REQUIRED", message: "Correlation ID is required." });
  if (reasonRequired && !text(context.reason)) issues.push({ field: "reason", code: "REQUIRED", message: "A reason is required for this command." });
  return issues;
};
const required = (issues: CommandIssue[], field: string, value: unknown) => { if (!text(value)) issues.push({ field, code: "REQUIRED", message: `${field} is required.` }); };
const scopeRowIssues = (input: ScopeRowWriteFields) => { const issues: CommandIssue[] = []; required(issues, "scope", input.scope); required(issues, "sourceLabel", input.sourceLabel); if (typeof input.scope === "string" && !/^(1|2|3(?:\.\d+)?)$/.test(input.scope)) issues.push({ field: "scope", code: "INVALID", message: "Use Scope 1, 2, or a Scope 3 category such as 3.1." }); if (input.quantity !== null && (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0)) issues.push({ field: "quantity", code: "INVALID", message: "Quantity must be zero or greater." }); if (input.factorId && !input.datasetId) issues.push({ field: "datasetId", code: "REQUIRED", message: "A factor must identify its dataset." }); return issues; };

export const commandDefinitions: { [K in CommandKey]: CommandDefinition<K> } = {
  "client.create": { key: "client.create", label: "Create client", permission: "clients.create", reasonRequired: false, transaction: "client + audit + outbox + idempotency", auditAction: "client_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "name", input.name); required(issues, "sector", input.sector); required(issues, "location", input.location); required(issues, "owner", input.owner); if (!oneOf(input.status, ["active", "onboarding", "at-risk", "prospect"] as const)) issues.push({ field: "status", code: "INVALID", message: "Client status is invalid." }); return issues; } },
  "job.create": { key: "job.create", label: "Create job", permission: "jobs.create", reasonRequired: false, transaction: "number allocation + job + audit + outbox + idempotency", auditAction: "job_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "title", input.title); required(issues, "workflowStage", input.workflowStage); required(issues, "owner", input.owner); if (!oneOf(input.family, ["crp", "consultancy", "lca", "pcf", "training"] as const)) issues.push({ field: "family", code: "INVALID", message: "Job family is invalid." }); if (!isoDate(input.startDate)) issues.push({ field: "startDate", code: "INVALID", message: "Start date must use YYYY-MM-DD." }); if (!isoDate(input.dueDate)) issues.push({ field: "dueDate", code: "INVALID", message: "Due date must use YYYY-MM-DD." }); if (isoDate(input.startDate) && isoDate(input.dueDate) && input.dueDate < input.startDate) issues.push({ field: "dueDate", code: "INVALID_RANGE", message: "Due date must not precede start date." }); return issues; } },
  "job.stage.change": { key: "job.stage.change", label: "Change job stage", permission: "jobs.stage.change", reasonRequired: false, transaction: "stage history + job header", auditAction: "job_stage_changed", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "fromStage", input.fromStage); required(issues, "toStage", input.toStage); if (input.fromStage === input.toStage) issues.push({ field: "toStage", code: "NO_CHANGE", message: "New stage must differ from the current stage." }); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.row.create": { key: "scope.row.create", label: "Create scope row", permission: "emissions.data.edit", reasonRequired: false, transaction: "scope row + audit + outbox + idempotency", auditAction: "scope_row_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...scopeRowIssues(input)]; required(issues, "jobId", input.jobId); return issues; } },
  "scope.row.update": { key: "scope.row.update", label: "Update scope row", permission: "emissions.data.edit", reasonRequired: false, transaction: "versioned scope row + audit + outbox + idempotency", auditAction: "scope_row_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...scopeRowIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "rowId", input.rowId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.row.calculate": { key: "scope.row.calculate", label: "Calculate scope row", permission: "emissions.data.edit", reasonRequired: false, transaction: "factor validation + numeric calculation + lineage", auditAction: "scope_row_calculated", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "rowId", input.rowId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.review.approve": { key: "scope.review.approve", label: "Approve scope rows", permission: "emissions.review", reasonRequired: false, transaction: "scope rows + review history", auditAction: "scope_rows_approved", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); if (!input.rowIds.length) issues.push({ field: "rowIds", code: "REQUIRED", message: "Select at least one scope row." }); if (!positive(input.expectedReviewVersion)) issues.push({ field: "expectedReviewVersion", code: "INVALID", message: "Expected review version must be positive." }); return issues; } },
  "scope.review.reject": { key: "scope.review.reject", label: "Reject scope rows", permission: "emissions.review", reasonRequired: false, transaction: "scope rows + review history", auditAction: "scope_rows_rejected", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues,"reviewerNote",input.reviewerNote);if (!input.rowIds.length) issues.push({ field: "rowIds", code: "REQUIRED", message: "Select at least one scope row." }); if (!positive(input.expectedReviewVersion)) issues.push({ field: "expectedReviewVersion", code: "INVALID", message: "Expected review version must be positive." }); return issues; } },
  "report.publish": { key: "report.publish", label: "Publish report", permission: "reports.publish", reasonRequired: false, transaction: "immutable version + manifest + portal outbox", auditAction: "report_published", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "reportVersionId", input.reportVersionId); required(issues, "reviewedSnapshotId", input.reviewedSnapshotId); if (input.expectedStatus !== "validated") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Only validated reports may be published." }); if (!positive(input.manifestVersion)) issues.push({ field: "manifestVersion", code: "INVALID", message: "Manifest version must be positive." }); return issues; } },
  "report.snapshot.create": { key:"report.snapshot.create",label:"Create reviewed snapshot",permission:"reports.publish",reasonRequired:false,transaction:"QA gate + immutable snapshot + content hash",auditAction:"reviewed_snapshot_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);if(!positive(input.expectedJobVersion))issues.push({field:"expectedJobVersion",code:"INVALID",message:"Expected job version must be positive."});return issues;} },
  "emissions.target.upsert": { key:"emissions.target.upsert",label:"Save emissions target",permission:"emissions.data.edit",reasonRequired:false,transaction:"versioned target + audit + outbox",auditAction:"emissions_target_saved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});if(!Number.isInteger(input.baselineYear)||!Number.isInteger(input.interimYear)||!Number.isInteger(input.netZeroYear)||!(input.baselineYear<input.interimYear&&input.interimYear<input.netZeroYear))issues.push({field:"interimYear",code:"INVALID_RANGE",message:"Years must run baseline, interim, then net zero."});if(typeof input.baselineTco2e!=="number"||!Number.isFinite(input.baselineTco2e)||input.baselineTco2e<=0)issues.push({field:"baselineTco2e",code:"INVALID",message:"Baseline emissions must be greater than zero."});if(typeof input.interimReductionPercent!=="number"||!Number.isFinite(input.interimReductionPercent)||input.interimReductionPercent<=0||input.interimReductionPercent>=100)issues.push({field:"interimReductionPercent",code:"INVALID",message:"Interim reduction must be between 0 and 100 percent."});return issues;} },
  "site.create":{key:"site.create",label:"Create client site",permission:"emissions.data.edit",reasonRequired:false,transaction:"client site + audit + outbox",auditAction:"client_site_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"name",input.name);return issues;}},
  "emissions.intensity.upsert":{key:"emissions.intensity.upsert",label:"Save intensity target",permission:"emissions.data.edit",reasonRequired:false,transaction:"versioned intensity target + audit + outbox",auditAction:"intensity_target_saved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"denominatorUnit",input.denominatorUnit);if(!oneOf(input.metric,["turnover","employee","floor-area"] as const))issues.push({field:"metric",code:"INVALID",message:"Intensity metric is invalid."});if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});if(!(input.reportingDenominator>0))issues.push({field:"reportingDenominator",code:"INVALID",message:"Reporting denominator must be greater than zero."});if(!(input.baselineIntensity>0))issues.push({field:"baselineIntensity",code:"INVALID",message:"Baseline intensity must be greater than zero."});if(!Number.isInteger(input.baselineYear)||!Number.isInteger(input.interimYear)||!Number.isInteger(input.netZeroYear)||!(input.baselineYear<input.interimYear&&input.interimYear<input.netZeroYear))issues.push({field:"interimYear",code:"INVALID_RANGE",message:"Years must run baseline, interim, then net zero."});if(!(input.interimReductionPercent>0&&input.interimReductionPercent<100))issues.push({field:"interimReductionPercent",code:"INVALID",message:"Interim reduction must be between 0 and 100 percent."});return issues;}},
  "purchased.goods.category.create":{key:"purchased.goods.category.create",label:"Create purchased-goods category",permission:"emissions.data.edit",reasonRequired:false,transaction:"client category + audit + outbox",auditAction:"purchased_goods_category_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"name",input.name);return issues;}},
  "dataset.override.add": { key: "dataset.override.add", label: "Add manual dataset", permission: "datasets.override", reasonRequired: true, transaction: "resolution + warning + audit", auditAction: "dataset_override_added", validate: (input, context) => { const issues = baseIssues(context, true); required(issues, "jobId", input.jobId); required(issues, "scope", input.scope); required(issues, "datasetId", input.datasetId); required(issues, "reportingFrom", input.reportingFrom); required(issues, "reportingTo", input.reportingTo); return issues; } },
  "portal.access.grant": { key: "portal.access.grant", label: "Grant portal access", permission: "portal.access.manage", reasonRequired: false, transaction: "access grant + job grants + invitation outbox", auditAction: "portal_access_granted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "userId", input.userId); if (!input.jobIds.length) issues.push({ field: "jobIds", code: "REQUIRED", message: "Grant at least one job." }); return issues; } },
  "sales.opportunity.convert": { key: "sales.opportunity.convert", label: "Convert won opportunity", permission: "sales.convert", reasonRequired: false, transaction: "client + quote + optional job + outbox", auditAction: "opportunity_converted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "opportunityId", input.opportunityId); required(issues, "quoteId", input.quoteId); if (input.expectedStatus !== "WON") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Opportunity must be WON." }); return issues; } },
};

export function validateCommand<K extends CommandKey>(key: K, input: CommandInputMap[K], context: CommandContext) { return commandDefinitions[key].validate(input, context); }
