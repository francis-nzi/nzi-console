import { grantFor, staffCapabilityOf, type CommandContext, type CommandKey, type CommandOutcome } from "@nzi/contracts";
import { TenantContextError, VersionConflictError } from "./errors";
export * from "./databaseBoundary";
export * from "./errors";
export * from "./auth";
export * from "./credentials";
export * from "./login";
export * from "./staffEnrolment";
export * from "./staffInvitations";
export * from "./portalTerms";
export * from "./portalAnalytics";
export * from "./portalActions";
export { getPortalClientIntensity, type PortalIntensityReadModel, type PortalIntensityYear } from "./portalIntensity";
export { getPortalClientTraining, type PortalTrainingReadModel, type PortalTrainingRecord, type PortalTrainingSkillCell } from "./portalTraining";
export {
  getPortalClientReadiness,
  type PortalReadinessPillar, type PortalReadinessReadModel,
} from "./portalReadiness";
export {
  getPortalClientStrategies,
  type PortalPlanGroup, type PortalPlanRequirement, type PortalPlanStrategy,
  type PortalStrategiesReadModel, type PortalStrategyHighlight, type PortalPlanParticipation, type PortalLibraryOption, type PortalContactOption, type PortalProposal,
} from "./portalStrategies";
export { verifyTrainingCertificate, type CertificateVerification } from "./certificateVerification";
export {
  claimVerifyAttempt, claimVerifyMiss, clientAddressFrom, verifyBucketKey,
  VERIFY_MISS_LIMIT, VERIFY_OVERALL_LIMIT, VERIFY_WINDOW_MINUTES,
} from "./verifyRateLimit";
export * from "./postgres";
export * from "./postgresCommands";
export * from "./categoryVisibility";
export * from "./portalProfile";
export * from "./portalCapture";
export * from "./dataSubjects";
export * from "./subjectCrypto";
export * from "./piiInventory";
export * from "./subjectResolution";
export * from "./piiSealing";
export * from "./piiSealingKeys";
export * from "./piiWriteThrough";
export * from "./entryExtractionStub";
export * from "./dates";
export * from "./readModels";
export * from "./reportStatusRegister";
export * from "./clientHistory";
export * from "./listReads";
export * from "./adminOverview";
export * from "./referenceEngine";
export * from "./timeEntries";
export * from "./timeReads";
export * from "./jobTypes";
export * from "./milestoneTemplates";
export * from "./jobFileTypes";
export * from "./commercialLookups";
export * from "./serviceCatalogue";
export * from "./jobTypeTemplates";
export * from "./suppliers";
export * from "./messageTemplates";
export * from "./bdFunnelStages";
export * from "./customFields";
export * from "./portalBroadcasts";
export * from "./milestoneCommands";
export * from "./jobUpdate";
export * from "./datasetSelection";
export * from "./jobDatasetUpdate";
export * from "./staffAdmin";
export * from "./organisationSettings";
export { loadV7Lookups, planV7Lookups, V7_LOOKUP_TABLES, V7_LOOKUP_TABLE_NAMES } from "./v7LookupLoad";
export { loadV7ClientLinks, planClientLinks } from "./v7ClientLinkLoad";
export { loadV7JobsConfig, planV7JobsConfig, V7_JOBS_CONFIG_TABLES } from "./v7JobsConfigLoad";
export { loadV7Staff, planV7Staff, V7_STAFF_TABLES } from "./v7StaffLoad";
export { loadV7OrgSettings, planV7OrgSettings, V7_ORG_SETTINGS_TABLES } from "./v7OrgSettingsLoad";
export { loadV7JobLinks, planJobLinks } from "./v7JobLinkLoad";
export { likePattern } from "./listPage";
export * from "./inputSpecRecords";
export * from "./inputSpecFactorRules";
export * from "./spendImportIdentity";
export * from "./spendImport";
export * from "./scopeRowHistory";
export * from "./lcaAssessments";
export * from "./lcaLineItems";
export * from "./lcaTransportLegs";
export * from "./lcaUnits";
export * from "./lcaGeocoding";
export * from "./lcaCalcEngine";
export * from "./lcaAssessmentReview";
export * from "./lcaResultSnapshots";
export * from "./lcaScenarios";
export * from "./portalReview";
export * from "./portalAccess";
export * from "./portalInvitations";
export * from "./portalDataEntry";
export * from "./portalDataEntryRecords";
export * from "./portalDeliverables";
export * from "./portalComposition";
export * from "./vehicleLookup";
export * from "./siteLifecycle";
export * from "./siteBoundary";
export * from "./access";
export * from "./independentApproval";
export * from "./clientContacts";
export * from "./knowledge";
export * from "./tourSeen";
export * from "./grounding";
export * from "./portalAcceptanceSeed";
export * from "./portalPreview";
export * from "./portalPreviewReads";
export * from "./referenceData";
export * from "./referenceSeedSource";
export * from "./clientReference";
export * from "./clientReferenceBackfill";
export * from "./answering";
export * from "./answerModel";
export { mapClientContact, normaliseContactRoles } from "./clientContactRecords";
export * from "./traineeAuth";
export { getTraineePortal, type TraineePortalReadModel, type TraineeDetails, type TraineeTrainingEntry, type TraineeUpcomingSession } from "./traineePortal";
export { createTrainingBooking, getTrainingRun, issueTrainingCertificates, jobHasTrainingRun, listTrainingRunsForJob, reviewTrainingRun, setTrainingAttendance, setTrainingEntitlementExpiry, setTrainingRunStage, type TrainingBookingRecord, type TrainingRunRecord } from "./trainingRuns";
export { getJobAnnualMetrics, type JobAnnualMetricsReadModel } from "./intensityMetricRecords";
export { deactivateClientIntensityMetric, denominatorFor, listClientIntensityMetrics, listClientIntensityValues, listJobIntensityValues, setClientIntensityMetric, setJobIntensityValue } from "./intensityMetrics";
export { completeSrsAssessment, getSrsAssessment, getSrsFramework, listSrsAssessments, resolveNziFacts, setSrsAssessmentItem, startSrsAssessment } from "./srsReadiness";
export {
  createSrsFrameworkDraft, listSrsFrameworkVersions, publishSrsFramework, updateSrsMaturityLevel, upsertSrsRequirement, type SrsFrameworkVersion,
} from "./srsFramework";
export { listClientFiles, listClientMessages, listClientReports, type ClientFileReadModel, type ClientMessageReadModel, type ClientReportReadModel } from "./clientAreaRecords";
export * from "./clientLogo";
export * from "./clientLogoFetch";
export * from "./geolocation";
export * from "./clientTargets";
export * from "./scopeRowState";
export * from "./v7Reingest";
export * from "./reingestAttest";
export * from "./clientIntensityTargets";
export * from "./clientReportingTemplates";
export * from "./masterTemplates";
export * from "./reportSectionPlans";
export * from "./jobSiteInclusions";
export { seedJobFromTemplate, getJobTemplateSeeding } from "./jobTemplateSeeding";
export * from "./emissionsAggregation";
export * from "./factorCategoryVariants";
export * from "./factorApplicability";
export * from "./factorApplicabilityCommands";
export {
  assignClientStrategy, deactivateLibraryStrategy, listLevers, listLibraryStrategies, listClientStrategies,
  removeClientStrategy, setClientStrategyEstimate, updateClientStrategy, upsertLibraryStrategy, upsertLever, deactivateLever,
  type AssignStrategyResult, type DeactivateStrategyResult, type RemoveStrategyResult,
  type UpdateStrategyResult, type UpsertStrategyResult,
} from "./reductionStrategies";
export {
  approveClientProposal, declineClientProposal, promoteClientProposal,
  type ApproveProposalResult, type DeclineProposalResult, type PromoteProposalResult,
} from "./strategyProposals";
export {
  addPortalStrategy, proposePortalStrategy, updatePortalStrategy,
  type PortalAddStrategyResult, type PortalProposeStrategyResult, type PortalUpdateStrategyResult,
} from "./portalStrategyCommands";
export {
  composeReport, freezeReportComposition, getReportComposition, previewReportComposition,
  type FreezeCompositionResult, type ReportCompositionPreview, type SnapshotForComposition,
} from "./reportCompositions";
export { draftReportComposition, type ReportDraftBlocker, type ReportDraftComposition } from "./reportDraftComposition";

