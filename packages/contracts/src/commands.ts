export type CommandKey =
  | "client.create"
  | "job.create"
  | "job.stage.change"
  | "scope.review.approve"
  | "report.publish"
  | "dataset.override.add"
  | "portal.access.grant"
  | "sales.opportunity.convert";

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
  "scope.review.approve": { jobId: string; rowIds: string[]; expectedReviewVersion: number; reviewerNote?: string };
  "report.publish": { reportVersionId: string; expectedStatus: "validated"; manifestVersion: number; reviewedSnapshotId: string };
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

export const commandDefinitions: { [K in CommandKey]: CommandDefinition<K> } = {
  "client.create": { key: "client.create", label: "Create client", permission: "clients.create", reasonRequired: false, transaction: "client + audit + outbox + idempotency", auditAction: "client_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "name", input.name); required(issues, "sector", input.sector); required(issues, "location", input.location); required(issues, "owner", input.owner); return issues; } },
  "job.create": { key: "job.create", label: "Create job", permission: "jobs.create", reasonRequired: false, transaction: "number allocation + job + audit + outbox + idempotency", auditAction: "job_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "title", input.title); required(issues, "workflowStage", input.workflowStage); required(issues, "owner", input.owner); required(issues, "startDate", input.startDate); required(issues, "dueDate", input.dueDate); if (input.dueDate < input.startDate) issues.push({ field: "dueDate", code: "INVALID_RANGE", message: "Due date must not precede start date." }); return issues; } },
  "job.stage.change": { key: "job.stage.change", label: "Change job stage", permission: "jobs.stage.change", reasonRequired: false, transaction: "stage history + job header", auditAction: "job_stage_changed", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "fromStage", input.fromStage); required(issues, "toStage", input.toStage); if (input.fromStage === input.toStage) issues.push({ field: "toStage", code: "NO_CHANGE", message: "New stage must differ from the current stage." }); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.review.approve": { key: "scope.review.approve", label: "Approve scope rows", permission: "emissions.review", reasonRequired: false, transaction: "scope rows + review history", auditAction: "scope_rows_approved", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); if (!input.rowIds.length) issues.push({ field: "rowIds", code: "REQUIRED", message: "Select at least one scope row." }); if (!positive(input.expectedReviewVersion)) issues.push({ field: "expectedReviewVersion", code: "INVALID", message: "Expected review version must be positive." }); return issues; } },
  "report.publish": { key: "report.publish", label: "Publish report", permission: "reports.publish", reasonRequired: false, transaction: "immutable version + manifest + portal outbox", auditAction: "report_published", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "reportVersionId", input.reportVersionId); required(issues, "reviewedSnapshotId", input.reviewedSnapshotId); if (input.expectedStatus !== "validated") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Only validated reports may be published." }); if (!positive(input.manifestVersion)) issues.push({ field: "manifestVersion", code: "INVALID", message: "Manifest version must be positive." }); return issues; } },
  "dataset.override.add": { key: "dataset.override.add", label: "Add manual dataset", permission: "datasets.override", reasonRequired: true, transaction: "resolution + warning + audit", auditAction: "dataset_override_added", validate: (input, context) => { const issues = baseIssues(context, true); required(issues, "jobId", input.jobId); required(issues, "scope", input.scope); required(issues, "datasetId", input.datasetId); required(issues, "reportingFrom", input.reportingFrom); required(issues, "reportingTo", input.reportingTo); return issues; } },
  "portal.access.grant": { key: "portal.access.grant", label: "Grant portal access", permission: "portal.access.manage", reasonRequired: false, transaction: "access grant + job grants + invitation outbox", auditAction: "portal_access_granted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "userId", input.userId); if (!input.jobIds.length) issues.push({ field: "jobIds", code: "REQUIRED", message: "Grant at least one job." }); return issues; } },
  "sales.opportunity.convert": { key: "sales.opportunity.convert", label: "Convert won opportunity", permission: "sales.convert", reasonRequired: false, transaction: "client + quote + optional job + outbox", auditAction: "opportunity_converted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "opportunityId", input.opportunityId); required(issues, "quoteId", input.quoteId); if (input.expectedStatus !== "WON") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Opportunity must be WON." }); return issues; } },
};

export function validateCommand<K extends CommandKey>(key: K, input: CommandInputMap[K], context: CommandContext) { return commandDefinitions[key].validate(input, context); }