export type TenantRecord = { id: string; organisationId: string; version: number };
export type AuditRecord = { id: string; organisationId: string; actorId: string; action: string; entityId: string; correlationId: string; at: string };
export type OutboxRecord = { id: string; organisationId: string; topic: string; payload: Record<string, unknown>; correlationId: string; state: "pending" | "sent" };
type StoreState = { records: Map<string, TenantRecord>; audits: AuditRecord[]; outbox: OutboxRecord[]; idempotency: Map<string, CommandOutcome> };

const tenantKey = (organisationId: string, id: string) => `${organisationId}:${id}`;
const cloneState = (state: StoreState): StoreState => structuredClone(state);

export class IsolatedStore {
  private state: StoreState = { records: new Map(), audits: [], outbox: [], idempotency: new Map() };
  async transaction<T>(work: (unit: IsolatedUnitOfWork) => Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    const result = await work(new IsolatedUnitOfWork(draft));
    this.state = draft;
    return result;
  }
  snapshot() { return cloneState(this.state); }
}

export class IsolatedUnitOfWork {
  constructor(private readonly state: StoreState) {}
  repository<T extends TenantRecord>(organisationId: string) { if (!organisationId.trim()) throw new TenantContextError(); return new TenantRepository<T>(this.state.records, organisationId); }
  audit(record: AuditRecord) { if (!record.organisationId) throw new TenantContextError(); this.state.audits.push(record); }
  enqueue(record: OutboxRecord) { if (!record.organisationId) throw new TenantContextError(); this.state.outbox.push(record); }
  replay(organisationId: string, idempotencyKey: string) { return this.state.idempotency.get(tenantKey(organisationId, idempotencyKey)); }
  remember(organisationId: string, idempotencyKey: string, outcome: CommandOutcome) { this.state.idempotency.set(tenantKey(organisationId, idempotencyKey), outcome); }
}

export class TenantRepository<T extends TenantRecord> {
  constructor(private readonly records: Map<string, TenantRecord>, private readonly organisationId: string) {}
  list(): T[] { return [...this.records.values()].filter((record) => record.organisationId === this.organisationId) as T[]; }
  get(id: string): T | undefined { return this.records.get(tenantKey(this.organisationId, id)) as T | undefined; }
  insert(record: T): T { if (record.organisationId !== this.organisationId) throw new TenantContextError("Cross-tenant insert denied."); this.records.set(tenantKey(this.organisationId, record.id), structuredClone(record)); return record; }
  update(id: string, expectedVersion: number, change: (current: T) => T): T {
    const current = this.get(id); if (!current) throw new Error("Record not found."); if (current.version !== expectedVersion) throw new VersionConflictError();
    const next = change(structuredClone(current)); if (next.organisationId !== this.organisationId) throw new TenantContextError("Cross-tenant update denied."); next.version = current.version + 1; this.records.set(tenantKey(this.organisationId, id), structuredClone(next)); return next;
  }
}

export type IsolatedCommandHandler<T extends Record<string, unknown>> = (unit: IsolatedUnitOfWork) => Promise<{ data: T; entityId: string; outbox?: { topic: string; payload: Record<string, unknown> } }>;
export async function runIsolatedCommand<T extends Record<string, unknown>>(store: IsolatedStore, key: CommandKey, context: CommandContext, handler: IsolatedCommandHandler<T>): Promise<CommandOutcome<T>> {
  if (!context.organisationId.trim()) return { state: "denied", permission: "tenant.context", message: "Tenant context is required.", correlationId: context.correlationId };
  // NZC-022 — the same grant rule as the Postgres runner: this actor, this tenant, and the command's capability.
  const capability = staffCapabilityOf(key);
  if (capability === null || !context.grant || context.grant.organisationId !== context.organisationId || context.grant.userId !== context.actorId || !grantFor(context.grant.capabilities, capability)) return { state: "denied", permission: capability ?? "portal.dataentry", message: "Permission denied.", correlationId: context.correlationId };
  try {
    return await store.transaction(async (unit) => {
      const replay = unit.replay(context.organisationId, context.idempotencyKey) as CommandOutcome<T> | undefined;
      if (replay?.state === "success") return { ...replay, replayed: true };
      const result = await handler(unit);
      const auditEventId = `audit-${context.correlationId}`;
      unit.audit({ id: auditEventId, organisationId: context.organisationId, actorId: context.actorId, action: key, entityId: result.entityId, correlationId: context.correlationId, at: new Date().toISOString() });
      if (result.outbox) unit.enqueue({ id: `outbox-${context.correlationId}`, organisationId: context.organisationId, topic: result.outbox.topic, payload: result.outbox.payload, correlationId: context.correlationId, state: "pending" });
      const outcome: CommandOutcome<T> = { state: "success", data: result.data, auditEventId, correlationId: context.correlationId, replayed: false };
      unit.remember(context.organisationId, context.idempotencyKey, outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof VersionConflictError) return { state: "conflict", code: "VERSION_CONFLICT", message: error.message, correlationId: context.correlationId };
    return { state: "failed", code: "TRANSACTION_FAILED", message: error instanceof Error ? error.message : "Transaction failed.", retryable: false, correlationId: context.correlationId };
  }
}
export { mailDelivery, smtpSettingsFrom, suppressingMailer, SmtpConfigurationError, type Mailer, type MailMessage, type MailDelivery } from "./mailer";
export {
  runReminderTick, runWorkerTick, scanClientReminders, drainOutbox, clientsWithPlans, REMINDER_TOPIC, MAX_SEND_ATTEMPTS,
  type ReminderRunSummary, type WorkerTickSummary, type TickPart,
} from "./strategyReminderWorker";
export {
  sendEmail, validateEmailRequest, deliverEmail, emailDispatchFromEnv, resendTransport, stubReasonFor, EmailValidationError, EmailTransportError,
  EMAIL_SEND_TOPIC, MAX_EMAIL_ATTEMPTS, ISOLATED_RECIPIENT_DOMAINS,
  type EmailRequest, type EmailDispatch, type EmailGate, type EmailTransport, type EmailOutcome, type OutboundEmail,
} from "./email";
export { sendTemplatedEmail, TemplatedEmailError, type TemplatedEmailRequest } from "./templatedEmail";
export {
  readReminderSettings, updateReminderSettings, scanDueReminders, listStrategyReminderStatuses, strategyReminderStatuses, DUE_REMINDER_ACTOR,
  type DueReminderScan, type ReminderSettingsResult, type StrategyReminders,
} from "./dueReminders";
export { listEntryBasisDefaults, readJobEntryBasis, updateEntryBasisDefault, type EntryBasisDefaultResult } from "./entryBasis";
export {
  listClientSpendAllocations, createSpendAllocation, updateSpendAllocation, archiveSpendAllocation, reinstateSpendAllocation, learnSpendAllocation,
  reallocateScopeRow, activeSpendAllocations, activeSpendAllocationsForJob, listSpendAllocationClients, listSpendFactors, type SpendAllocationResult, type ReallocateResult,
} from "./spendAllocation";
export {
  anthropicSpendSuggestionModel, spendSuggestionRequest, generateSpendSuggestion, recordSpendAllocationSuggestion, confirmSpendAllocationSuggestion,
  dismissSpendAllocationSuggestion, type SpendSuggestionModel, type SpendSuggestionRecorded, type SpendSuggestionConfirmed,
} from "./spendAllocationSuggestions";
export { readJobCurrencies, setJobSiteFxRate, type JobCurrencies, type JobSiteCurrency, type JobSiteFxResult } from "./jobSiteFx";
// Data entry D4 (R1): company-vehicle registrations sealed under the client's own key; the client's opt-out.
export {
  copySealedVehicleIdentifier, resealVehicleIdentifiers, sealExistingVehicleRegistrations, sealVehicleIdentifiers, setVehicleRegistrationsOptOut,
  vehicleRegistrationReader, VEHICLE_CATEGORY_CODE, VEHICLE_KEY_PURPOSE, type VehicleRegistrationsOptOutResult,
} from "./vehicleRegistrations";
// Data entry D6 (R1, R2a, R3): the one-off clear of commuting and pre-D5 travel identifiers — minimised, not sealed.
export { clearCommutingTravelIdentifiers, D5_TRAVEL_CUTOFF, type MinimisationCounts } from "./commutingTravelMinimisation";
// Data entry D3 (R3–R6).
export { fixCarryForwardBasis, storedCarryForwardBasis, type CarryForwardBasis } from "./carryForwardBasis";
export { readCategoryLineYears, type CategoryLineYears, type CategoryLineYearValue } from "./categoryLineYears";
export {
  ENTRY_NOT_REOPENABLE, ENTRY_STILL_EDITABLE, REOPEN_ALREADY_REQUESTED, REOPEN_REQUEST_TEMPLATE,
  listOpenReopenRequests, openReopenRequestsByRow, requestScopeRowReopen, resolveReopenRequestOnEdit,
  type OpenReopenRequest, type ReopenRequestResult,
} from "./portalReopenRequests";
export { recordClientEntryBasisChoice } from "./entryBasisChoices";
export {
  readStaffSignature, updateOwnStaffSignature, emailPersonForMember, StaffSignatureError, type StaffSignatureRecord, type SignatureMember,
} from "./staffSignature";
export {
  requestPasswordReset, completePasswordReset, resetLink, PasswordResetError, RESET_TTL_MINUTES, MAX_RESET_REQUESTS_PER_HOUR,
  MIN_RESET_PASSWORD, type ResetPrincipal,
} from "./passwordReset";
export {
  issueRecoveryCodes, useRecoveryCode, regenerateRecoveryCodes, countRecoveryCodes, looksLikeRecoveryCode, normaliseRecoveryCode,
  RecoveryCodeError, RECOVERY_CODE_COUNT, LOW_RECOVERY_CODES, type RecoveryPrincipal,
} from "./mfaRecovery";
export { previewDeclaredFactor, type DeclaredFactorPreview, type ResolutionEntry } from "./declarativeResolution";
export {
  bridgeSrsGap, exportSrsReport, listSrsGapSuggestions, recordSrsGapSuggestions, srsFrameworksFor, withdrawSrsGapSuggestion,
  type BridgeGapResult, type ExportReportResult, type RecordSuggestionsResult, type WithdrawSuggestionResult,
} from "./srsBridging";
export {
  anthropicSrsSuggestionModel, anthropicStructuredModel, DEFAULT_SRS_SUGGESTION_MODEL, generateSrsGapSuggestions, srsPromptSha256, srsSuggestionInputFor,
  type SrsSuggestionModel, type SrsSuggestionRun,
} from "./srsSuggestions";
export { getSrsReport, type SrsReportReadModel } from "./srsReport";
