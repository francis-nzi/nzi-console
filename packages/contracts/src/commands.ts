import { isLookupCategory, LOOKUP_CODE_MAX, LOOKUP_LABEL_MAX } from "./adminLookups";
import { isMilestoneKind, type MilestoneKind, MILESTONE_ITEM_LABEL_MAX, MILESTONE_KINDS, MILESTONE_OFFSET_MAX, MILESTONE_TEMPLATE_DESCRIPTION_MAX, MILESTONE_TEMPLATE_NAME_MAX, type MilestoneTemplateFields } from "./adminMilestoneTemplates";
import { FILE_TYPE_FOLDER_PATTERN, FILE_TYPE_KEY_PATTERN, FILE_TYPE_NAME_MAX, type FileTypeEditableFields } from "./adminFileTypes";
import { CURRENCY_NAME_MAX, CURRENCY_SYMBOL_MAX, isCurrencyCodeForSet, isVatPercentage, VAT_RATE_NAME_MAX, type CurrencyEditableFields, type VatRateEditableFields } from "./adminCommercialLookups";
import { isCatalogueAmount, isTemplateQuantity, JOB_ITEM_AMOUNT_MAX, JOB_ITEM_CODE_PATTERN, JOB_ITEM_DESCRIPTION_MAX, JOB_ITEM_HOURS_MAX, JOB_ITEM_NAME_MAX, JOB_TYPE_ITEMS_MAX, type JobItemEditableFields, type JobTypeTemplateEntry } from "./adminServiceCatalogue";
import { isCurrencyCode, isWorkEmail, STAFF_NAME_MAX, STAFF_RATE_MAX } from "./adminStaff";
import { MESSAGE_TEMPLATE_BODY_MAX, MESSAGE_TEMPLATE_SUBJECT_MAX, messageTemplateDefinition, messageTemplateRequiredIssues, messageTemplateTokenIssues } from "./messageTemplates";
import { BD_STAGE_KEY_PATTERN, BD_STAGE_NAME_MAX, BD_STAGE_ORDER_MAX, isStageProbability, type BdStageEditableFields } from "./adminCrmBd";
import { CUSTOM_FIELD_DEFAULT_MAX, CUSTOM_FIELD_KEY_PATTERN, CUSTOM_FIELD_LABEL_MAX, customFieldOptionIssues, customFieldValueIssue, isCustomFieldEntityType, isCustomFieldType, type CustomFieldEditableFields, type CustomFieldEntityType, type CustomFieldType } from "./adminCustomFields";
import { isIsoCountryCode } from "./iso3166";
import { isTimeEntryMinutes, isTimeQuantity, JOB_BUDGET_MAX_HOURS, JOB_FEE_MAX, TIME_ACTIVITY_CATEGORY, TIME_CAPACITY_MAX_HOURS, TIME_ENTRY_NOTE_MAX } from "./time";
import { todayInLondon } from "./dayValues";
import { isAllowedBroadcastLink, isBroadcastInstant, isPortalBroadcastStyle, PORTAL_BROADCAST_BODY_MAX, PORTAL_BROADCAST_LINK_LABEL_MAX, PORTAL_BROADCAST_TITLE_MAX, type PortalBroadcastEditableFields } from "./adminPortalBroadcasts";
import { isValidWebsite, normaliseWebsite } from "./clientWebsite";
import { isAgreedRate, isSupplierContactEmail, SUPPLIER_CONTACT_NAME_MAX, SUPPLIER_CONTACT_PHONE_MAX, SUPPLIER_COST_TYPE_MAX, SUPPLIER_ITEM_DESCRIPTION_MAX, SUPPLIER_ITEM_NAME_MAX, SUPPLIER_NAME_MAX, SUPPLIER_WEBSITE_MAX, type SupplierContactFields, type SupplierEditableFields, type SupplierItemEditableFields } from "./adminSuppliers";
import { bankIssues, normaliseBank, normaliseProfile, ORGANISATION_BANK_FIELDS, ORGANISATION_PROFILE_FIELDS, profileIssues, type OrganisationBankFields, type OrganisationProfileFields } from "./adminOrganisation";
import { isJobTypeFamily, isTwoDecimalAmount, JOB_TYPE_CODE_MAX, JOB_TYPE_DESCRIPTION_MAX, JOB_TYPE_HOURS_MAX, JOB_TYPE_NAME_MAX, JOB_TYPE_PRICE_MAX, type JobTypeFields } from "./adminJobTypes";
import { jobDateIssues } from "./jobDates";
import { isActivityFrequency, type ActivityFrequency } from "./activityDistribution";
import type { CapturedVia } from "./entryProvenance";
import type { AssistRecord } from "./aiAssist";
import type { ReportIssuer } from "./reportComposition";
import { isAllowedTrainingRunStageTransition } from "./trainingWorkflow";
import {
  estimateConfidences, estimateScopes, estimateSources, estimateUnits,
  type EstimateConfidence, type EstimateScope, type EstimateSource, type EstimateUnit,
} from "./strategyProjection";
import { contactConsentDecisions, isStaffRecordableBasis, type ContactConsentBasis, type ContactConsentDecision, type ContactConsentState } from "./contactConsent";
import { strategyScopes, strategyControlLevels, strategyStatuses } from "./reductionStrategies";
import { intensityDividers, intensityUnitKinds, isIntensityIconKey, type IntensityDivider, type IntensityUnitKind } from "./intensityMetrics";
import type { SpendImportColumnMap, SpendImportRow } from "./spendImport";
import type { ReportSectionReadModel } from "./reportSections";
import type { SnapshotProvenanceStamp } from "./evidence";
import { staffRoles, type Capability, type CommandGrant, type StaffRole } from "./permissions";
import { isCrpReportSectionKey } from "./reportSections";
import type { LcaAssessmentType, LcaAssessmentWriteFields, LcaGapFillWriteFields, LcaLifecycleBoundary, LcaLineItemWriteFields, LcaModuleCode, LcaScenarioMultiplierWriteFields, LcaScenarioWriteFields, LcaTransportLegWriteFields } from "./jobFamilies";
import { lcaModuleCodes, lcaTransportModes } from "./jobFamilies";

export type CommandKey =
  | "client.create"
  | "client.update"
  | "job.create"
  | "job.stage.change"
  | "job.milestone.set"
  | "job.milestone.complete"
  | "job.milestone.reopen"
  | "job.milestone.reschedule"
  | "job.update"
  | "scope.row.create"
  | "scope.row.update"
  | "scope.row.calculate"
  | "scope.row.discard"
  | "scope.row.deactivate"
  | "scope.row.reactivate"
  | "scope.review.approve"
  | "scope.review.reject"
  | "report.publish"
  | "report.validate"
  | "report.snapshot.create"
  | "report.snapshot.approve"
  | "client.contact.create"
  | "client.contact.update"
  | "client.contact.deactivate"
  | "client.contact.consent.record"
  | "client.targets.set"
  | "training.booking.create"
  | "training.attendance.set"
  | "training.certificate.issue"
  | "training.entitlement.expiry.set"
  | "training.run.stage.set"
  | "training.run.review"
  | "client.intensityMetric.set"
  | "client.intensityMetric.deactivate"
  | "client.intensityTarget.set"
  | "client.intensityTarget.deactivate"
  | "job.intensityValue.set"
  | "strategy.library.upsert"
  | "strategy.library.deactivate"
  | "reference.value.create"
  | "reference.value.update"
  | "reference.value.deactivate"
  | "reference.value.reinstate"
  | "job_type.create"
  | "job_type.update"
  | "job_type.deactivate"
  | "job_type.reinstate"
  | "milestone_template.create"
  | "milestone_template.update"
  | "milestone_template.set_default"
  | "milestone_template.deactivate"
  | "milestone_template.reinstate"
  | "job_file_type.create"
  | "job_file_type.update"
  | "job_file_type.deactivate"
  | "job_file_type.reinstate"
  | "vat.create"
  | "vat.update"
  | "vat.set_default"
  | "vat.deactivate"
  | "vat.reinstate"
  | "currency.create"
  | "currency.update"
  | "currency.set_default"
  | "currency.deactivate"
  | "currency.reinstate"
  | "job_item.create"
  | "job_item.update"
  | "job_item.deactivate"
  | "job_item.reinstate"
  | "job_item.price.set"
  | "job_type.items.set"
  | "supplier.create"
  | "supplier.update"
  | "supplier.deactivate"
  | "supplier.reinstate"
  | "supplier.contact.add"
  | "supplier.contact.update"
  | "supplier.contact.deactivate"
  | "supplier.contact.reinstate"
  | "supplier_item.create"
  | "supplier_item.update"
  | "supplier_item.deactivate"
  | "supplier_item.reinstate"
  | "supplier_item.rate.set"
  | "message_template.create"
  | "message_template.update"
  | "message_template.deactivate"
  | "message_template.reinstate"
  | "bd_stage.create"
  | "bd_stage.update"
  | "bd_stage.deactivate"
  | "bd_stage.reinstate"
  | "custom_field.create"
  | "custom_field.update"
  | "custom_field.deactivate"
  | "custom_field.reinstate"
  | "portal_broadcast.create"
  | "portal_broadcast.update"
  | "portal_broadcast.deactivate"
  | "portal_broadcast.reinstate"
  | "staff.add"
  | "staff.update"
  | "staff.role.assign"
  | "staff.deactivate"
  | "staff.reinstate"
  | "staff.rate.set"
  | "organisation.profile.update"
  | "organisation.logo.set"
  | "organisation.logo.remove"
  | "organisation.bank.set"
  | "organisation.intensityDefault.set"
  | "organisation.intensityDefault.deactivate"
  | "organisation.intensityDefaults.apply"
  | "client.strategy.assign"
  | "client.strategy.update"
  | "client.strategy.remove"
  | "client.strategy.estimate.set"
  | "knowledge.capture"
  | "knowledge.alias.add"
  | "knowledge.edit"
  | "knowledge.approve"
  | "knowledge.publish"
  | "knowledge.reject"
  | "knowledge.merge"
  | "srs.assessment.start"
  | "srs.assessment.item.set"
  | "srs.assessment.complete"
  | "client.logo.set"
  | "client.logo.remove"
  | "report.section.edit"
  | "report.section.reset"
  | "report.section.regenerate"
  | "assurance.gap.resolve"
  | "emissions.target.upsert"
  | "site.create"
  | "site.edit"
  | "site.location.set"
  | "time.entry.log"
  | "time.entry.edit"
  | "time.entry.void"
  | "time.entry.bill"
  | "staff.capacity.set"
  | "job.budget.set"
  | "job.fee.set"
  | "client.location.set"
  | "site.registeredOffice"
  | "site.vacate"
  | "site.reinstate"
  | "site.archive"
  | "site.unarchive"
  | "site.floorArea.record"
  | "emissions.intensity.upsert"
  | "purchased.goods.category.create"
  | "subject.review.decide"
  | "client.category.visibility.set"
  | "client.factor.alias.set"
  | "client.factor.create"
  | "client.factor.update"
  | "client.factor.archive"
  | "emission.source.group.create"
  | "emission.source.group.sync"
  | "emission.source.create"
  | "emission.source.sync"
  | "emission.source.activity.update"
  | "emission.source.status.update"
  | "emission.source.rollforward"
  | "scope.row.rollforward"
  | "emission.source.import.commit"
  | "emission.source.import.void"
  | "client.import.mapping.save"
  | "dataset.override.add"
  | "portal.access.grant"
  | "sales.opportunity.convert"
  | "lca.assessment.create"
  | "lca.assessment.update"
  | "lca.lineItem.create"
  | "lca.lineItem.update"
  | "lca.lineItem.delete"
  | "lca.lineItem.bulkCreate"
  | "lca.transportLeg.create"
  | "lca.transportLeg.update"
  | "lca.transportLeg.delete"
  | "lca.lineItem.gapFill"
  | "lca.assessment.calculate"
  | "lca.assessment.review.approve"
  | "lca.assessment.review.reject"
  | "lca.assessment.snapshot.create"
  | "lca.scenario.create"
  | "lca.scenario.update"
  | "lca.scenario.delete"
  | "lca.scenario.multiplier.set"
  | "lca.scenario.multiplier.delete";

export const jobWorkflowStages = {
  // NZC-057 — "Factor mapping" retired as a CRP stage (factor selection is inline
  // at capture; unmatched-factor rows are a "Needs attention" exception within
  // Data entry). CRP-only — `pcf` keeps its "Factor mapping" stage.
  crp: ["Setup", "Data entry", "Review & QA", "Report & publish"],
  consultancy: ["Scope", "Plan", "Delivery", "Client review", "Complete"],
  lca: ["Goal & scope", "Inventory", "Impact assessment", "Interpretation", "Report"],
  pcf: ["Product boundary", "BOM", "Factor mapping", "Review", "Report"],
  training: ["Course setup", "Bookings", "Delivery", "Attendance", "Certificates"],
} as const;
export type WorkflowJobFamily = keyof typeof jobWorkflowStages;

/**
 * Whether a job of this family reports on a period (NZC-092).
 *
 * Carbon reporting does; a training course, an LCA study or a consultancy engagement does not —
 * they have a start and an end, and nothing they produce is labelled by a reporting year. Part 1
 * first required a period of every family, which gave a training job an emissions reporting year
 * and no window to go with it.
 *
 * **One predicate, three gates.** The form asks for the period, the command requires it, and the
 * emissions config is created — each of those used to test the family separately, and a literal
 * `family === "crp"` in three places is three chances to disagree the day a second family starts
 * reporting. Change this function and all three move together.
 */
export const familyHasReportingPeriod = (family: WorkflowJobFamily): boolean => family === "crp";
export type ScopeQualityTier = "measured" | "estimated" | "spend-based" | "survey";
export type MonthlyActivitySlot = { month:string; quantity:number|null };
/**
 * How a Scope 2 row was accounted for (NZC-143).
 *
 * A Scope 2 concept only: purchased energy can be measured by what the grid emitted or by what the
 * contract says was bought, and no other scope has the equivalent question. The headline total is
 * location-based and a market row is never summed into it.
 */
export type Scope2Method = "location" | "market";

/**
 * How purchased electricity reached the site (NZC-159).
 *
 * Enumerated positively, and `self-generated` is a member rather than an exclusion: the transmission
 * companion names the values that fire it, so a supply kind added here claims no losses until somebody
 * decides it should (NZC-154).
 */
export type SupplySource = "grid" | "grid-renewable" | "green-tariff" | "rego" | "self-generated";

export const SUPPLY_SOURCES: readonly SupplySource[] =
  ["grid", "grid-renewable", "green-tariff", "rego", "self-generated"];

/** What a person sees for each, so the surface and the spec cannot name them differently. */
export const SUPPLY_SOURCE_LABELS: Readonly<Record<SupplySource, string>> = {
  "grid": "Grid supply",
  "grid-renewable": "Grid — renewable tariff",
  "green-tariff": "Green tariff",
  "rego": "REGO-backed",
  "self-generated": "Generated and used on site",
};
export const scope2MethodValues: readonly Scope2Method[] = ["location", "market"] as const;

/**
 * What a vehicle lookup said about the vehicle, carried to the write so it can re-resolve (Stop 2, F3).
 *
 * **Attributes, never the plate** (NZC-103): the registration stops at the lookup boundary, so the write cannot
 * repeat the lookup and is handed what it returned instead. Asserted by whoever captured the entry, and recorded
 * as such in provenance — the same trust as any figure a person types, and auditable.
 */
export type AssertedVehicleAttributes = {
  /** What the lookup was: the live DVLA service or the staging stub. */
  source: "dvla" | "stub";
  /** The fuel keyword the lookup flow derives (`diesel`, `petrol`, …), or null when it could not. */
  fuel: string | null;
  /** The coarse class the lookup flow derives (`car`, `van`, `hgv`, `motorbike`). */
  vehicleClass: string | null;
};

export const crpScopeOptions = [
  { value: "1", label: "Scope 1 · Direct emissions", category: "Direct emissions" },
  { value: "2", label: "Scope 2 · Purchased energy", category: "Purchased energy" },
  { value: "3.1", label: "Scope 3.1 · Purchased goods and services" },
  { value: "3.2", label: "Scope 3.2 · Capital goods" },
  { value: "3.3", label: "Scope 3.3 · Fuel- and energy-related activities" },
  { value: "3.4", label: "Scope 3.4 · Upstream transportation and distribution" },
  { value: "3.5", label: "Scope 3.5 · Waste generated in operations" },
  { value: "3.6", label: "Scope 3.6 · Business travel" },
  { value: "3.7", label: "Scope 3.7 · Employee commuting" },
  { value: "3.8", label: "Scope 3.8 · Upstream leased assets" },
  { value: "3.9", label: "Scope 3.9 · Downstream transportation and distribution" },
  { value: "3.10", label: "Scope 3.10 · Processing of sold products" },
  { value: "3.11", label: "Scope 3.11 · Use of sold products" },
  { value: "3.12", label: "Scope 3.12 · End-of-life treatment of sold products" },
  { value: "3.13", label: "Scope 3.13 · Downstream leased assets" },
  { value: "3.14", label: "Scope 3.14 · Franchises" },
  { value: "3.15", label: "Scope 3.15 · Investments" },
] as const;
export type CrpScopeCode = (typeof crpScopeOptions)[number]["value"];
const crpScopeCategories: Record<CrpScopeCode, string> = {
  "1":"Direct emissions","2":"Purchased energy","3.1":"Purchased goods and services","3.2":"Capital goods","3.3":"Fuel- and energy-related activities","3.4":"Upstream transportation and distribution","3.5":"Waste generated in operations","3.6":"Business travel","3.7":"Employee commuting","3.8":"Upstream leased assets","3.9":"Downstream transportation and distribution","3.10":"Processing of sold products","3.11":"Use of sold products","3.12":"End-of-life treatment of sold products","3.13":"Downstream leased assets","3.14":"Franchises","3.15":"Investments",
};
export function crpScopeCategoryPath(scope: string): string[] {
  const option = crpScopeOptions.find((item) => item.value === scope);
  if (!option) return [];
  const category = crpScopeCategories[option.value];
  return scope.startsWith("3.") ? ["Scope 3", category] : [`Scope ${scope}`, category];
}

/** Verbatim GHG-Protocol category name for a scope code (e.g. "3.7" → "Employee commuting"). */
export function crpScopeCategoryLabel(scope: string): string {
  const option = crpScopeOptions.find((item) => item.value === scope);
  return option ? crpScopeCategories[option.value] : scope;
}

// NZC-046 — the stored data-entry category taxonomy for the scope→category
// accordion. Names are verbatim (no relabelling); `kind` drives the entry form's
// progressive disclosure (spend fields only under `spend`; the DVLA registration
// finder under `vehicle` / `travel` / `commuting`; `fugitive` = refrigerant
// top-ups). Scope 3 codes align with `crpScopeOptions` / the canonical row scope.
export type EmissionCategoryKind = "manual" | "spend" | "vehicle" | "travel" | "commuting" | "fugitive";
export type EmissionCategory = { scope: "1" | "2" | "3"; code: string; name: string; kind: EmissionCategoryKind };
export const emissionCategoryTaxonomy: readonly EmissionCategory[] = [
  { scope: "1", code: "1.natural-gas", name: "Natural Gas", kind: "manual" },
  { scope: "1", code: "1.company-vehicles", name: "Company Vehicles", kind: "vehicle" },
  { scope: "1", code: "1.refrigerants", name: "Refrigerants", kind: "fugitive" },
  { scope: "2", code: "2.purchased-electricity", name: "Purchased Electricity", kind: "manual" },
  { scope: "2", code: "2.renewable-electricity", name: "Renewable Electricity", kind: "manual" },
  { scope: "3", code: "3.1", name: "Purchased Goods and Services", kind: "spend" },
  { scope: "3", code: "3.2", name: "Capital Goods", kind: "spend" },
  { scope: "3", code: "3.3", name: "Fuel & Energy Related", kind: "manual" },
  { scope: "3", code: "3.4", name: "Upstream Transportation & Distribution", kind: "manual" },
  { scope: "3", code: "3.5", name: "Waste in Operations", kind: "manual" },
  { scope: "3", code: "3.6", name: "Business Travel", kind: "travel" },
  { scope: "3", code: "3.7", name: "Employee Commuting", kind: "commuting" },
  { scope: "3", code: "3.8", name: "Upstream Leased Assets", kind: "manual" },
  { scope: "3", code: "3.9", name: "Downstream Transportation & Distribution", kind: "manual" },
  { scope: "3", code: "3.10", name: "Processing of Sold Products", kind: "manual" },
  { scope: "3", code: "3.11", name: "Use of Sold Products", kind: "manual" },
  { scope: "3", code: "3.12", name: "End-of-Life Treatment", kind: "manual" },
  { scope: "3", code: "3.13", name: "Downstream Leased Assets", kind: "manual" },
  { scope: "3", code: "3.14", name: "Franchises", kind: "manual" },
  { scope: "3", code: "3.15", name: "Investments", kind: "spend" },
] as const;
export const scopeMeta: Record<"1" | "2" | "3", { label: string }> = {
  "1": { label: "Scope 1 · Direct" }, "2": { label: "Scope 2 · Purchased energy" }, "3": { label: "Scope 3 · Value chain" },
};
/** The applicable-category read model. CRM = the completeness view (all taxonomy categories for included scopes); portal = authorised only. */
export type ApplicableCategory = EmissionCategory & { entryCount: number; tco2e: number; completeness: number; noData: boolean; authorised?: boolean };
export type JobApplicableCategories = { audience: "crm" | "portal"; includedScopes: Array<"1" | "2" | "3">; categories: ApplicableCategory[] };
export type ScopeRowWriteFields = {
  /** How this figure reached the commit (NZC-111). Absent is manual, which is a fact and not a guess. */
  capturedVia?: CapturedVia|null;
  /** The structured proposal a person accepted, and what they changed. Never the raw text. */
  assistRecord?: AssistRecord|null;
  activityFrequency?: ActivityFrequency|null; activityFigures?:(number|null)[]|null; scope: string; scope2Method?: Scope2Method|null;
  /**
   * How purchased electricity reached the site (NZC-159).
   *
   * Determinative rather than descriptive: it decides whether a transmission-and-distribution companion
   * row exists at all (NZC-154), which is why lean capture keeps it while dropping quality and confidence.
   * Absent until answered, and the companion declines while it is.
   */
  supplySource?: SupplySource|null;
  /** What a vehicle lookup returned, for the write to re-resolve from. Never the plate (F3, NZC-103). */
  assertedVehicleAttributes?: AssertedVehicleAttributes|null;
  /**
   * Why a factor other than the category's declared one was chosen on purpose (Stop 2b).
   *
   * F1 refuses a factor that differs from the declared one unless the deviation is deliberate. Before this a
   * deliberate choice could only be expressed by overriding the emissions figure or using a client factor, so a
   * chosen alternative dataset factor had no honest way in. With a reason, a different factor is accepted —
   * provided it is one the row may carry — and recorded with the reason and the actor.
   */
  factorOverrideReason?: string|null;
  showInReport?: boolean; categoryCode?: string | null; sourceLabel: string; assetIdentifier?:string|null; reportLabel?:string|null; notes?:string|null; monthlyActivity?:MonthlyActivitySlot[]; siteId?:string|null;siteLabel?:string|null;purchasedGoodsCategoryId?:string|null;purchasedGoodsCategoryLabel?:string|null;quantity: number | null; unit: string | null; datasetId: string | null; factorId: string | null; factorVersion: string | null; factorLabel: string | null; qualityTier: ScopeQualityTier | null; overrideTco2e?: number | null; overrideReason?: string | null; factorSource?: FactorSource; clientFactorId?: string | null; isCustomEntry?: boolean; applyPct?: number | null; dataConfidence?: DataConfidence | null; sourceQuantity?: number | null; sourceUnit?: string | null; columnText?: string | null; sourceId?: string | null; groupId?: string | null; linkedRowId?: string | null; isAutoGenerated?: boolean; autoPairKind?: string | null };
export type SiteOption={id:string;name:string};
export type PurchasedGoodsCategoryOption={id:string;name:string};
export type ScopeRowReadModel = ScopeRowWriteFields & { id: string; jobId: string; reportLabel:string; categoryPath:string[]; categoryCode?: string | null; monthlyActivity:MonthlyActivitySlot[]; calculatedTco2e: number | null; overrideTco2e: number | null; overrideReason: string | null; reviewStatus: "pending" | "approved" | "rejected"; reviewedRowVersion:number|null;reviewedBy:string|null;reviewedAt:string|null;reviewerNote:string|null; version: number; enabled: boolean; clientFactorVersionMoved?: boolean; /** Imported from v7 (0133) or captured in the console; read-only. */ origin?: "live" | "migrated";
  /** A 3.3 row, which may not include transmission & distribution losses: prompt to consider adding T&D. A completeness nudge, never blocking (NZC-160 H4, as ruled). */
  tdAddPrompt?: boolean; provenance: Record<string, unknown>; lineage: Array<{ title: string; detail: string }> };
export type ScopeQaReadiness={total:number;enabled:number;approved:number;pending:number;rejected:number;calculationMissing:number;qualityMissing:number;independentReviewPending:number;/** Decision 12: rows imported from v7. Any at all makes this an imported period, never ready for a console snapshot. */migratedRows:number;readyForReporting:boolean};
export type EmissionsTargetReadModel={jobId:string;baselineYear:number;baselineTco2e:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;version:number;updatedAt:string;updatedBy:string};
/** NZC-071 — where an intensity denominator came from. A floor-area metric is always derived from the in-boundary sites. */
export type IntensityDenominatorBasis={kind:"typed"}|{kind:"site-floor-area";state:"resolved"|"unavailable";reason:string|null;sites:Array<{siteId:string;name:string;floorAreaM2:number|null}>};
/** `reportingDenominator` is null when it cannot be resolved (a floor-area metric with a site missing its floor area) — never zero. */
export type IntensityTargetReadModel={jobId:string;metric:"turnover"|"employee"|"floor-area";denominatorUnit:string;reportingDenominator:number|null;denominatorBasis?:IntensityDenominatorBasis;baselineYear:number;baselineIntensity:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;version:number;updatedAt:string;updatedBy:string};
export type AnnualScopeComparison={year:number;sourceSnapshotId:string;sourceDataHash:string;values:Array<{scope:"1"|"2"|"3";value:number}>};
export type ReviewedCrpSnapshotReadModel={id:string;jobId:string;jobNumber:string;client:string;reportingYear:number;version:number;jobVersion:number;createdAt:string;createdBy:string;/** NZC-022 — the approver (never the preparer, createdBy); null until approved. */approvedBy?:string|null;approvedAt?:string|null;dataHash:string;target:EmissionsTargetReadModel|null;intensityTarget:IntensityTargetReadModel|null;annualComparison:AnnualScopeComparison[];sections:ReportSectionReadModel[];gapResolutions:Array<{gapKey:string;reason:string;resolvedBy:string;resolvedAt:string}>;/** NZC-066/070 — stamped at issue; absent on snapshots issued before stamping. */provenance?:SnapshotProvenanceStamp|null;measurements:Array<{rowId:string;rowVersion:number;scope:"1"|"2"|"3";scopeCode?:string;sourceLabel:string;/** Present only on snapshots issued before NZC-104 stopped writing it — never read, never written now. */assetIdentifier?:string|null;reportLabel?:string;columnText?:string|null;notes?:string|null;categoryPath?:string[];monthlyActivity?:MonthlyActivitySlot[];siteId?:string|null;siteLabel?:string|null;purchasedGoodsCategoryId?:string|null;purchasedGoodsCategoryLabel?:string|null;factorSource?:FactorSource;clientFactorId?:string|null;isCustomEntry?:boolean;applyPct?:number;dataConfidence?:DataConfidence|null;sourceQuantity?:number|null;sourceUnit?:string|null;tco2e:number;factorSet:string;qualityTier:ScopeQualityTier;reviewedBy:string}>};
/** The signee chosen at validation (a report-signee contact), frozen onto the version. */
export type ReportSignee={name:string;jobTitle:string|null};
/** `clientLogoAssetId` — the client logo frozen onto the version at validation; null = the monogram. `issuer` — the issuing
 * organisation frozen at validation (0143); pre-D3 versions carry the backfill. */
export type PublishedCrpReportReadModel={reportVersionId:string;manifestVersion:number;publishedAt:string;dataHash:string;signee?:ReportSignee|null;clientLogoAssetId?:string|null;issuer?:ReportIssuer|null;snapshot:ReviewedCrpSnapshotReadModel};
export type CrpReportVersionReadModel={reportVersionId:string;status:"validated"|"published"|"superseded";manifestVersion:number;publishedAt:string|null;dataHash:string;signee?:ReportSignee|null;clientLogoAssetId?:string|null;issuer?:ReportIssuer|null;snapshot:ReviewedCrpSnapshotReadModel};
/** NZC-062 — the GHG-protocol category each of a factor's `scopes` entries resolves to (`crpScopeCategoryLabel`). */
export type FactorOptionCategory = { scope: "1" | "2" | "3"; scopeCode: string; label: string };
export type FactorOption = { datasetId: string|null; datasetName: string; datasetVersion: string; factorId: string; label: string; activityUnit: string; kgco2ePerUnit: number; scopes: string[]; categories: FactorOptionCategory[]; selectionSource: "automatic" | "manual" | "client"; factorSource:FactorSource;clientFactorId:string|null;evidenceHash:string|null; synthetic: boolean; warnings: string[] };
export type DatasetOption = { datasetId: string; name: string; version: string; validFrom: string; validTo: string; countryCode: string; status: "active" | "superseded" | "draft"; synthetic: boolean; selected: boolean; selectionSource: "automatic" | "manual" | null; applicable: boolean; warnings: string[]; reportingFrom: string; reportingTo: string; jobCountryCode: string };
export function isAllowedJobStageTransition(family: WorkflowJobFamily, from: string, to: string): boolean {
  const stages: readonly string[] = jobWorkflowStages[family];
  const fromIndex = stages.indexOf(from); const toIndex = stages.indexOf(to);
  return fromIndex >= 0 && toIndex >= 0 && Math.abs(toIndex - fromIndex) === 1;
}

export type CommandContext = {
  organisationId: string;
  actorId: string;
  /** `system` is the operator break-glass (`staff:role`, ruled Q9); every console request is `staff`. */
  principal: "staff" | "system";
  idempotencyKey: string;
  correlationId: string;
  reason?: string;
  /** NZC-022 — the actor's capabilities, from the resolved staff principal. The runner refuses a command without it. */
  grant: CommandGrant;
};
export type CommandIssue = { field: string; code: string; message: string };
export type CommandOutcome<T = Record<string, unknown>> =
  | { state: "success"; data: T; auditEventId: string; correlationId: string; replayed: boolean }
  | { state: "conflict"; code: string; message: string; correlationId: string }
  | { state: "denied"; permission: string; message: string; correlationId: string }
  | { state: "validation_failed"; issues: CommandIssue[]; correlationId: string }
  | { state: "failed"; code: string; message: string; retryable: boolean; correlationId: string };

export type ClientReportingFrequency = "annual" | "quarterly" | "monthly";
export type ClientGroupStructure = "standalone" | "subsidiary" | "parent" | "joint-venture";
export const clientReportingFrequencies = ["annual", "quarterly", "monthly"] as const;
export const clientGroupStructures = ["standalone", "subsidiary", "parent", "joint-venture"] as const;
export const clientReportingFrameworks = ["SECR", "PPN 06/21", "GHG Protocol", "CDP", "TCFD", "SBTi", "ISO 14064", "ESOS", "CSRD", "Voluntary CRP"] as const;
export const clientCertifications = ["ISO 14001", "ISO 50001", "B Corp", "SBTi pledge", "RE100", "Race to Zero", "PAS 2060", "Carbon Neutral certified"] as const;

/** Firmographics and reporting settings — the live CRM's Details tab. */
export type ClientDetailsFields = {
  portfolio?: string | null; clientManager?: string | null; website?: string | null;
  /** NZC-090 — the references behind `clientManager` and `referral`, alongside their text. */
  clientManagerUserId?: string | null; referralValueId?: string | null; sectorValueId?: string | null;
  /** CLIENT-01 — the portfolio lookup value (0138's `portfolios`), beside the `portfolio` text, as sector and referral. */
  portfolioValueId?: string | null;
  industrySic?: string | null; companyRegistration?: string | null; headquarters?: string | null;
  financialYearEndMonth?: number | null; dataReportingFrequency?: ClientReportingFrequency;
  currency?: string; logoUrl?: string | null; companyDescription?: string | null; referral?: string | null;
  contactName?: string | null; contactRole?: string | null; contactEmail?: string | null;
};
/** The net-zero trajectory reporting and portal dashboards read (WORKFLOWS.md §2). */
export type ClientTargetFields = {
  netZeroTargetYear?: number | null; netZeroTargetReductionPct?: number | null;
  baselinePeriodStart?: string | null; baselinePeriodEnd?: string | null;
  baselineScope1Tco2e?: number | null; baselineScope2Tco2e?: number | null;
  baselineScope3Tco2e?: number | null; baselineTotalTco2e?: number | null;
  scope1InterimYear?: number | null; scope1InterimReductionPct?: number | null;
  scope2InterimYear?: number | null; scope2InterimReductionPct?: number | null;
  scope3InterimYear?: number | null; scope3InterimReductionPct?: number | null;
};
export type ClientAddressFields = {
  registeredAddressLine1?: string | null; registeredAddressLine2?: string | null;
  registeredCity?: string | null; registeredRegion?: string | null;
  registeredPostcode?: string | null; registeredCountry?: string | null;
  billingSameAsRegistered?: boolean; billingCompany?: string | null;
  billingAddressLine1?: string | null; billingAddressLine2?: string | null;
  billingCity?: string | null; billingRegion?: string | null;
  billingPostcode?: string | null; billingCountry?: string | null;
};
export type ClientComplianceFields = {
  parentCompany?: string | null; groupStructure?: ClientGroupStructure | null;
  reportingFrameworks?: string[]; certifications?: string[]; primaryScope3Categories?: string[];
};
export type ClientProfileFields = ClientDetailsFields & ClientTargetFields & ClientAddressFields & ClientComplianceFields;

/** The client-level baseline fields; changing any of them on an existing client is a re-baseline (NZC-068). */
export const clientBaselineFields = [
  "baselinePeriodStart", "baselinePeriodEnd", "baselineScope1Tco2e", "baselineScope2Tco2e", "baselineScope3Tco2e", "baselineTotalTco2e",
] as const satisfies ReadonlyArray<keyof ClientTargetFields>;

/**
 * What a contact is for. Each role feeds one downstream picker: report signees
 * appear on published reports, portal candidates can be invited to the portal,
 * invoice recipients receive commercial documents, training attendees are
 * eligible for training places. `primary` is a separate flag, one per client.
 */
export const clientContactRoles = ["report_signee", "portal_candidate", "invoice_recipient", "training_attendee"] as const;
export type ClientContactRole = (typeof clientContactRoles)[number];
export const clientContactRoleLabels: Record<ClientContactRole, string> = {
  report_signee: "Report signee", portal_candidate: "Portal candidate", invoice_recipient: "Quote & invoice recipient", training_attendee: "Training attendee",
};
export type ClientContactWriteFields = { fullName: string; jobTitle?: string | null; email?: string | null; phone?: string | null; isPrimary: boolean; roles: ClientContactRole[] };
export type ClientContactReadModel = { id: string; clientId: string; fullName: string; jobTitle: string | null; email: string | null; phone: string | null; isPrimary: boolean; roles: ClientContactRole[]; status: "active" | "inactive"; version: number; updatedAt: string; updatedBy: string ; /** `0083` default is `unknown`, which blocks. The basis behind it travels separately, in the consent events. */ emailConsent: ContactConsentState };

/** A milestone is a year and the reduction committed to by then; both or neither. */
export type TargetMilestoneFields = { year: number | null; pct: number | null };
export type ForwardTargetWriteFields = {
  nearTerm: TargetMilestoneFields;
  netZero: TargetMilestoneFields;
  scope1: TargetMilestoneFields;
  scope2: TargetMilestoneFields;
  scope3: TargetMilestoneFields;
};
export const forwardTargetFields = ["nearTerm", "netZero", "scope1", "scope2", "scope3"] as const;
export const forwardTargetLabels: Record<(typeof forwardTargetFields)[number], string> = {
  nearTerm: "Near-term target", netZero: "Net-zero target", scope1: "Scope 1 target", scope2: "Scope 2 target", scope3: "Scope 3 target",
};

/**
 * A client's logo: PNG, SVG, JPEG or WebP (CLIENT-02, 0153). Staging storage only — never committed to the repo. Each is
 * checked by its own signature before it is stored (`inspectClientLogo`).
 */
export const clientLogoContentTypes = ["image/png", "image/svg+xml", "image/jpeg", "image/webp"] as const;
export type ClientLogoContentType = (typeof clientLogoContentTypes)[number];
/** The organisation's own logo stays PNG or SVG (0142): the ruling widened the client logo only. */
export const organisationLogoContentTypes = ["image/png", "image/svg+xml"] as const satisfies readonly ClientLogoContentType[];
export type OrganisationLogoContentType = (typeof organisationLogoContentTypes)[number];
export const CLIENT_LOGO_MAX_BYTES = 256 * 1024;
/**
 * `sector` and `owner` still carry the text shown on the record; the `*Id` fields carry the
 * curated reference behind it (NZC-090). Both, not either: the id is what makes a rename in the
 * lookup reach every client that chose it, and the text is what a client keeps when its value was
 * never in the list — which the first backfill showed is most of them.
 */
export type ClientIdentityFields = {
  name: string; status: "active" | "onboarding" | "at-risk" | "prospect";
  sector: string; location: string; owner: string;
  sectorValueId?: string | null;
  ownerUserId?: string | null;
};

export type CommandInputMap = {
  "client.create": ClientIdentityFields & ClientProfileFields;
  "client.update": { clientId: string; expectedVersion: number } & ClientIdentityFields & ClientProfileFields;
  /**
   * `owner` carries the client manager's name and `clientManagerUserId` the reference to them —
   * the NZC-090 pair, on the columns `jobs` already had (NZC-092). The screen says "Client
   * manager"; `owner_name` keeps its historical name because renaming it is neither trivial nor
   * safe.
   *
   * `reportingYear` is absent on purpose: it is derived from `reportingPeriodEnd` and never sent.
   */
  "job.create": { clientId: string; family: "crp" | "consultancy" | "lca" | "pcf" | "training"; title: string; workflowStage: string; owner: string; clientManagerUserId?: string | null; startDate: string; dueDate: string; reportingPeriodStart?: string | null; reportingPeriodEnd?: string | null;
    /** PR 3: the job type the job is of (its family must match), and its milestone template — a string is the per-job
     *  choice, null is "no milestones", omitted falls back to the job type's, then the organisation's default. */
    jobTypeId?: string | null; milestoneTemplateId?: string | null };
  /** PR 3 — the milestone command. A kind's date by hand (null clears it); refused on a completed milestone. */
  "job.milestone.set": { jobId: string; kind: MilestoneKind; dueDate: string | null; expectedVersion?: number };
  /** Completed today, or on a past day (M5); idempotent — an already-completed milestone is returned unchanged. */
  "job.milestone.complete": { jobId: string; kind: MilestoneKind; completedAt?: string; expectedVersion?: number };
  "job.milestone.reopen": { jobId: string; kind: MilestoneKind; expectedVersion: number };
  /** Recompute the uncompleted template rows from the job's template (optionally a new one; null = none) and anchor. */
  "job.milestone.reschedule": { jobId: string; milestoneTemplateId?: string | null; expectedVersion: number };
  /** Edit a job's start date, reporting period and milestone template (ruled job-update-plan.md, J1–J6). A field
   *  left out is unchanged. A period change needs a reason (J5), and is refused once period-bound data exists (J1). */
  "job.update": { jobId: string; expectedVersion: number; startDate?: string; reportingPeriodStart?: string | null; reportingPeriodEnd?: string | null; milestoneTemplateId?: string | null };
  "job.stage.change": { jobId: string; fromStage: string; toStage: string; expectedVersion: number; note?: string };
  "scope.row.create": { jobId: string } & ScopeRowWriteFields;
  "scope.row.update": { jobId: string; rowId: string; expectedVersion: number; enabled: boolean } & ScopeRowWriteFields;
  "scope.row.calculate": { jobId: string; rowId: string; expectedVersion: number };
  /** JW-14 — remove a console draft that holds no saved data (no quantity, never calculated, never reviewed). */
  "scope.row.discard": { jobId: string; rowId: string; expectedVersion: number };
  /** JW-14 — take a console row with data out of entry and totals; kept, with its figures and audit (reason required). */
  "scope.row.deactivate": { jobId: string; rowId: string; expectedVersion: number };
  "scope.row.reactivate": { jobId: string; rowId: string; expectedVersion: number };
  "scope.review.approve": { jobId: string; rowIds: string[]; expectedReviewVersion: number; reviewerNote?: string };
  "scope.review.reject": { jobId: string; rowIds: string[]; expectedReviewVersion: number; reviewerNote: string };
  "report.publish": { reportVersionId: string; expectedStatus: "validated"; manifestVersion: number; reviewedSnapshotId: string; expectedVersion: number };
  /** `signeeContactId` — one of the client's active report-signee contacts; shown on the published report. */
  "report.validate":{reviewedSnapshotId:string;manifestVersion:number;signeeContactId?:string|null};
  "report.snapshot.create": { jobId:string;expectedJobVersion:number };
  /** NZC-022 separation of duties — approval by someone other than the snapshot's preparer. */
  "report.snapshot.approve": { reviewedSnapshotId: string; note?: string | null };
  "client.contact.create": { clientId: string } & ClientContactWriteFields;
  "client.contact.update": { contactId: string; expectedVersion: number } & ClientContactWriteFields;
  /** Deactivate, never delete. */
  "client.contact.deactivate": { contactId: string; expectedVersion: number };
  /**
   * Production gate (a) — recording that a contact may (or may not) be emailed.
   *
   * `unknown` is not a recordable decision: it is the fail-closed default, and the absence
   * of a decision rather than one. A withdrawal is `declined`, which supersedes without
   * erasing what came before.
   */
  "client.contact.consent.record": {
    contactId: string; expectedVersion: number;
    state: ContactConsentDecision; basis: ContactConsentBasis; note?: string | null;
  };
  /**
   * NZC-072 — the forward commitment. The benchmark is not here: it is read from the
   * baseline in force and stamped onto the version. `restateAgainstBenchmark` is the
   * explicit acknowledgement needed when the benchmark has moved since the last version.
   */
  "client.targets.set": { clientId: string; expectedVersion: number; restateAgainstBenchmark?: boolean } & ForwardTargetWriteFields;
  /**
   * Book a person onto a run. `entitlementId` funds it from a place the client holds — the
   * place is reserved atomically, so two consultants cannot spend the same one.
   */
  "training.booking.create": {
    courseRunId: string; traineeId: string; employerClientId: string | null;
    participantType: "external_individual" | "client_employee" | "internal" | "partner";
    entitlementId?: string | null; billingStatus?: "pending" | "invoiced" | "paid" | "free_place" | "waived";
    consentStatus?: "unknown" | "granted" | "declined"; notes?: string;
  };
  /** Mark one person present or absent at one session. Attendance percentage is derived, never typed. */
  "training.attendance.set": {
    sessionId: string; bookingId: string;
    attendanceStatus: "booked" | "present" | "absent" | "excused";
    attendanceMinutes?: number | null; notes?: string;
  };
  /** Issue every certificate the policy allows on this run; consent-pending ones stay held. */
  "training.certificate.issue": { courseRunId: string; expectedRunVersion: number };
  /** Move a place's expiry. The CRM can, and the change is audited and marked as no longer the default. */
  "training.entitlement.expiry.set": { entitlementIds: string[]; expiresAt: string | null; reason: string };
  "training.run.stage.set": { courseRunId: string; fromStage: string; toStage: string; expectedVersion: number; note?: string };
  /** Freeze the register and the issued certificates into a content-addressed snapshot. */
  "training.run.review": { courseRunId: string; expectedVersion: number; note?: string };
  /** Define or redefine one of this client's intensity metrics — a new version each time. */
  "client.intensityMetric.set": {
    clientId: string; metricKey: string; label: string; unitWording: string; divider: number;
    iconKey: string; ordering?: number; expectedVersion: number;
    /** `currency` counts the client's currency (D3c); absent, the metric keeps its kind — a new one is `text`. */
    unitKind?: IntensityUnitKind;
  };
  "client.intensityMetric.deactivate": { clientId: string; metricKey: string; expectedVersion: number };
  /**
   * Phase 1b (0158) — a client's target for one intensity metric: the baseline intensity it is measured from, and an
   * interim and a final reduction, each a year with a percentage. The whole target, as the next version; expectedVersion 0
   * for the first. A reason (x-command-reason) is required when it moves a held baseline.
   */
  "client.intensityTarget.set": { clientId: string; metricKey: string; expectedVersion: number; baselineYear: number; baselineIntensity: number;
    interimYear: number | null; interimReductionPct: number | null; targetYear: number | null; targetReductionPct: number | null };
  "client.intensityTarget.deactivate": { clientId: string; metricKey: string; expectedVersion: number };
  /** Record one metric's annual value on a job, for one reporting year. */
  "job.intensityValue.set": {
    jobId: string; reportingYear: number; metricKey: string; value: number | null;
    periodKey?: string; note?: string; expectedVersion: number;
  };
  /** Open a dated assessment, stamped with the framework version in force. */
  "strategy.library.upsert": { strategyId?: string; key: string; title: string; description?: string; scope: string; category?: string; controlLevel: string; iconKey: string; expectedVersion?: number };
  "strategy.library.deactivate": { strategyId: string; expectedVersion: number; reason: string };
  /** The reference-value engine (admin A2): a lookup value is added, edited, deactivated or reinstated — never deleted. */
  /** `billableDefault` — for an activity type (TIME Addendum): required on create, so no activity is ever defaultless. */
  "reference.value.create": { categoryKey: string; label: string; code?: string | null; sortOrder?: number; billableDefault?: boolean };
  /** `billableDefault` — for an activity type: omitted keeps the held default. */
  "reference.value.update": { categoryKey: string; valueId: string; label: string; code?: string | null; sortOrder: number; expectedVersion: number; billableDefault?: boolean };
  /** Log one's OWN time (T-Q3) against a job one can access (T-Q7). `billable` omitted takes the activity's default. */
  "time.entry.log": { jobId: string; workDate: string; minutes: number; activityValueId: string; billable?: boolean; note?: string | null };
  /** Edit one's own entry, until it is billed (T-Q6). A changed work date re-snapshots the rate as of the new date (T-Q1). */
  "time.entry.edit": { entryId: string; expectedVersion: number; jobId: string; workDate: string; minutes: number; activityValueId: string; billable: boolean; note?: string | null };
  /** Void one's own entry, until it is billed. Voided, never deleted. */
  "time.entry.void": { entryId: string; expectedVersion: number };
  /** Finance stamps (or clears, with null) the invoice an entry was billed on (T-Q5). A billed entry is locked. */
  "time.entry.bill": { entryId: string; expectedVersion: number; billedRef: string | null };
  /** Time PR B (T-Q4): a person's weekly capacity, which utilisation is read against. Admin (admin.users). */
  "staff.capacity.set": { userId: string; expectedVersion: number; weeklyCapacityHours: number };
  /** Time PR B (⚑5): the job's budgeted hours — "budget used" is read against it. null clears it (no budget recorded). */
  "job.budget.set": { jobId: string; expectedVersion: number; budgetedHours: number | null };
  /** Time PR B (⚑5/⚑6): the job's fee, ex VAT — money: finance.manage, and never in a payload (NZC-120). null clears it. */
  "job.fee.set": { jobId: string; expectedVersion: number; feeAmount: number | null };
  "reference.value.deactivate": { categoryKey: string; valueId: string; expectedVersion: number };
  "reference.value.reinstate": { categoryKey: string; valueId: string; expectedVersion: number };
  /** Job types (admin C1): the services the firm sells — added, edited, deactivated or reinstated, never deleted. */
  "job_type.create": JobTypeFields;
  "job_type.update": JobTypeFields & { jobTypeId: string; expectedVersion: number };
  "job_type.deactivate": { jobTypeId: string; expectedVersion: number };
  "job_type.reinstate": { jobTypeId: string; expectedVersion: number };
  /** Milestone templates (admin C2): the schedule is written with the template; the default moves, never lapses. */
  "milestone_template.create": MilestoneTemplateFields;
  "milestone_template.update": MilestoneTemplateFields & { templateId: string; expectedVersion: number };
  "milestone_template.set_default": { templateId: string; expectedVersion: number };
  "milestone_template.deactivate": { templateId: string; expectedVersion: number };
  "milestone_template.reinstate": { templateId: string; expectedVersion: number };
  /** Job file types (admin C3): the key is set once, at create, and never again; a system type is never deactivated. */
  "job_file_type.create": FileTypeEditableFields & { fileTypeKey: string };
  "job_file_type.update": FileTypeEditableFields & { fileTypeId: string; expectedVersion: number };
  "job_file_type.deactivate": { fileTypeId: string; expectedVersion: number };
  "job_file_type.reinstate": { fileTypeId: string; expectedVersion: number };
  // Commercial lookups (admin Phase E1; ruled phaseE plan E-Q1–E-Q3). admin.lookups throughout; exactly one default each.
  "vat.create": VatRateEditableFields;
  "vat.update": VatRateEditableFields & { vatRateId: string; expectedVersion: number };
  "vat.set_default": { vatRateId: string; expectedVersion: number };
  "vat.deactivate": { vatRateId: string; expectedVersion: number };
  "vat.reinstate": { vatRateId: string; expectedVersion: number };
  "currency.create": CurrencyEditableFields & { code: string };
  "currency.update": CurrencyEditableFields & { code: string; expectedVersion: number };
  "currency.set_default": { code: string; expectedVersion: number };
  "currency.deactivate": { code: string; expectedVersion: number };
  "currency.reinstate": { code: string; expectedVersion: number };
  // The service catalogue (admin Phase E2; ruled phaseE plan E-Q4/E-Q8/E-Q9). admin.lookups for the definition;
  // finance.manage for the amounts, by their own command.
  "job_item.create": JobItemEditableFields & { itemCode: string };
  "job_item.update": JobItemEditableFields & { itemId: string; expectedVersion: number };
  "job_item.deactivate": { itemId: string; expectedVersion: number };
  "job_item.reinstate": { itemId: string; expectedVersion: number };
  "job_item.price.set": { itemId: string; expectedVersion: number; defaultCostAmount: number | null; defaultSellAmount: number | null };
  // Job-type templates (admin Phase E3): the included items, set whole and in order, against the template's own version.
  "job_type.items.set": { jobTypeId: string; expectedItemsVersion: number; items: JobTypeTemplateEntry[] };
  // Suppliers and their rate card (admin Phase E4; ruled phaseE plan E-Q6–E-Q9). admin.lookups, except the agreed rate
  // (finance.manage). A contact's details are sealed and never in a result.
  "supplier.create": SupplierEditableFields;
  "supplier.update": SupplierEditableFields & { supplierId: string; expectedVersion: number };
  "supplier.deactivate": { supplierId: string; expectedVersion: number };
  "supplier.reinstate": { supplierId: string; expectedVersion: number };
  "supplier.contact.add": SupplierContactFields & { supplierId: string };
  "supplier.contact.update": SupplierContactFields & { contactId: string; expectedVersion: number };
  "supplier.contact.deactivate": { contactId: string; expectedVersion: number };
  "supplier.contact.reinstate": { contactId: string; expectedVersion: number };
  "supplier_item.create": SupplierItemEditableFields & { supplierId: string };
  "supplier_item.update": SupplierItemEditableFields & { serviceItemId: string; expectedVersion: number };
  "supplier_item.deactivate": { serviceItemId: string; expectedVersion: number };
  "supplier_item.reinstate": { serviceItemId: string; expectedVersion: number };
  "supplier_item.rate.set": { serviceItemId: string; expectedVersion: number; agreedRate: number | null };
  // Message templates (admin Phase F1; ruled phaseF plan F-Q2/F-Q3). admin.templates; a key from the code registry only.
  "message_template.create": { templateKey: string; subject: string; body: string };
  "message_template.update": { templateKey: string; expectedVersion: number; subject: string; body: string };
  "message_template.deactivate": { templateKey: string; expectedVersion: number };
  "message_template.reinstate": { templateKey: string; expectedVersion: number };
  // The BD funnel (admin Phase F2; ruled phaseF plan). admin.lookups; a stage's key set once.
  "bd_stage.create": BdStageEditableFields & { stageKey: string };
  "bd_stage.update": BdStageEditableFields & { stageId: string; expectedVersion: number };
  "bd_stage.deactivate": { stageId: string; expectedVersion: number };
  "bd_stage.reinstate": { stageId: string; expectedVersion: number };
  // Custom field definitions (admin Phase F3; ruled phaseF plan F-Q5). admin.settings; entity, key and type set once.
  "custom_field.create": CustomFieldEditableFields & { entityType: CustomFieldEntityType; fieldKey: string; fieldType: CustomFieldType };
  "custom_field.update": CustomFieldEditableFields & { definitionId: string; expectedVersion: number };
  "custom_field.deactivate": { definitionId: string; expectedVersion: number };
  "custom_field.reinstate": { definitionId: string; expectedVersion: number };
  // Portal broadcasts (admin Phase F4; ruled F4-RULINGS R1–R7). admin.settings; every part editable, never deleted.
  "portal_broadcast.create": PortalBroadcastEditableFields;
  "portal_broadcast.update": PortalBroadcastEditableFields & { broadcastId: string; expectedVersion: number };
  "portal_broadcast.deactivate": { broadcastId: string; expectedVersion: number };
  "portal_broadcast.reinstate": { broadcastId: string; expectedVersion: number };
  // Team & access (admin Phase B, B1). A person is named by their membership user_id; the email is read-only once added (Q6).
  "staff.add": { displayName: string; email: string; positionValueId?: string | null };
  "staff.update": { userId: string; expectedVersion: number; displayName: string; positionValueId?: string | null };
  "staff.role.assign": { userId: string; expectedVersion: number; role: StaffRole };
  "staff.deactivate": { userId: string; expectedVersion: number };
  "staff.reinstate": { userId: string; expectedVersion: number };
  /** A rate from a date (R9 (c)). With `supersedesRateId` it corrects that row instead, and needs a reason. */
  "staff.rate.set": { userId: string; effectiveFrom: string; costPerHour?: number | null; sellPerHour?: number | null; currency?: string; supersedesRateId?: string | null };
  // Organisation settings (admin Phase D, D1). The profile is saved whole, under its version; the bank details apart.
  "organisation.profile.update": OrganisationProfileFields & { expectedVersion: number };
  "organisation.logo.set": { fileName: string; contentType: OrganisationLogoContentType; dataBase64: string };
  "organisation.logo.remove": Record<string, never>;
  "organisation.bank.set": OrganisationBankFields & { expectedVersion: number };
  "organisation.intensityDefault.set": { metricKey: string; label: string; unitWording: string; divider: number; iconKey: string; ordering?: number; expectedVersion: number; unitKind?: IntensityUnitKind };
  "organisation.intensityDefault.deactivate": { metricKey: string; expectedVersion: number };
  /** Q5: the defaults onto every client that has no intensity metric — the count the admin confirmed, or refused. */
  "organisation.intensityDefaults.apply": { expectedClients: number };
  "client.strategy.assign": { clientId: string; strategyId?: string; bespoke?: { title: string; scope: string; category?: string; controlLevel: string; iconKey?: string }; srsRequirementIds: string[]; owner?: string; targetDate?: string | null; notes?: string };
  "client.strategy.update": { clientStrategyId: string; expectedVersion: number; status: string; owner?: string; targetDate?: string | null; progressPct: number; notes?: string; srsRequirementIds: string[]; includeInReport: boolean };
  "client.strategy.remove": { clientStrategyId: string; expectedVersion: number; reason: string };
  /**
   * A forward **estimate** of what this strategy will save. Never a measurement, and never
   * derived from an assured snapshot.
   *
   * `estimate: null` clears it — a strategy with no estimate contributes nothing to the
   * projection and says so, which is a different fact from an estimate of zero.
   */
  /**
   * Offer a question and answer to the library as a **draft**.
   *
   * Idempotent: `sourceKey` identifies the thing being captured from, and a second capture of
   * it by the same person reopens their existing draft rather than stacking a rival. An
   * AI-drafted answer arrives here as a draft like any other — it is never published by the
   * act of being written.
   */
  "knowledge.capture": {
    question: string; answer: string; sourceKey: string;
    draftedByKind?: "human" | "ai"; askedBy?: string; category?: string; area?: string;
    /** Set when similarity surfaced a close match and the person proceeded anyway. */
    possibleDuplicate?: boolean;
    /** Set when this draft is a pending edit to an already-approved entry. */
    revisesEntryId?: string | null;
  };
  /** Fold a rephrasing into an entry rather than letting it become a rival. */
  "knowledge.alias.add": { entryId: string; expectedVersion: number; question: string };
  "knowledge.edit": { entryId: string; expectedVersion: number; question: string; answer: string; category?: string; area?: string };
  "knowledge.approve": { entryId: string; expectedVersion: number };
  "knowledge.publish": { entryId: string; expectedVersion: number };
  /** Rejecting carries a reason; `duplicateOfEntryId` records what it duplicated. */
  "knowledge.reject": { entryId: string; expectedVersion: number; reason: string; duplicateOfEntryId?: string | null };
  /** Fold a duplicate draft into a target entry: its phrasings become aliases, it closes. */
  "knowledge.merge": { entryId: string; expectedVersion: number; intoEntryId: string };
  "client.strategy.estimate.set": {
    clientStrategyId: string; expectedVersion: number;
    estimate: {
      amount: number; unit: EstimateUnit; scope: EstimateScope; assumptions: string;
      confidence?: EstimateConfidence | null; source: EstimateSource; sourceVersion?: number | null;
    } | null;
  };
  "srs.assessment.start": { clientId: string; assessedOn: string; notes?: string; prefillFromNziData?: boolean };
  /** Answer one requirement. `maturity: null` clears the answer back to unassessed. */
  "srs.assessment.item.set": {
    assessmentId: string; requirementId: string; maturity: number | null;
    evidenceKind?: "document" | "data" | "note" | null; evidenceRef?: string | null; evidenceNote?: string;
    owner?: string; dueDate?: string | null; linkedActionId?: string | null; expectedVersion: number;
  };
  "srs.assessment.complete": { assessmentId: string; expectedVersion: number };
  "client.logo.set": { clientId: string; fileName: string; contentType: ClientLogoContentType; dataBase64: string };
  "client.logo.remove": { clientId: string };
  "report.section.edit": { jobId: string; sectionKey: string; bodyHtml: string; expectedVersion: number; contentSource?: "ai" | "client-edited" };
  "report.section.reset": { jobId: string; sectionKey: string; expectedVersion: number };
  "report.section.regenerate": { jobId: string; sectionKey: string; expectedVersion: number };
  "assurance.gap.resolve": { jobId: string; gapKey: string; flagType: "yoy_movement" | "completeness" | "zero_blank" | "unmapped" | "out_of_boundary"; scopeRowId?: string | null; reason: string; expectedVersion: number };
  "emissions.target.upsert": { jobId:string;baselineYear:number;baselineTco2e:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;expectedVersion:number };
  /** One canonical command. Created from a job (`jobId`) the in-service date defaults to that job's reporting-period start; from the client workspace (`clientId`) it must be stated. `inServiceFrom: null` = in service from before records (NZC-070). */
  "site.create": {jobId?:string|null;clientId?:string|null;name:string;inServiceFrom?:string|null;isRegisteredOffice?:boolean;floorAreaM2?:number|null} & SiteAddressFields;
  /** CLIENT-11: an omitted address part keeps the one the site holds; a changed postcode or country clears its coordinates. */
  "site.edit": {siteId:string;name:string;inServiceFrom:string|null;expectedVersion:number} & SiteAddressFields;
  /** CLIENT-04: a site's coordinates, as the geocoder found them — derived from the postcode and country, best effort. */
  "site.location.set": {siteId:string;expectedVersion:number;latitude:number;longitude:number;source:GeocodeSource;precision:GeocodePrecision};
  /** CLIENT-04: the client's coordinates, from its registered postcode and country. */
  "client.location.set": {clientId:string;expectedVersion:number;latitude:number;longitude:number;source:GeocodeSource;precision:GeocodePrecision};
  "site.registeredOffice": {siteId:string;isRegisteredOffice:boolean;expectedVersion:number};
  "site.vacate": {siteId:string;effectiveDate:string;expectedVersion:number};
  "site.reinstate": {siteId:string;expectedVersion:number};
  /** Phase 1a — take a site out of use (entered by mistake, no longer offered); kept, with every row that cites it. Reason required. */
  "site.archive": {siteId:string;expectedVersion:number};
  "site.unarchive": {siteId:string;expectedVersion:number};
  /** NZC-071 — append an effective-dated floor-area record; `effectiveFrom: null` = from the site's start. */
  "site.floorArea.record": {siteId:string;floorAreaM2:number;effectiveFrom:string|null;expectedVersion:number};
  "emissions.intensity.upsert":{jobId:string;metric:"turnover"|"employee"|"floor-area";denominatorUnit:string;/** null for the floor-area metric, which derives it from site floor areas (NZC-071). */reportingDenominator:number|null;baselineYear:number;baselineIntensity:number;interimYear:number;interimReductionPercent:number;netZeroYear:number;expectedVersion:number};
  "purchased.goods.category.create":{jobId:string;name:string};
  /**
   * A ruling on an identity question (NZC-116). `linked` joins the members into one subject,
   * `distinct` records that they are different people, `deferred` leaves it open for now.
   * The basis is required for the first two: a decision nobody can explain later is not one.
   */
  "subject.review.decide":{reviewId:string;decision:"linked"|"distinct"|"deferred";basis:string};
  /**
   * Whether this client sees a category at all. `visible: null` withdraws the decision and returns
   * the category to the default, which is visible.
   */
  "client.category.visibility.set":{clientId:string;categoryCode:string;visible:boolean|null;note?:string|null};
  /** What this client calls a shared dataset factor. `label: null` withdraws the alias. */
  "client.factor.alias.set":{clientId:string;factorId:string;label:string|null};
  "client.factor.create":{jobId:string;scope:string;reportLabel:string;description:string;unit:string;kgco2ePerUnit:number;geography:string;vintageYear:number;source:string;reusable:boolean;evidenceFileName:string|null;evidenceStorageProvider:"local"|"sharepoint"|null;evidenceUrl:string|null;evidenceExternalItemId:string|null;evidenceHash:string|null};
  "client.factor.update":{clientFactorId:string;expectedVersion:number;reportLabel:string;description:string;unit:string;kgco2ePerUnit:number;geography:string;vintageYear:number;source:string;evidenceFileName:string|null;evidenceStorageProvider:"local"|"sharepoint"|null;evidenceUrl:string|null;evidenceExternalItemId:string|null;evidenceHash:string|null};
  "client.factor.archive":{clientFactorId:string;archived:boolean};
  "emission.source.group.create":{jobId:string;name:string;datasetId?:string|null;factorId?:string|null;factorLabel?:string|null;unit?:string|null};
  "emission.source.group.sync":{jobId:string;groupId:string};
  "emission.source.create":{activityFrequency?:ActivityFrequency|null;activityFigures?:(number|null)[]|null;jobId:string;groupId:string|null;scope:string;sourceType:EmissionSourceKind;sourceSubtype:string|null;siteId:string|null;sourceName:string;assetIdentifier:string|null;purchasedGoodsCategoryId:string|null;datasetId?:string|null;factorId:string|null;factorSource:FactorSource;clientFactorId:string|null;quantity:number|null;unit:string|null;applyPct:number;dataSource:string;dataConfidence:DataConfidence|null;monthlyActivity:MonthlyActivitySlot[];detail:EmissionSourceDetail;notes:string|null;importBatchId?:string|null};
  "emission.source.sync":{jobId:string;sourceId:string};
  "emission.source.rollforward":{jobId:string;fromJobId:string|null};
  /** NZC-063 — bulk-copy chosen prior-job scope rows forward, quantity empty, pending. */
  "scope.row.rollforward":{jobId:string;priorJobId:string;rowIds:string[]};
  "emission.source.import.commit":{jobId:string;token:string;rows:SpendImportRow[]};
  "emission.source.import.void":{jobId:string;batchId:string};
  "client.import.mapping.save":{clientId:string;importKind:"spend";columns:SpendImportColumnMap};
  "emission.source.activity.update":{activityFrequency?:ActivityFrequency|null;activityFigures?:(number|null)[]|null;jobId:string;sourceId:string;expectedVersion:number;quantity:number|null;unit:string|null;applyPct:number;dataConfidence:DataConfidence|null;monthlyActivity:MonthlyActivitySlot[];notes:string|null};
  "emission.source.status.update":{jobId:string;sourceId:string;expectedVersion:number;enabled:boolean};
  "dataset.override.add": { jobId: string; scope: string; datasetId: string; reportingFrom: string; reportingTo: string };
  "portal.access.grant": { clientId: string; jobIds: string[]; userId: string; dataEntryExpiresAt?: string };
  "sales.opportunity.convert": { opportunityId: string; expectedStatus: "WON"; quoteId: string; createJob: boolean };
  /** Track C / NZC-055 — LCA reference module, slice 1 (assessment register). */
  "lca.assessment.create": { jobId: string } & LcaAssessmentWriteFields;
  "lca.assessment.update": { jobId: string; assessmentId: string; expectedVersion: number } & LcaAssessmentWriteFields;
  "lca.lineItem.create": { jobId: string; assessmentId: string } & LcaLineItemWriteFields;
  "lca.lineItem.update": { jobId: string; assessmentId: string; lineItemId: string } & LcaLineItemWriteFields;
  "lca.lineItem.delete": { jobId: string; assessmentId: string; lineItemId: string };
  "lca.lineItem.bulkCreate": { jobId: string; assessmentId: string; lines: LcaLineItemWriteFields[] };
  "lca.transportLeg.create": { jobId: string; assessmentId: string; lineItemId: string } & LcaTransportLegWriteFields;
  "lca.transportLeg.update": { jobId: string; assessmentId: string; lineItemId: string; legId: string } & LcaTransportLegWriteFields;
  "lca.transportLeg.delete": { jobId: string; assessmentId: string; lineItemId: string; legId: string };
  "lca.lineItem.gapFill": { jobId: string; assessmentId: string; lineItemId: string } & LcaGapFillWriteFields;
  "lca.assessment.calculate": { jobId: string; assessmentId: string; expectedVersion: number };
  "lca.assessment.review.approve": { jobId: string; assessmentId: string; expectedVersion: number; reviewerNote?: string };
  "lca.assessment.review.reject": { jobId: string; assessmentId: string; expectedVersion: number; reviewerNote: string };
  "lca.assessment.snapshot.create": { jobId: string; assessmentId: string; expectedVersion: number };
  "lca.scenario.create": { jobId: string; assessmentId: string } & LcaScenarioWriteFields;
  "lca.scenario.update": { jobId: string; assessmentId: string; scenarioId: string } & LcaScenarioWriteFields;
  "lca.scenario.delete": { jobId: string; assessmentId: string; scenarioId: string };
  "lca.scenario.multiplier.set": { jobId: string; assessmentId: string; scenarioId: string } & LcaScenarioMultiplierWriteFields;
  "lca.scenario.multiplier.delete": { jobId: string; assessmentId: string; scenarioId: string; multiplierId: string };
};

export type CommandDefinition<K extends CommandKey = CommandKey> = {
  /** A PERMISSION_MATRIX.md capability — typed, so an ad-hoc name cannot compile. */
  key: K; label: string; permission: Capability; reasonRequired: boolean; transaction: string; auditAction: string;
  validate: (input: CommandInputMap[K], context: CommandContext) => CommandIssue[];
};
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === "string" && allowed.includes(value as T);
/**
 * A real calendar date — 2026-02-30 is rejected rather than rolled over.
 *
 * date-helper-exempt: a round trip, not a conversion. The string is parsed at a fixed UTC
 * anchor and compared with itself, which is what catches an impossible day. Zone-independent
 * by construction (NZC-106).
 */
const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const positiveArea = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
/** A time entry's own fields (TIME ⚑1, ⚑9): a real day, whole minutes 1–1440, an activity, a short note. */
const timeEntryIssues = (issues: CommandIssue[], input: { workDate: string; minutes: number; activityValueId: string; note?: string | null }) => {
  if (!isoDate(input.workDate)) issues.push({ field: "workDate", code: "INVALID", message: "Enter the day the work was done." });
  // Ruled: time is logged for a day that has happened — today at the latest, as the London day.
  else if (input.workDate > todayInLondon()) issues.push({ field: "workDate", code: "FUTURE", message: "Time is logged for today or an earlier day, not a day still to come." });
  if (!isTimeEntryMinutes(input.minutes)) issues.push({ field: "minutes", code: "INVALID", message: "Enter the time worked: more than none, and no more than 24 hours in one entry." });
  required(issues, "activityValueId", input.activityValueId);
  if (input.note != null && (typeof input.note !== "string" || input.note.length > TIME_ENTRY_NOTE_MAX)) issues.push({ field: "note", code: "INVALID", message: `A note is ${TIME_ENTRY_NOTE_MAX} characters or fewer.` });
};
/** CLIENT-11: a site's structured address — up to four lines, a postcode or zip, and an ISO 3166-1 alpha-2 country. */
export type SiteAddressFields = { addressLines?: string[]; postcode?: string | null; country?: string | null };
export const SITE_ADDRESS_MAX_LINES = 4;
const siteAddressIssues = (input: SiteAddressFields) => {
  const issues: CommandIssue[] = [];
  if (input.addressLines !== undefined && (!Array.isArray(input.addressLines) || input.addressLines.length > SITE_ADDRESS_MAX_LINES || input.addressLines.some((line) => typeof line !== "string" || line.length > 200))) issues.push({ field: "addressLines", code: "INVALID", message: `Up to ${SITE_ADDRESS_MAX_LINES} address lines, each 200 characters or fewer.` });
  if (input.postcode != null && (typeof input.postcode !== "string" || input.postcode.trim().length > 20)) issues.push({ field: "postcode", code: "INVALID", message: "The postcode or zip is 20 characters or fewer." });
  if (input.country != null && !isIsoCountryCode(input.country)) issues.push({ field: "country", code: "INVALID", message: "Choose the country from the list." });
  return issues;
};
/** CLIENT-04: where coordinates came from, and how precise they are. Geocoding sends a postcode and a country only. */
export const geocodeSources = ["nominatim"] as const;
export type GeocodeSource = (typeof geocodeSources)[number];
export const geocodePrecisions = ["postcode"] as const;
export type GeocodePrecision = (typeof geocodePrecisions)[number];
const locationIssues = (input: { latitude: number; longitude: number; source: string; precision: string }) => {
  const issues: CommandIssue[] = [];
  if (typeof input.latitude !== "number" || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) issues.push({ field: "latitude", code: "INVALID", message: "Latitude is between -90 and 90." });
  if (typeof input.longitude !== "number" || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) issues.push({ field: "longitude", code: "INVALID", message: "Longitude is between -180 and 180." });
  if (!oneOf(input.source, geocodeSources)) issues.push({ field: "source", code: "INVALID", message: "Unknown geocode source." });
  if (!oneOf(input.precision, geocodePrecisions)) issues.push({ field: "precision", code: "INVALID", message: "Unknown geocode precision." });
  return issues;
};
const baseIssues = (context: CommandContext, reasonRequired: boolean) => {
  const issues: CommandIssue[] = [];
  if (!text(context.organisationId)) issues.push({ field: "organisationId", code: "REQUIRED", message: "Organisation context is required." });
  if (!text(context.actorId)) issues.push({ field: "actorId", code: "REQUIRED", message: "Actor is required." });
  if (!text(context.idempotencyKey)) issues.push({ field: "idempotencyKey", code: "REQUIRED", message: "Idempotency key is required." });
  if (!text(context.correlationId)) issues.push({ field: "correlationId", code: "REQUIRED", message: "Correlation ID is required." });
  if (reasonRequired && !text(context.reason)) issues.push({ field: "reason", code: "REQUIRED", message: "A reason is required for this command." });
  return issues;
};
/** A person's display name: present, within bounds (admin Phase B). */
const staffNameIssues = (issues: CommandIssue[], name: unknown) => {
  if (!text(name)) issues.push({ field: "displayName", code: "REQUIRED", message: "A name is required." });
  else if ((name as string).trim().length > STAFF_NAME_MAX) issues.push({ field: "displayName", code: "INVALID", message: `A name is at most ${STAFF_NAME_MAX} characters.` });
};
const required = (issues: CommandIssue[], field: string, value: unknown) => { if (!text(value)) issues.push({ field, code: "REQUIRED", message: `${field} is required.` }); };
/** JW-14 — a row-state command names the row and the version it acts on. */
const scopeRowStateIssues = (input: { jobId: string; rowId: string; expectedVersion: number }, context: CommandContext, reasonRequired: boolean) => {
  const issues = baseIssues(context, reasonRequired);
  required(issues, "jobId", input.jobId); required(issues, "rowId", input.rowId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
  return issues;
};

/**
 * JW-14 — whether a row is a draft that holds no saved data, and so may be discarded outright: captured in the console
 * (never imported from v7), no quantity in any form, never calculated or overridden, never reviewed. A factor alone is
 * not saved data — since JW-9 every new entry carries one. The write re-checks this, and also refuses a row a portal
 * bucket or another row still refers to.
 */
export function scopeRowIsDiscardable(row: Pick<ScopeRowReadModel, "origin" | "quantity" | "monthlyActivity" | "calculatedTco2e" | "overrideTco2e" | "reviewStatus" | "reviewedBy">): boolean {
  return row.origin !== "migrated"
    && row.quantity == null
    && !(row.monthlyActivity ?? []).some((slot) => slot.quantity != null)
    && row.calculatedTco2e == null && row.overrideTco2e == null
    && row.reviewStatus === "pending" && !row.reviewedBy;
}
/** A lookup value's own fields: a managed category, a label within bounds, an optional short code, a whole sort order. */
const lookupIssues = (issues: CommandIssue[], input: { categoryKey: string; label: string; code?: string | null; sortOrder?: number }) => {
  if (!isLookupCategory(input.categoryKey)) issues.push({ field: "categoryKey", code: "INVALID", message: "That is not a lookup managed here." });
  if (!text(input.label)) issues.push({ field: "label", code: "REQUIRED", message: "A label is required." });
  else if (input.label.trim().length > LOOKUP_LABEL_MAX) issues.push({ field: "label", code: "TOO_LONG", message: `A label is at most ${LOOKUP_LABEL_MAX} characters.` });
  if (input.code !== undefined && input.code !== null && input.code.trim().length > LOOKUP_CODE_MAX) issues.push({ field: "code", code: "TOO_LONG", message: `A code is at most ${LOOKUP_CODE_MAX} characters.` });
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000)) issues.push({ field: "sortOrder", code: "INVALID", message: "Sort order is a whole number from 0." });
};
/** A job type's own fields: a name and optional code within bounds, one family, amounts to two places (admin C1). */
const jobTypeIssues = (issues: CommandIssue[], input: JobTypeFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A name is required." });
  else if (input.name.trim().length > JOB_TYPE_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${JOB_TYPE_NAME_MAX} characters.` });
  if (input.code !== undefined && input.code !== null && input.code.trim().length > JOB_TYPE_CODE_MAX) issues.push({ field: "code", code: "TOO_LONG", message: `A code is at most ${JOB_TYPE_CODE_MAX} characters.` });
  if (!isJobTypeFamily(input.family)) issues.push({ field: "family", code: "INVALID", message: "Choose the job family." });
  if (input.description !== undefined && input.description !== null && input.description.length > JOB_TYPE_DESCRIPTION_MAX) issues.push({ field: "description", code: "TOO_LONG", message: `A description is at most ${JOB_TYPE_DESCRIPTION_MAX} characters.` });
  if (input.defaultPriceExVat !== undefined && input.defaultPriceExVat !== null && !isTwoDecimalAmount(input.defaultPriceExVat, JOB_TYPE_PRICE_MAX)) issues.push({ field: "defaultPriceExVat", code: "INVALID", message: "A price is an amount from 0, to two decimal places." });
  if (input.estimatedHours !== undefined && input.estimatedHours !== null && !isTwoDecimalAmount(input.estimatedHours, JOB_TYPE_HOURS_MAX)) issues.push({ field: "estimatedHours", code: "INVALID", message: "Hours are a number from 0, to two decimal places." });
};
/** A template's own fields: a name within bounds, and a schedule of at most one item per kind, at least one included. */
const milestoneTemplateIssues = (issues: CommandIssue[], input: MilestoneTemplateFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A name is required." });
  else if (input.name.trim().length > MILESTONE_TEMPLATE_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${MILESTONE_TEMPLATE_NAME_MAX} characters.` });
  if (input.description !== undefined && input.description !== null && input.description.length > MILESTONE_TEMPLATE_DESCRIPTION_MAX) issues.push({ field: "description", code: "TOO_LONG", message: `A description is at most ${MILESTONE_TEMPLATE_DESCRIPTION_MAX} characters.` });
  if (!Array.isArray(input.items)) { issues.push({ field: "items", code: "REQUIRED", message: "A template needs its milestones." }); return; }
  const seen = new Set<string>();
  for (const item of input.items) {
    const kind = isMilestoneKind(item?.kind) ? item.kind : null;
    if (!kind) { issues.push({ field: "items", code: "INVALID", message: `A milestone is one of ${MILESTONE_KINDS.join(", ")}.` }); continue; }
    if (seen.has(kind)) issues.push({ field: `items.${kind}`, code: "DUPLICATE", message: "Each milestone appears once in a template." });
    seen.add(kind);
    if (!text(item.label)) issues.push({ field: `items.${kind}.label`, code: "REQUIRED", message: "Each milestone needs a label." });
    else if (item.label.trim().length > MILESTONE_ITEM_LABEL_MAX) issues.push({ field: `items.${kind}.label`, code: "TOO_LONG", message: `A label is at most ${MILESTONE_ITEM_LABEL_MAX} characters.` });
    if (!Number.isInteger(item.daysOffset) || item.daysOffset < 0 || item.daysOffset > MILESTONE_OFFSET_MAX) issues.push({ field: `items.${kind}.daysOffset`, code: "INVALID", message: `An offset is a whole number of days from 0 to ${MILESTONE_OFFSET_MAX}.` });
    if (typeof item.included !== "boolean") issues.push({ field: `items.${kind}.included`, code: "INVALID", message: "Say whether the milestone is scheduled." });
  }
  if (!input.items.some((item) => item?.included === true)) issues.push({ field: "items", code: "REQUIRED", message: "A template schedules at least one milestone." });
};
/** A file type's editable fields: a display name within bounds, a folder key, a whole sort order (admin C3). */
const fileTypeIssues = (issues: CommandIssue[], input: FileTypeEditableFields) => {
  if (!text(input.displayName)) issues.push({ field: "displayName", code: "REQUIRED", message: "A display name is required." });
  else if (input.displayName.trim().length > FILE_TYPE_NAME_MAX) issues.push({ field: "displayName", code: "TOO_LONG", message: `A display name is at most ${FILE_TYPE_NAME_MAX} characters.` });
  if (typeof input.storageFolderKey !== "string" || !FILE_TYPE_FOLDER_PATTERN.test(input.storageFolderKey.trim())) issues.push({ field: "storageFolderKey", code: "INVALID", message: "A folder is lower-case letters, digits and hyphens, up to 41 characters." });
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000)) issues.push({ field: "sortOrder", code: "INVALID", message: "Sort order is a whole number from 0." });
};
/** A VAT rate's editable fields: a name within bounds, a percentage 0–100 to two places (admin E1). */
const vatRateIssues = (issues: CommandIssue[], input: VatRateEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A name is required." });
  else if (input.name.trim().length > VAT_RATE_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${VAT_RATE_NAME_MAX} characters.` });
  if (!isVatPercentage(input.ratePct)) issues.push({ field: "ratePct", code: "INVALID", message: "A rate is a percentage from 0 to 100, to two places at most." });
};
/** A currency's editable fields: a name and a symbol within bounds (admin E1). */
const currencyIssues = (issues: CommandIssue[], input: CurrencyEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A name is required." });
  else if (input.name.trim().length > CURRENCY_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${CURRENCY_NAME_MAX} characters.` });
  if (!text(input.symbol)) issues.push({ field: "symbol", code: "REQUIRED", message: "A symbol is required — the code itself (\"AED\") if the currency has no sign of its own." });
  else if (input.symbol.trim().length > CURRENCY_SYMBOL_MAX) issues.push({ field: "symbol", code: "TOO_LONG", message: `A symbol is at most ${CURRENCY_SYMBOL_MAX} characters.` });
};
const currencyCodeIssue = (issues: CommandIssue[], code: unknown) => {
  if (!isCurrencyCodeForSet(code)) issues.push({ field: "code", code: "INVALID", message: code === "UAE"
    ? "\"UAE\" is the country, not a currency: the UAE dirham is AED."
    : "A currency code is its three-letter ISO-4217 code in capitals, e.g. GBP." });
};
const vatIdIssues = (issues: CommandIssue[], input: { vatRateId: string; expectedVersion: number }) => {
  required(issues, "vatRateId", input.vatRateId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
const currencyIdIssues = (issues: CommandIssue[], input: { code: string; expectedVersion: number }) => {
  currencyCodeIssue(issues, input.code);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/** A catalogue item's definition: a name and optional description within bounds, hours within bounds, a whole order (admin E2). */
const jobItemIssues = (issues: CommandIssue[], input: JobItemEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A name is required." });
  else if (input.name.trim().length > JOB_ITEM_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${JOB_ITEM_NAME_MAX} characters.` });
  if (input.description !== undefined && input.description !== null && input.description.trim().length > JOB_ITEM_DESCRIPTION_MAX) issues.push({ field: "description", code: "TOO_LONG", message: `A description is at most ${JOB_ITEM_DESCRIPTION_MAX} characters.` });
  if (input.defaultHours !== undefined && input.defaultHours !== null && !isCatalogueAmount(input.defaultHours, JOB_ITEM_HOURS_MAX)) issues.push({ field: "defaultHours", code: "INVALID", message: "Hours are a number from 0, to two places." });
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000)) issues.push({ field: "sortOrder", code: "INVALID", message: "Sort order is a whole number from 0." });
};
const jobItemIdIssues = (issues: CommandIssue[], input: { itemId: string; expectedVersion: number }) => {
  required(issues, "itemId", input.itemId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/** Suppliers (admin E4): a company's fields, a contact's (personal data — the messages never repeat a value), a rate-card line's. */
const optionalText = (issues: CommandIssue[], field: string, value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") issues.push({ field, code: "INVALID", message: `${what} is text.` });
  else if (value.trim().length > max) issues.push({ field, code: "TOO_LONG", message: `${what} is at most ${max} characters.` });
};
const supplierIssues = (issues: CommandIssue[], input: SupplierEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A supplier's name is required." });
  else if (input.name.trim().length > SUPPLIER_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${SUPPLIER_NAME_MAX} characters.` });
  optionalText(issues, "website", input.website, SUPPLIER_WEBSITE_MAX, "A website");
};
const supplierContactIssues = (issues: CommandIssue[], input: SupplierContactFields) => {
  if (!text(input.fullName)) issues.push({ field: "fullName", code: "REQUIRED", message: "A contact's name is required." });
  else if (input.fullName.trim().length > SUPPLIER_CONTACT_NAME_MAX) issues.push({ field: "fullName", code: "TOO_LONG", message: `A name is at most ${SUPPLIER_CONTACT_NAME_MAX} characters.` });
  if (text(input.email) && !isSupplierContactEmail(input.email)) issues.push({ field: "email", code: "INVALID", message: "Enter a valid email address, or leave it blank." });
  optionalText(issues, "phone", input.phone, SUPPLIER_CONTACT_PHONE_MAX, "A phone number");
};
const supplierItemIssues = (issues: CommandIssue[], input: SupplierItemEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A service's name is required." });
  else if (input.name.trim().length > SUPPLIER_ITEM_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${SUPPLIER_ITEM_NAME_MAX} characters.` });
  optionalText(issues, "costType", input.costType, SUPPLIER_COST_TYPE_MAX, "A cost type");
  optionalText(issues, "description", input.description, SUPPLIER_ITEM_DESCRIPTION_MAX, "A description");
};
const versioned = (issues: CommandIssue[], field: string, id: unknown, expectedVersion: unknown) => {
  required(issues, field, id);
  if (!positive(expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/** A message template (admin F1): a key the registry knows (F-Q3), and a subject and body that use only its declared tokens (F-Q2). */
const messageTemplateKeyIssues = (issues: CommandIssue[], templateKey: unknown) => {
  if (typeof templateKey !== "string" || !messageTemplateDefinition(templateKey)) issues.push({ field: "templateKey", code: "UNKNOWN_KEY", message: "That is not a message the console sends — the set of messages is fixed in code." });
};
const messageTemplateContentIssues = (issues: CommandIssue[], input: { templateKey: string; subject: string; body: string }) => {
  const definition = typeof input.templateKey === "string" ? messageTemplateDefinition(input.templateKey) : undefined;
  for (const [field, value, max, what] of [["subject", input.subject, MESSAGE_TEMPLATE_SUBJECT_MAX, "A subject"], ["body", input.body, MESSAGE_TEMPLATE_BODY_MAX, "A body"]] as const) {
    if (!text(value)) { issues.push({ field, code: "REQUIRED", message: `${what} is required.` }); continue; }
    if (value.length > max) issues.push({ field, code: "TOO_LONG", message: `${what} is at most ${max} characters.` });
    if (definition) for (const message of messageTemplateTokenIssues(value, definition)) issues.push({ field, code: "UNKNOWN_TOKEN", message });
  }
  if (definition && text(input.body)) for (const message of messageTemplateRequiredIssues(input.body, definition)) issues.push({ field: "body", code: "MISSING_TOKEN", message });
};
/** A funnel stage's definition (admin F2): a name, a whole order, a probability from 0 to 100 to two places. */
const bdStageIssues = (issues: CommandIssue[], input: BdStageEditableFields) => {
  if (!text(input.name)) issues.push({ field: "name", code: "REQUIRED", message: "A stage's name is required." });
  else if (input.name.trim().length > BD_STAGE_NAME_MAX) issues.push({ field: "name", code: "TOO_LONG", message: `A name is at most ${BD_STAGE_NAME_MAX} characters.` });
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > BD_STAGE_ORDER_MAX) issues.push({ field: "sortOrder", code: "INVALID", message: "The order is a whole number from 0." });
  if (!isStageProbability(input.probabilityPct)) issues.push({ field: "probabilityPct", code: "INVALID", message: "A probability is a percentage from 0 to 100, to two places." });
};
const bdStageIdIssues = (issues: CommandIssue[], input: { stageId: string; expectedVersion: number }) => {
  required(issues, "stageId", input.stageId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/**
 * A custom field definition's editable part (admin F3): a label, a whole order, options that suit the type, a default
 * valid for it. The type is the create's or, on update, the held one — passed in, since update cannot change it.
 */
const customFieldIssues = (issues: CommandIssue[], input: CustomFieldEditableFields, type: CustomFieldType | null) => {
  if (!text(input.label)) issues.push({ field: "label", code: "REQUIRED", message: "A label is required." });
  else if (input.label.trim().length > CUSTOM_FIELD_LABEL_MAX) issues.push({ field: "label", code: "TOO_LONG", message: `A label is at most ${CUSTOM_FIELD_LABEL_MAX} characters.` });
  if (typeof input.required !== "boolean") issues.push({ field: "required", code: "INVALID", message: "Say whether the field is required." });
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000) issues.push({ field: "sortOrder", code: "INVALID", message: "The order is a whole number from 0." });
  if (input.options !== null && !Array.isArray(input.options)) { issues.push({ field: "options", code: "INVALID", message: "Options are a list, or none." }); return; }
  if (type === null) return;
  for (const message of customFieldOptionIssues(type, input.options)) issues.push({ field: "options", code: "INVALID", message });
  if (input.defaultValue !== null && input.defaultValue !== undefined) {
    if (typeof input.defaultValue !== "string" || input.defaultValue.length > CUSTOM_FIELD_DEFAULT_MAX) issues.push({ field: "defaultValue", code: "INVALID", message: `A default is text of up to ${CUSTOM_FIELD_DEFAULT_MAX} characters, or none.` });
    else {
      const problem = customFieldValueIssue(type, input.defaultValue, input.options);
      if (problem) issues.push({ field: "defaultValue", code: "INVALID", message: `The default: ${problem}` });
    }
  }
};
const customFieldIdIssues = (issues: CommandIssue[], input: { definitionId: string; expectedVersion: number }) => {
  required(issues, "definitionId", input.definitionId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/** A portal broadcast (admin F4): title and body (R6), a style (R2), a link both-or-neither on the allow-list (R3), a window (R4). */
const portalBroadcastIssues = (issues: CommandIssue[], input: PortalBroadcastEditableFields) => {
  if (!text(input.title)) issues.push({ field: "title", code: "REQUIRED", message: "A title is required." });
  else if (input.title.trim().length > PORTAL_BROADCAST_TITLE_MAX) issues.push({ field: "title", code: "TOO_LONG", message: `A title is at most ${PORTAL_BROADCAST_TITLE_MAX} characters.` });
  if (!text(input.body)) issues.push({ field: "body", code: "REQUIRED", message: "A message is required." });
  else if (input.body.trim().length > PORTAL_BROADCAST_BODY_MAX) issues.push({ field: "body", code: "TOO_LONG", message: `A message is at most ${PORTAL_BROADCAST_BODY_MAX} characters.` });
  if (!isPortalBroadcastStyle(input.style)) issues.push({ field: "style", code: "INVALID", message: "Choose a style: information, warning, good news or promotion." });
  const url = text(input.linkUrl) ? input.linkUrl!.trim() : null;
  const label = text(input.linkLabel) ? input.linkLabel!.trim() : null;
  if (url !== null && !isAllowedBroadcastLink(url)) issues.push({ field: "linkUrl", code: "INVALID", message: "A link is an https:// address or one of the console's own pages (starting with /) — no other kind." });
  if (url !== null && label === null) issues.push({ field: "linkLabel", code: "REQUIRED", message: "A link needs a label." });
  if (url === null && label !== null) issues.push({ field: "linkUrl", code: "REQUIRED", message: "A label needs a link — or clear both." });
  if (label !== null && label.length > PORTAL_BROADCAST_LINK_LABEL_MAX) issues.push({ field: "linkLabel", code: "TOO_LONG", message: `A label is at most ${PORTAL_BROADCAST_LINK_LABEL_MAX} characters.` });
  if (!isBroadcastInstant(input.startsAt)) issues.push({ field: "startsAt", code: "REQUIRED", message: "A start is required." });
  if (input.endsAt !== null && !isBroadcastInstant(input.endsAt)) issues.push({ field: "endsAt", code: "INVALID", message: "An end is a date and time, or none — until deactivated." });
  else if (input.endsAt !== null && isBroadcastInstant(input.startsAt) && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) issues.push({ field: "endsAt", code: "BEFORE_START", message: "The end must be after the start." });
  if (input.targetClientId !== null && !text(input.targetClientId)) issues.push({ field: "targetClientId", code: "INVALID", message: "Choose a client, or every portal client." });
};
const portalBroadcastIdIssues = (issues: CommandIssue[], input: { broadcastId: string; expectedVersion: number }) => {
  required(issues, "broadcastId", input.broadcastId);
  if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
/** A milestone command's own fields: a job, one of the three kinds, a plain date where one is given (PR 3). */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDay = (value: unknown): value is string =>
  typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value); // date-helper-exempt: validating a plain date round-trips, it is not reading an instant
const milestoneIssues = (issues: CommandIssue[], input: { jobId: string; kind: unknown; expectedVersion?: number }) => {
  required(issues, "jobId", input.jobId);
  if (!isMilestoneKind(input.kind)) issues.push({ field: "kind", code: "INVALID", message: "A milestone is data collection, first draft or final report." });
  if (input.expectedVersion !== undefined && !positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
};
const reportSectionBodyIssues = (bodyHtml: unknown): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  if (typeof bodyHtml !== "string" || bodyHtml.trim().length === 0) { issues.push({ field: "bodyHtml", code: "REQUIRED", message: "Section body is required." }); return issues; }
  if (bodyHtml.length > 20_000) issues.push({ field: "bodyHtml", code: "TOO_LONG", message: "Section body must be 20,000 characters or fewer." });
  if (/<script\b|<\/script>|javascript:|\son\w+\s*=/i.test(bodyHtml)) issues.push({ field: "bodyHtml", code: "UNSAFE", message: "Section body must not contain scripts or event handlers." });
  return issues;
};
/**
 * The grain a figure was supplied at, and the figures themselves (NZC-107).
 *
 * How *many* figures are expected cannot be judged here — that depends on the job's reporting
 * period, which only the server knows — so the count is checked where the period is read. What is
 * checkable without a database is checked here: the grain is one of the three, a figure is a
 * finite number or deliberately absent, and month-grain capture does not also arrive with figures
 * to spread, which would be two answers to the same question.
 */
const activityGrainIssues = (input: { activityFrequency?: ActivityFrequency | null; activityFigures?: (number | null)[] | null }): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  const frequency = input.activityFrequency ?? null;
  if (frequency !== null && !isActivityFrequency(frequency)) {
    issues.push({ field: "activityFrequency", code: "INVALID", message: "Data frequency must be annual, quarterly or monthly." });
  }
  const figures = input.activityFigures ?? null;
  if (figures === null) return issues;
  if (frequency === null) {
    issues.push({ field: "activityFrequency", code: "REQUIRED", message: "Say which grain those figures were supplied at." });
  }
  if (frequency === "monthly") {
    issues.push({ field: "activityFigures", code: "INVALID", message: "Month-by-month activity is supplied as months, not as figures to spread." });
  }
  figures.forEach((figure, index) => {
    if (figure === null) return;
    if (typeof figure !== "number" || !Number.isFinite(figure) || figure < 0) {
      issues.push({ field: `activityFigures.${index}`, code: "INVALID", message: "Each figure must be zero or greater." });
    }
  });
  return issues;
};

const monthlyActivityIssues=(slots:MonthlyActivitySlot[]|undefined):CommandIssue[]=>{if(!slots?.length)return[];const issues:CommandIssue[]=[];const months=new Set<string>();for(const [index,slot] of slots.entries()){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(slot.month))issues.push({field:`monthlyActivity.${index}.month`,code:"INVALID",message:"Month must use YYYY-MM."});if(months.has(slot.month))issues.push({field:`monthlyActivity.${index}.month`,code:"DUPLICATE",message:"Each reporting month may appear only once."});months.add(slot.month);if(slot.quantity!==null&&(typeof slot.quantity!=="number"||!Number.isFinite(slot.quantity)||slot.quantity<0))issues.push({field:`monthlyActivity.${index}.quantity`,code:"INVALID",message:"Monthly quantity must be zero or greater."});}return issues;};
const lcaAssessmentIssues = (input: LcaAssessmentWriteFields): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  required(issues, "name", input.name);
  if (!oneOf(input.assessmentType, ["product", "service"] as const)) issues.push({ field: "assessmentType", code: "INVALID", message: "Assessment type must be product or service." });
  if (!oneOf(input.lifecycleBoundary, ["cradle_to_gate", "cradle_to_grave", "custom"] as const)) issues.push({ field: "lifecycleBoundary", code: "INVALID", message: "Lifecycle boundary is invalid." });
  if (typeof input.functionalUnitValue !== "number" || !Number.isFinite(input.functionalUnitValue) || input.functionalUnitValue <= 0) issues.push({ field: "functionalUnitValue", code: "INVALID", message: "Functional unit value must be greater than zero." });
  required(issues, "functionalUnitUnit", input.functionalUnitUnit);
  if (input.confirmedQuantity != null && (typeof input.confirmedQuantity !== "number" || !Number.isFinite(input.confirmedQuantity) || input.confirmedQuantity < 0)) issues.push({ field: "confirmedQuantity", code: "INVALID", message: "Confirmed quantity must be zero or greater." });
  if (!Array.isArray(input.includedModules) || input.includedModules.length === 0) issues.push({ field: "includedModules", code: "REQUIRED", message: "Include at least one EN 15804 module." });
  else if (input.includedModules.some((code) => !lcaModuleCodes.includes(code))) issues.push({ field: "includedModules", code: "INVALID", message: "Every module must be a recognised EN 15804 code." });
  if (input.referenceYear != null && (typeof input.referenceYear !== "number" || !Number.isInteger(input.referenceYear) || input.referenceYear < 2000 || input.referenceYear > 2100)) issues.push({ field: "referenceYear", code: "INVALID", message: "Reference year is out of range." });
  return issues;
};
const lcaLineItemIssues = (input: LcaLineItemWriteFields): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  required(issues, "lineLabel", input.lineLabel);
  if (!lcaModuleCodes.includes(input.moduleCode)) issues.push({ field: "moduleCode", code: "INVALID", message: "Module code is not a recognised EN 15804 code." });
  if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0) issues.push({ field: "quantity", code: "INVALID", message: "Quantity must be zero or greater." });
  required(issues, "unit", input.unit);
  if (input.energyKwh != null && (typeof input.energyKwh !== "number" || !Number.isFinite(input.energyKwh) || input.energyKwh < 0)) issues.push({ field: "energyKwh", code: "INVALID", message: "Energy must be zero or greater." });
  if (input.endOfLifeRoute != null && !oneOf(input.endOfLifeRoute, ["landfill", "recycling", "incineration", "compost", "reuse", "other"] as const)) issues.push({ field: "endOfLifeRoute", code: "INVALID", message: "End-of-life route is invalid." });
  const factorSource = input.factorSource ?? "unmapped";
  if (!oneOf(factorSource, ["dataset", "client", "manual", "unmapped"] as const)) issues.push({ field: "factorSource", code: "INVALID", message: "Factor source is invalid." });
  else if (factorSource === "dataset" && (!text(input.factorId) || !text(input.datasetId))) issues.push({ field: "factorId", code: "REQUIRED", message: "A dataset factor must identify its factor and dataset." });
  else if (factorSource === "client" && !text(input.clientFactorId)) issues.push({ field: "clientFactorId", code: "REQUIRED", message: "A client-factor line must identify its client factor." });
  else if (factorSource === "manual" && input.factorValue == null) issues.push({ field: "factorValue", code: "REQUIRED", message: "A manual factor must give its value." });
  if (input.dataQuality != null && !oneOf(input.dataQuality, ["primary", "secondary", "proxy", "estimated"] as const)) issues.push({ field: "dataQuality", code: "INVALID", message: "Data quality is invalid." });
  return issues;
};
const lcaTransportLegIssues = (input: LcaTransportLegWriteFields): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  required(issues, "fromLabel", input.fromLabel);
  required(issues, "toLabel", input.toLabel);
  if (!lcaTransportModes.includes(input.mode)) issues.push({ field: "mode", code: "INVALID", message: "Transport mode is not recognised." });
  if (typeof input.distanceKm !== "number" || !Number.isFinite(input.distanceKm) || input.distanceKm < 0) issues.push({ field: "distanceKm", code: "INVALID", message: "Distance must be zero or greater." });
  if (input.distanceSource != null && !oneOf(input.distanceSource, ["geocoded", "manual"] as const)) issues.push({ field: "distanceSource", code: "INVALID", message: "Distance source is invalid." });
  const factorSource = input.factorSource ?? "unmapped";
  // No client_factor_id column on lca_transport_legs (unlike line items) — 'client' is not offered here.
  if (!oneOf(factorSource, ["dataset", "manual", "unmapped"] as const)) issues.push({ field: "factorSource", code: "INVALID", message: "Factor source is invalid for a transport leg." });
  else if (factorSource === "dataset" && (!text(input.factorId) || !text(input.datasetId))) issues.push({ field: "factorId", code: "REQUIRED", message: "A dataset factor must identify its factor and dataset." });
  else if (factorSource === "manual" && input.factorValue == null) issues.push({ field: "factorValue", code: "REQUIRED", message: "A manual factor must give its value." });
  return issues;
};
const lcaScenarioMultiplierIssues = (input: LcaScenarioMultiplierWriteFields): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  if (!lcaModuleCodes.includes(input.moduleCode)) issues.push({ field: "moduleCode", code: "INVALID", message: "Module code is not a recognised EN 15804 code." });
  if (typeof input.multiplier !== "number" || !Number.isFinite(input.multiplier) || input.multiplier < 0) issues.push({ field: "multiplier", code: "INVALID", message: "Multiplier must be zero or greater." });
  if (input.materialCategoryId != null && input.componentId != null) issues.push({ field: "componentId", code: "CONFLICT", message: "A rule targets a material category or a component, not both." });
  return issues;
};
const lcaGapFillIssues = (input: LcaGapFillWriteFields): CommandIssue[] => {
  const issues: CommandIssue[] = [];
  if (typeof input.factorValue !== "number" || !Number.isFinite(input.factorValue) || input.factorValue < 0) issues.push({ field: "factorValue", code: "INVALID", message: "Factor value must be zero or greater." });
  required(issues, "gapFillMethod", input.gapFillMethod);
  if (input.dataQuality != null && !oneOf(input.dataQuality, ["primary", "secondary", "proxy", "estimated"] as const)) issues.push({ field: "dataQuality", code: "INVALID", message: "Data quality is invalid." });
  return issues;
};
const assertedVehicleIssues = (value: ScopeRowWriteFields["assertedVehicleAttributes"]): CommandIssue[] => { if (value == null) return []; const short = (v: unknown) => v === null || (typeof v === "string" && v.length <= 40); if (typeof value !== "object" || !["dvla", "stub"].includes(value.source) || !short(value.fuel) || !short(value.vehicleClass) || Object.keys(value).some((key) => !["source", "fuel", "vehicleClass"].includes(key))) return [{ field: "assertedVehicleAttributes", code: "INVALID", message: "Vehicle attributes are a lookup source, a fuel and a class — nothing else, and never a registration." }]; return []; };
const scopeRowIssues = (input: ScopeRowWriteFields) => { const issues: CommandIssue[] = [...monthlyActivityIssues(input.monthlyActivity), ...activityGrainIssues(input), ...assertedVehicleIssues(input.assertedVehicleAttributes)]; if (input.factorOverrideReason != null && (typeof input.factorOverrideReason !== "string" || input.factorOverrideReason.trim().length > 500)) issues.push({ field: "factorOverrideReason", code: "INVALID", message: "The reason for choosing a different factor must be text of 500 characters or fewer." }); required(issues, "scope", input.scope); required(issues, "sourceLabel", input.sourceLabel); if (input.assetIdentifier != null && (typeof input.assetIdentifier !== "string" || input.assetIdentifier.trim().length > 240)) issues.push({field:"assetIdentifier",code:"INVALID",message:"ID / Reference must be text of 240 characters or fewer."}); if (input.applyPct != null && (typeof input.applyPct!=="number"||!Number.isFinite(input.applyPct)||input.applyPct<0||input.applyPct>100)) issues.push({field:"applyPct",code:"INVALID",message:"Apportionment must be between 0 and 100%."}); if (input.dataConfidence != null && !(["H","M","L"] as const).includes(input.dataConfidence)) issues.push({field:"dataConfidence",code:"INVALID",message:"Data confidence must be high, medium, or low."}); if (input.sourceQuantity != null && (typeof input.sourceQuantity!=="number"||!Number.isFinite(input.sourceQuantity)||input.sourceQuantity<0)) issues.push({field:"sourceQuantity",code:"INVALID",message:"As-entered quantity must be zero or greater."}); if ((input.sourceQuantity!=null)!==Boolean(text(input.sourceUnit))) issues.push({field:"sourceUnit",code:"PAIRED",message:"As-entered quantity and unit must be provided together."}); const factorSource=input.factorSource??"dataset";if(factorSource==="client"&&(!text(input.clientFactorId)||input.isCustomEntry!==true))issues.push({field:"clientFactorId",code:"REQUIRED",message:"A client factor row must identify its client factor."});if(factorSource==="dataset"&&(text(input.clientFactorId)||input.isCustomEntry===true))issues.push({field:"factorSource",code:"INCONSISTENT",message:"Dataset factors cannot carry client-factor identity."}); if (typeof input.scope === "string" && !crpScopeOptions.some((option) => option.value === input.scope)) issues.push({ field: "scope", code: "INVALID", message: "Select a controlled Scope 1, Scope 2, or Scope 3 category." }); if (input.quantity !== null && (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0)) issues.push({ field: "quantity", code: "INVALID", message: "Quantity must be zero or greater." }); if (input.overrideTco2e != null && (typeof input.overrideTco2e !== "number" || !Number.isFinite(input.overrideTco2e) || input.overrideTco2e < 0)) issues.push({ field: "overrideTco2e", code: "INVALID", message: "Override emissions must be zero or greater." }); if (input.overrideTco2e != null && !text(input.overrideReason)) issues.push({ field: "overrideReason", code: "REQUIRED", message: "Explain why the calculated result is being overridden." }); if (input.overrideTco2e == null && text(input.overrideReason)) issues.push({ field: "overrideReason", code: "ORPHANED", message: "Remove the override reason or enter an override value." }); if (input.factorId && !input.datasetId && factorSource!=="client") issues.push({ field: "datasetId", code: "REQUIRED", message: "A dataset factor must identify its dataset." }); if (input.categoryCode != null && input.categoryCode !== "") { const category = emissionCategoryTaxonomy.find((entry) => entry.code === input.categoryCode); if (!category) issues.push({ field: "categoryCode", code: "INVALID", message: "Category code is not in the emission taxonomy (NZC-046)." }); else if (typeof input.scope === "string" && category.scope !== input.scope.split(".")[0]) issues.push({ field: "categoryCode", code: "INCONSISTENT", message: "Category belongs to a different scope than the row." }); } return issues; };

/** The Compliance tab's "Primary Scope 3 categories" are the canonical taxonomy codes, not a parallel list. */
export const scope3CategoryCodes: readonly string[] = emissionCategoryTaxonomy.filter((entry) => entry.scope === "3").map((entry) => entry.code);

/**
 * F1 remedy (1) — client.update validates only what the save changes.
 *
 * Every client editor sends the whole record, so a held value that fails today's rules (433 imported clients have no
 * location and an unpaired net-zero target) refused every save of an unrelated field. The rule now:
 * - the handler compares each incoming field with the **stored row** (loaded under its lock — never the caller's word
 *   for what changed), normalised the way it would be stored;
 * - only changed fields are validated, so an untouched held value stands, however it reads today;
 * - a **pair**'s rule runs when either member changed, so a half-edit cannot leave a new invalid pair;
 * - a held field that **is** edited must become valid — it tightens on write, it does not grandfather forever.
 * client.create is unchanged: everything is validated.
 */
export type ClientHeldFields = ClientIdentityFields & ClientProfileFields;
const CLIENT_COMPARED_FIELDS = [
  "name", "status", "sector", "location", "owner",
  "portfolio", "clientManager", "website", "industrySic", "companyRegistration", "headquarters", "financialYearEndMonth",
  "dataReportingFrequency", "currency", "logoUrl", "companyDescription", "referral", "contactName", "contactRole", "contactEmail",
  "netZeroTargetYear", "netZeroTargetReductionPct", "baselinePeriodStart", "baselinePeriodEnd",
  "baselineScope1Tco2e", "baselineScope2Tco2e", "baselineScope3Tco2e", "baselineTotalTco2e",
  "scope1InterimYear", "scope1InterimReductionPct", "scope2InterimYear", "scope2InterimReductionPct", "scope3InterimYear", "scope3InterimReductionPct",
  "registeredAddressLine1", "registeredAddressLine2", "registeredCity", "registeredRegion", "registeredPostcode", "registeredCountry",
  "billingSameAsRegistered", "billingCompany", "billingAddressLine1", "billingAddressLine2", "billingCity", "billingRegion", "billingPostcode", "billingCountry",
  "parentCompany", "groupStructure", "reportingFrameworks", "certifications", "primaryScope3Categories",
] as const satisfies ReadonlyArray<keyof ClientHeldFields>;
/** Fields whose rule spans both members: it runs when either changed. */
const CLIENT_PAIRED_FIELDS: ReadonlyArray<readonly [keyof ClientHeldFields, keyof ClientHeldFields]> = [
  ["netZeroTargetYear", "netZeroTargetReductionPct"], ["baselinePeriodStart", "baselinePeriodEnd"],
];
/** A field as it would be stored: blank text is null, numbers are numbers, lists keep their order, the website normalised. */
const storedForm = (field: keyof ClientHeldFields, value: unknown): unknown => {
  if (value === undefined || value === null) return field === "billingSameAsRegistered" ? true : null;
  if (field === "website") return normaliseWebsite(value as string);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") { const text = value.trim(); return text === "" ? null : text; }
  if (typeof value === "number") return value;
  return value;
};
/** The fields an update changes, against the stored row; a pair counts as changed when either member did. */
export function changedClientFields(input: Partial<ClientHeldFields>, held: Partial<ClientHeldFields>): Set<string> {
  const changed = new Set<string>(CLIENT_COMPARED_FIELDS.filter((field) => {
    // An omitted currency keeps the held one (E-Q3), so omitting it is no change.
    if (field === "currency" && input.currency === undefined) return false;
    return storedForm(field, input[field]) !== storedForm(field, held[field]);
  }));
  for (const pair of CLIENT_PAIRED_FIELDS) if (pair.some((field) => changed.has(field))) pair.forEach((field) => changed.add(field));
  return changed;
}
/** client.update's field rules, kept to the fields the save changes (F1 remedy (1)). */
export function clientUpdateIssues(input: ClientHeldFields, held: Partial<ClientHeldFields>): CommandIssue[] {
  const changed = changedClientFields(input, held);
  return [...clientIdentityIssues(input), ...clientProfileIssues(input)].filter((issue) => changed.has(issue.field));
}

const clientIdentityIssues = (input: ClientIdentityFields) => {
  const issues: CommandIssue[] = [];
  required(issues, "name", input.name); required(issues, "sector", input.sector);
  required(issues, "location", input.location); required(issues, "owner", input.owner);
  if (!oneOf(input.status, ["active", "onboarding", "at-risk", "prospect"] as const)) issues.push({ field: "status", code: "INVALID", message: "Client status is invalid." });
  return issues;
};

const optionalYear = (issues: CommandIssue[], field: string, value: unknown) => { if (value == null) return; if (!Number.isInteger(value) || (value as number) < 2020 || (value as number) > 2100) issues.push({ field, code: "INVALID", message: "Target year must be a year between 2020 and 2100." }); };
const optionalPercent = (issues: CommandIssue[], field: string, value: unknown) => { if (value == null) return; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) issues.push({ field, code: "INVALID", message: "Reduction must be between 0 and 100%." }); };
const optionalTonnes = (issues: CommandIssue[], field: string, value: unknown) => { if (value == null) return; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) issues.push({ field, code: "INVALID", message: "Baseline emissions must be zero or greater." }); };
const optionalMembers = (issues: CommandIssue[], field: string, value: unknown, allowed: readonly string[]) => {
  if (value == null) return;
  if (!Array.isArray(value)) { issues.push({ field, code: "INVALID", message: "Expected a list of selections." }); return; }
  const unknownMember = value.find((entry) => !allowed.includes(entry as string));
  if (unknownMember !== undefined) issues.push({ field, code: "INVALID", message: `"${String(unknownMember)}" is not a recognised option.` });
  if (new Set(value).size !== value.length) issues.push({ field, code: "INVALID", message: "Selections must not repeat." });
};

const clientProfileIssues = (input: ClientProfileFields) => {
  const issues: CommandIssue[] = [];
  if (input.dataReportingFrequency != null && !oneOf(input.dataReportingFrequency, clientReportingFrequencies)) issues.push({ field: "dataReportingFrequency", code: "INVALID", message: "Reporting frequency must be annual, quarterly or monthly." });
  if (input.currency != null && !/^[A-Z]{3}$/.test(input.currency)) issues.push({ field: "currency", code: "INVALID", message: "Currency must be a three-letter ISO 4217 code." });
  if (input.financialYearEndMonth != null && (!Number.isInteger(input.financialYearEndMonth) || input.financialYearEndMonth < 1 || input.financialYearEndMonth > 12)) issues.push({ field: "financialYearEndMonth", code: "INVALID", message: "Financial year end must be a calendar month." });
  // CLIENT-07: a bare domain is normalised (https:// prepended), never refused; only what is not an address is.
  { const website = normaliseWebsite(input.website); if (website !== null && !isValidWebsite(website)) issues.push({ field: "website", code: "INVALID", message: "Enter a website address, e.g. acme.com — an http or https address." }); }
  if (text(input.logoUrl) && !/^https?:\/\/\S+$/i.test(input.logoUrl!.trim())) issues.push({ field: "logoUrl", code: "INVALID", message: "Logo URL must start with http:// or https://." });
  if (text(input.contactEmail) && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(input.contactEmail!.trim())) issues.push({ field: "contactEmail", code: "INVALID", message: "Enter a valid contact email address." });

  optionalYear(issues, "netZeroTargetYear", input.netZeroTargetYear);
  optionalPercent(issues, "netZeroTargetReductionPct", input.netZeroTargetReductionPct);
  for (const scope of [1, 2, 3] as const) {
    optionalYear(issues, `scope${scope}InterimYear`, input[`scope${scope}InterimYear`]);
    optionalPercent(issues, `scope${scope}InterimReductionPct`, input[`scope${scope}InterimReductionPct`]);
    optionalTonnes(issues, `baselineScope${scope}Tco2e`, input[`baselineScope${scope}Tco2e`]);
  }
  optionalTonnes(issues, "baselineTotalTco2e", input.baselineTotalTco2e);
  for (const field of ["baselinePeriodStart", "baselinePeriodEnd"] as const) if (input[field] != null && !isoDate(input[field])) issues.push({ field, code: "INVALID", message: "Enter the baseline period dates as dd/mm/yyyy." });
  if (isoDate(input.baselinePeriodStart) && isoDate(input.baselinePeriodEnd) && input.baselinePeriodEnd! <= input.baselinePeriodStart!) issues.push({ field: "baselinePeriodEnd", code: "INVALID_RANGE", message: "Baseline period end must fall after its start." });
  // A net-zero target the trajectory cannot anchor is worse than no target at all.
  if (input.netZeroTargetYear != null && input.netZeroTargetReductionPct == null) issues.push({ field: "netZeroTargetReductionPct", code: "PAIRED", message: "A net-zero target year needs its reduction percentage." });
  // And the reverse (NET-ZERO follow-ups, Part A): a % with no year is half a target too.
  if (input.netZeroTargetReductionPct != null && input.netZeroTargetYear == null) issues.push({ field: "netZeroTargetYear", code: "PAIRED", message: "A net-zero reduction percentage needs its target year." });

  if (input.groupStructure != null && !oneOf(input.groupStructure, clientGroupStructures)) issues.push({ field: "groupStructure", code: "INVALID", message: "Group structure is invalid." });
  optionalMembers(issues, "reportingFrameworks", input.reportingFrameworks, clientReportingFrameworks);
  optionalMembers(issues, "certifications", input.certifications, clientCertifications);
  optionalMembers(issues, "primaryScope3Categories", input.primaryScope3Categories, scope3CategoryCodes);
  if (input.billingSameAsRegistered != null && typeof input.billingSameAsRegistered !== "boolean") issues.push({ field: "billingSameAsRegistered", code: "INVALID", message: "Billing address flag must be true or false." });
  return issues;
};

const targetMilestoneIssues = (issues: CommandIssue[], field: string, milestone: TargetMilestoneFields | undefined) => {
  const year = milestone?.year ?? null, pct = milestone?.pct ?? null;
  if (year === null && pct === null) return;
  if ((year === null) !== (pct === null)) { issues.push({ field, code: "PAIRED", message: "A target needs both its year and its reduction." }); return; }
  if (!Number.isInteger(year) || year! < 2000 || year! > 2100) issues.push({ field: `${field}.year`, code: "INVALID", message: "Target year must be a year between 2000 and 2100." });
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) issues.push({ field: `${field}.pct`, code: "INVALID", message: "Reduction must be between 0 and 100%." });
};

const forwardTargetIssues = (input: ForwardTargetWriteFields) => {
  const issues: CommandIssue[] = [];
  for (const field of forwardTargetFields) targetMilestoneIssues(issues, field, input[field]);
  const near = input.nearTerm, netZero = input.netZero;
  if (issues.length === 0 && near?.year != null && netZero?.year != null) {
    // Net zero is the further, deeper commitment — the pathway would otherwise turn back on itself.
    if (netZero.year < near.year) issues.push({ field: "netZero.year", code: "ORDER", message: "The net-zero year cannot come before the near-term year." });
    else if ((netZero.pct ?? 0) < (near.pct ?? 0)) issues.push({ field: "netZero.pct", code: "ORDER", message: "The net-zero reduction cannot be smaller than the near-term one." });
  }
  return issues;
};

const clientContactIssues = (input: ClientContactWriteFields) => {
  const issues: CommandIssue[] = [];
  required(issues, "fullName", input.fullName);
  if (text(input.email) && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(input.email!.trim())) issues.push({ field: "email", code: "INVALID", message: "Enter a valid email address." });
  if (typeof input.isPrimary !== "boolean") issues.push({ field: "isPrimary", code: "INVALID", message: "Primary contact must be true or false." });
  optionalMembers(issues, "roles", input.roles, clientContactRoles);
  if (!Array.isArray(input.roles)) issues.push({ field: "roles", code: "REQUIRED", message: "Roles must be a list (it may be empty)." });
  else if (input.roles.includes("portal_candidate") && !text(input.email)) issues.push({ field: "email", code: "REQUIRED", message: "A portal candidate needs an email address to be invited." });
  return issues;
};

export const commandDefinitions: { [K in CommandKey]: CommandDefinition<K> } = {
  "client.create": { key: "client.create", label: "Create client", permission: "client.create", reasonRequired: false, transaction: "client + audit + outbox + idempotency", auditAction: "client_created", validate: (input, context) => [...baseIssues(context, false), ...clientIdentityIssues(input), ...clientProfileIssues(input)] },
  "client.update": { key: "client.update", label: "Update client", permission: "client.edit", reasonRequired: false, transaction: "versioned client + audit + outbox + idempotency", auditAction: "client_updated", validate: (input, context) => { /* F1 remedy (1): the field rules run in the handler, against the stored row — only on what the save changes (clientUpdateIssues). */ const issues = [...baseIssues(context, false)]; required(issues, "clientId", input.clientId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "job.create": { key: "job.create", label: "Create job", permission: "job.manage", reasonRequired: false, transaction: "number allocation + job + audit + outbox + idempotency", auditAction: "job_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "title", input.title); required(issues, "workflowStage", input.workflowStage); required(issues, "owner", input.owner); if (!oneOf(input.family, ["crp", "consultancy", "lca", "pcf", "training"] as const)) issues.push({ field: "family", code: "INVALID", message: "Job family is invalid." }); issues.push(...jobDateIssues(input, { family: oneOf(input.family, ["crp", "consultancy", "lca", "pcf", "training"] as const) ? input.family : undefined })); return issues; } },
  "job.stage.change": { key: "job.stage.change", label: "Change job stage", permission: "job.manage", reasonRequired: false, transaction: "stage history + job header", auditAction: "job_stage_changed", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "fromStage", input.fromStage); required(issues, "toStage", input.toStage); if (input.fromStage === input.toStage) issues.push({ field: "toStage", code: "NO_CHANGE", message: "New stage must differ from the current stage." }); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  // PR 3 — the milestone command. Delivery work on a job, so job.manage and the job's client scope, as a stage change.
  "job.milestone.set": { key: "job.milestone.set", label: "Set a milestone's due date", permission: "job.manage", reasonRequired: false, transaction: "milestone (manual) + audit + outbox + idempotency", auditAction: "job.milestone.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    milestoneIssues(issues, input);
    if (input.dueDate !== null && !isCalendarDay(input.dueDate)) issues.push({ field: "dueDate", code: "INVALID", message: "A due date is a calendar date, or none to clear it." });
    return issues;
  } },
  "job.milestone.complete": { key: "job.milestone.complete", label: "Complete a milestone", permission: "job.manage", reasonRequired: false, transaction: "milestone completion + audit + outbox + idempotency", auditAction: "job.milestone.completed", validate: (input, context) => {
    const issues = baseIssues(context, false);
    milestoneIssues(issues, input);
    if (input.completedAt !== undefined && !isCalendarDay(input.completedAt)) issues.push({ field: "completedAt", code: "INVALID", message: "A completion date is a calendar date." });
    return issues;
  } },
  "job.milestone.reopen": { key: "job.milestone.reopen", label: "Reopen a milestone", permission: "job.manage", reasonRequired: true, transaction: "completion cleared + audit + outbox + idempotency", auditAction: "job.milestone.reopened", validate: (input, context) => {
    // Clearing a recorded completion rewrites what the job says happened, so it says why (Q12).
    const issues = baseIssues(context, true);
    milestoneIssues(issues, input);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "job.milestone.reschedule": { key: "job.milestone.reschedule", label: "Reschedule milestones from the template", permission: "job.manage", reasonRequired: false, transaction: "job template + template milestones + audit + outbox + idempotency", auditAction: "job.milestone.rescheduled", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    if (input.milestoneTemplateId !== undefined && input.milestoneTemplateId !== null && !text(input.milestoneTemplateId)) issues.push({ field: "milestoneTemplateId", code: "INVALID", message: "Choose a template, or none." });
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // job.update (ruled J1–J6). The guards that need the job and its data (closed, imported, family, period-bound data,
  // and the reason a period change needs) are the command's, where the job is locked; here, only the shape.
  "job.update": { key: "job.update", label: "Edit a job's schedule", permission: "job.manage", reasonRequired: false, transaction: "job + emissions window + datasets + template milestones + audit + outbox + idempotency", auditAction: "job.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    for (const field of ["startDate", "reportingPeriodStart", "reportingPeriodEnd"] as const) {
      const value = input[field];
      if (value !== undefined && value !== null && !isCalendarDay(value)) issues.push({ field, code: "INVALID", message: "A date is a calendar date." });
    }
    if (input.startDate === null) issues.push({ field: "startDate", code: "REQUIRED", message: "A job has a start date." });
    if (input.milestoneTemplateId !== undefined && input.milestoneTemplateId !== null && !text(input.milestoneTemplateId)) issues.push({ field: "milestoneTemplateId", code: "INVALID", message: "Choose a template, or none." });
    return issues;
  } },
  "scope.row.create": { key: "scope.row.create", label: "Create scope row", permission: "scoperow.edit", reasonRequired: false, transaction: "scope row + audit + outbox + idempotency", auditAction: "scope_row_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...scopeRowIssues(input)]; required(issues, "jobId", input.jobId); return issues; } },
  "scope.row.update": { key: "scope.row.update", label: "Update scope row", permission: "scoperow.edit", reasonRequired: false, transaction: "versioned scope row + audit + outbox + idempotency", auditAction: "scope_row_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...scopeRowIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "rowId", input.rowId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.row.discard": { key: "scope.row.discard", label: "Discard a draft scope row", permission: "scoperow.edit", reasonRequired: false, transaction: "draft-only hard delete (no saved data) + audit + outbox + idempotency", auditAction: "scope_row_discarded", validate: (input, context) => scopeRowStateIssues(input, context, false) },
  "scope.row.deactivate": { key: "scope.row.deactivate", label: "Deactivate a scope row", permission: "scoperow.edit", reasonRequired: true, transaction: "deactivation (never deletion; figures kept) + audit + outbox + idempotency", auditAction: "scope_row_deactivated", validate: (input, context) => scopeRowStateIssues(input, context, true) },
  "scope.row.reactivate": { key: "scope.row.reactivate", label: "Reactivate a scope row", permission: "scoperow.edit", reasonRequired: false, transaction: "reactivation + audit + outbox + idempotency", auditAction: "scope_row_reactivated", validate: (input, context) => scopeRowStateIssues(input, context, false) },
  "scope.row.calculate": { key: "scope.row.calculate", label: "Calculate scope row", permission: "scoperow.edit", reasonRequired: false, transaction: "factor validation + numeric calculation + lineage", auditAction: "scope_row_calculated", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "rowId", input.rowId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "scope.review.approve": { key: "scope.review.approve", label: "Approve scope rows", permission: "snapshot.review", reasonRequired: false, transaction: "scope rows + review history", auditAction: "scope_rows_approved", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); if (!input.rowIds.length) issues.push({ field: "rowIds", code: "REQUIRED", message: "Select at least one scope row." }); if (!positive(input.expectedReviewVersion)) issues.push({ field: "expectedReviewVersion", code: "INVALID", message: "Expected review version must be positive." }); return issues; } },
  "scope.review.reject": { key: "scope.review.reject", label: "Reject scope rows", permission: "snapshot.review", reasonRequired: false, transaction: "scope rows + review history", auditAction: "scope_rows_rejected", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues,"reviewerNote",input.reviewerNote);if (!input.rowIds.length) issues.push({ field: "rowIds", code: "REQUIRED", message: "Select at least one scope row." }); if (!positive(input.expectedReviewVersion)) issues.push({ field: "expectedReviewVersion", code: "INVALID", message: "Expected review version must be positive." }); return issues; } },
  "report.publish": { key: "report.publish", label: "Publish report", permission: "report.publish", reasonRequired: false, transaction: "immutable version + manifest + portal outbox", auditAction: "report_published", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "reportVersionId", input.reportVersionId); required(issues, "reviewedSnapshotId", input.reviewedSnapshotId); if (input.expectedStatus !== "validated") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Only validated reports may be published." }); if (!positive(input.manifestVersion)) issues.push({ field: "manifestVersion", code: "INVALID", message: "Manifest version must be positive." }); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "report.validate":{key:"report.validate",label:"Validate report version",permission:"report.publish",reasonRequired:false,transaction:"snapshot resolution + manifest gate + immutable report version",auditAction:"report_validated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"reviewedSnapshotId",input.reviewedSnapshotId);if(!positive(input.manifestVersion))issues.push({field:"manifestVersion",code:"INVALID",message:"Manifest version must be positive."});return issues;}},
  "report.snapshot.create": { key:"report.snapshot.create",label:"Create reviewed snapshot",permission:"report.edit",reasonRequired:false,transaction:"QA gate + immutable snapshot + content hash",auditAction:"reviewed_snapshot_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);if(!positive(input.expectedJobVersion))issues.push({field:"expectedJobVersion",code:"INVALID",message:"Expected job version must be positive."});return issues;} },
  "report.snapshot.approve": { key: "report.snapshot.approve", label: "Approve reviewed snapshot", permission: "snapshot.review", reasonRequired: false, transaction: "separation-of-duties check + approval stamp + audit", auditAction: "reviewed_snapshot_approved", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "reviewedSnapshotId", input.reviewedSnapshotId); return issues; } },
  "client.contact.create": { key: "client.contact.create", label: "Add client contact", permission: "contact.manage", reasonRequired: false, transaction: "contact + version history + audit + outbox + idempotency", auditAction: "client_contact_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...clientContactIssues(input)]; required(issues, "clientId", input.clientId); return issues; } },
  "client.contact.update": { key: "client.contact.update", label: "Edit client contact", permission: "contact.manage", reasonRequired: false, transaction: "versioned contact + history + audit + outbox + idempotency", auditAction: "client_contact_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...clientContactIssues(input)]; required(issues, "contactId", input.contactId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "client.contact.deactivate": { key: "client.contact.deactivate", label: "Remove client contact", permission: "contact.manage", reasonRequired: false, transaction: "deactivation (never deletion) + history + audit + outbox + idempotency", auditAction: "client_contact_deactivated", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "contactId", input.contactId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  // Gated by `contact.manage`, which is already held by exactly Admin and Consultant and by
  // neither Finance nor Viewer — the holders this control needs. A second capability with
  // the same holders would be a matrix version that changed nobody's access.
  "client.contact.consent.record": {
    key: "client.contact.consent.record", label: "Record email consent", permission: "contact.manage",
    reasonRequired: false,
    transaction: "consent state + append-only consent event + audit + outbox + idempotency",
    auditAction: "client_contact_consent_recorded",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "contactId", input.contactId);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      if (!(contactConsentDecisions as readonly string[]).includes(input.state)) {
        // `unknown` lands here: it is the fail-closed default, not a decision to record.
        issues.push({ field: "state", code: "INVALID", message: "Consent is recorded as granted or declined." });
      }
      if (!isStaffRecordableBasis(input.basis)) {
        // Including `portal-self-serve`, which is phase 2 and is the contact's own action:
        // the console must not be able to claim a client acted on their own behalf.
        issues.push({ field: "basis", code: "INVALID", message: "Record how this decision reached NZI: recorded by a consultant, or imported with the contact." });
      }
      return issues;
    },
  },
  "training.booking.create": { key: "training.booking.create", label: "Book a trainee onto a run", permission: "training.manage", reasonRequired: false, transaction: "booking + atomic entitlement reserve + audit + outbox + idempotency", auditAction: "training_booking_created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "courseRunId", input.courseRunId);
    // A booking belongs to a person, not to a typed-in name — that is the whole spine.
    required(issues, "traineeId", input.traineeId);
    if (!oneOf(input.participantType, ["external_individual", "client_employee", "internal", "partner"] as const)) {
      issues.push({ field: "participantType", code: "INVALID", message: "Participant type is invalid." });
    }
    return issues;
  } },
  "training.attendance.set": { key: "training.attendance.set", label: "Record attendance", permission: "training.manage", reasonRequired: false, transaction: "session attendance upsert + audit + outbox + idempotency", auditAction: "training_attendance_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "sessionId", input.sessionId);
    required(issues, "bookingId", input.bookingId);
    if (!oneOf(input.attendanceStatus, ["booked", "present", "absent", "excused"] as const)) {
      issues.push({ field: "attendanceStatus", code: "INVALID", message: "Attendance status is invalid." });
    }
    if (input.attendanceMinutes != null && !(Number.isInteger(input.attendanceMinutes) && input.attendanceMinutes >= 0)) {
      issues.push({ field: "attendanceMinutes", code: "INVALID", message: "Attended minutes are zero or greater." });
    }
    return issues;
  } },
  "training.certificate.issue": { key: "training.certificate.issue", label: "Issue eligible certificates", permission: "training.manage", reasonRequired: false, transaction: "policy check + content-hashed certificates + entitlement consume + audit + outbox + idempotency", auditAction: "training_certificates_issued", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "courseRunId", input.courseRunId);
    if (!Number.isInteger(input.expectedRunVersion) || input.expectedRunVersion < 1) issues.push({ field: "expectedRunVersion", code: "INVALID", message: "Expected version must be one or greater." });
    return issues;
  } },
  "training.entitlement.expiry.set": { key: "training.entitlement.expiry.set", label: "Move a training place's expiry", permission: "training.entitlement.manage", reasonRequired: true, transaction: "entitlement expiry + default flag cleared + audit + outbox + idempotency", auditAction: "training_entitlement_expiry_set", validate: (input, context) => {
    const issues = baseIssues(context, true);
    // A grant's places share one date, so the grant is what moves — one act, one audit
    // event, all-or-nothing. Moving three of ten is how a strip starts disagreeing with
    // itself.
    if (!Array.isArray(input.entitlementIds) || input.entitlementIds.length === 0) {
      issues.push({ field: "entitlementIds", code: "REQUIRED", message: "Name at least one place to move." });
    }
    // Moving a date somebody is relying on is a deliberate act, so it carries a reason.
    required(issues, "reason", input.reason);
    if (input.expiresAt !== null && !isoDate(input.expiresAt)) issues.push({ field: "expiresAt", code: "INVALID", message: "Enter the expiry as dd/mm/yyyy, or clear it." });
    return issues;
  } },
  "training.run.stage.set": { key: "training.run.stage.set", label: "Move the run's stage", permission: "training.manage", reasonRequired: false, transaction: "versioned run stage + audit + outbox + idempotency", auditAction: "training_run_stage_changed", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "courseRunId", input.courseRunId);
    if (!isAllowedTrainingRunStageTransition(input.fromStage, input.toStage)) {
      issues.push({ field: "toStage", code: "INVALID_TRANSITION", message: "A run moves one stage at a time." });
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be one or greater." });
    return issues;
  } },
  "training.run.review": { key: "training.run.review", label: "Review the run", permission: "snapshot.review", reasonRequired: false, transaction: "content-addressed run snapshot + review stamp + audit + outbox + idempotency", auditAction: "training_run_reviewed", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "courseRunId", input.courseRunId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be one or greater." });
    return issues;
  } },
  "client.intensityMetric.set": { key: "client.intensityMetric.set", label: "Define an intensity metric", permission: "client.edit", reasonRequired: false, transaction: "versioned metric definition + audit + outbox + idempotency", auditAction: "client_intensity_metric_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "clientId", input.clientId);
    required(issues, "label", input.label);
    required(issues, "unitWording", input.unitWording);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.metricKey ?? "")) issues.push({ field: "metricKey", code: "INVALID", message: "A metric key is lower-case letters, digits, dashes or underscores." });
    if (!intensityDividers.includes(input.divider as IntensityDivider)) issues.push({ field: "divider", code: "INVALID", message: "The divider is one of 1, 10, 100, 1,000, 10,000, 100,000 or 1,000,000." });
    if (!isIntensityIconKey(input.iconKey ?? "")) issues.push({ field: "iconKey", code: "INVALID", message: "The icon must come from the curated set." });
    if (input.unitKind !== undefined && !intensityUnitKinds.includes(input.unitKind)) issues.push({ field: "unitKind", code: "INVALID", message: "A metric counts either a thing (text) or the client's currency." });
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." });
    return issues;
  } },
  "client.intensityMetric.deactivate": { key: "client.intensityMetric.deactivate", label: "Deactivate an intensity metric", permission: "client.edit", reasonRequired: false, transaction: "versioned metric definition (inactive) + audit + outbox + idempotency", auditAction: "client_intensity_metric_deactivated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "clientId", input.clientId);
    required(issues, "metricKey", input.metricKey);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be one or greater." });
    return issues;
  } },
  "client.intensityTarget.set": { key: "client.intensityTarget.set", label: "Set an intensity target", permission: "target.edit", reasonRequired: false, transaction: "versioned intensity target + audit + outbox + idempotency", auditAction: "client_intensity_target_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "clientId", input.clientId);
    required(issues, "metricKey", input.metricKey);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." });
    const year = (value: unknown) => Number.isInteger(value) && (value as number) >= 2000 && (value as number) <= 2100;
    const pct = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
    if (!year(input.baselineYear)) issues.push({ field: "baselineYear", code: "INVALID", message: "The baseline year is a year between 2000 and 2100." });
    if (!(typeof input.baselineIntensity === "number" && Number.isFinite(input.baselineIntensity) && input.baselineIntensity >= 0)) issues.push({ field: "baselineIntensity", code: "INVALID", message: "The baseline intensity is a number, zero or more." });
    for (const [label, yearField, pctField] of [["interim", "interimYear", "interimReductionPct"], ["target", "targetYear", "targetReductionPct"]] as const) {
      const y = input[yearField], p = input[pctField];
      if ((y === null) !== (p === null)) issues.push({ field: yearField, code: "PAIR", message: `The ${label} needs both a year and a reduction, or neither.` });
      else if (y !== null && (!year(y) || !pct(p))) issues.push({ field: yearField, code: "INVALID", message: `The ${label} year is between 2000 and 2100 and its reduction between 0 and 100%.` });
      else if (y !== null && year(input.baselineYear) && (y as number) <= input.baselineYear) issues.push({ field: yearField, code: "AFTER_BASELINE", message: `The ${label} year must come after the ${input.baselineYear} baseline.` });
    }
    if (input.interimYear !== null && input.targetYear !== null && (input.interimYear >= input.targetYear || (input.interimReductionPct ?? 0) > (input.targetReductionPct ?? 0))) {
      issues.push({ field: "interimYear", code: "ORDER", message: "The interim comes before the target, and asks no more than it." });
    }
    if (input.interimYear === null && input.targetYear === null) issues.push({ field: "targetYear", code: "REQUIRED", message: "Set an interim or a final target — a baseline alone is not a target." });
    return issues;
  } },
  "client.intensityTarget.deactivate": { key: "client.intensityTarget.deactivate", label: "Withdraw an intensity target", permission: "target.edit", reasonRequired: true, transaction: "versioned intensity target (inactive) + audit + outbox + idempotency", auditAction: "client_intensity_target_deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "clientId", input.clientId);
    required(issues, "metricKey", input.metricKey);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be one or greater." });
    return issues;
  } },
  "job.intensityValue.set": { key: "job.intensityValue.set", label: "Record an annual metric value", permission: "scoperow.edit", reasonRequired: false, transaction: "versioned annual value + audit + outbox + idempotency", auditAction: "job_intensity_value_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    required(issues, "metricKey", input.metricKey);
    if (!Number.isInteger(input.reportingYear) || input.reportingYear < 2000 || input.reportingYear > 2100) issues.push({ field: "reportingYear", code: "INVALID", message: "Reporting year is between 2000 and 2100." });
    // Null clears the value; a recorded one cannot be negative, and zero cannot be divided by.
    if (input.value !== null && !(typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0)) issues.push({ field: "value", code: "INVALID", message: "A recorded value is zero or greater." });
    if (input.periodKey != null && input.periodKey !== "year" && !/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(input.periodKey)) issues.push({ field: "periodKey", code: "INVALID", message: "A period is 'year', a month (2024-03) or a quarter (2024-Q1)." });
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." });
    return issues;
  } },
  // The catalogue is reference data, so it sits with `admin.lookups` — a consultant
  // assembles a plan from it but does not get to redefine the library while doing so.
  "strategy.library.upsert": { key: "strategy.library.upsert", label: "Add or edit a catalogue lever", permission: "admin.lookups", reasonRequired: false, transaction: "versioned catalogue lever + audit + outbox + idempotency", auditAction: "reduction_strategy_upserted", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "key", input.key);
    required(issues, "title", input.title);
    required(issues, "iconKey", input.iconKey);
    if (!oneOf(input.scope, strategyScopes)) issues.push({ field: "scope", code: "INVALID", message: "Scope must be 1, 2, 3 or governance." });
    if (!oneOf(input.controlLevel, strategyControlLevels)) issues.push({ field: "controlLevel", code: "INVALID", message: "Choose how much of this the client controls." });
    // Editing an existing lever is versioned; creating one has nothing to conflict with.
    if (input.strategyId !== undefined && !positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "strategy.library.deactivate": { key: "strategy.library.deactivate", label: "Withdraw a catalogue lever", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "reduction_strategy_deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "strategyId", input.strategyId);
    // Withdrawing a lever changes what every consultant can reach, so it carries a reason.
    required(issues, "reason", input.reason);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // The reference-value engine (admin A2). Lookups are firm configuration, so every change is admin.lookups; a value is
  // deactivated, never deleted (R3), and a deactivation carries a reason (ruled P7).
  "reference.value.create": { key: "reference.value.create", label: "Add a lookup value", permission: "admin.lookups", reasonRequired: false, transaction: "reference value + audit + outbox + idempotency", auditAction: "reference.value.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    lookupIssues(issues, input);
    // TIME Addendum: an activity is created with its billable default — never defaultless.
    if (input.categoryKey === TIME_ACTIVITY_CATEGORY && typeof input.billableDefault !== "boolean") issues.push({ field: "billableDefault", code: "REQUIRED", message: "Say whether time logged as this activity is billable by default." });
    if (input.categoryKey !== TIME_ACTIVITY_CATEGORY && input.billableDefault !== undefined) issues.push({ field: "billableDefault", code: "NOT_APPLICABLE", message: "Only an activity type carries a billable default." });
    return issues;
  } },
  "reference.value.update": { key: "reference.value.update", label: "Edit a lookup value", permission: "admin.lookups", reasonRequired: false, transaction: "versioned reference value + audit + outbox + idempotency", auditAction: "reference.value.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    lookupIssues(issues, input);
    required(issues, "valueId", input.valueId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (input.billableDefault !== undefined && (input.categoryKey !== TIME_ACTIVITY_CATEGORY || typeof input.billableDefault !== "boolean")) issues.push({ field: "billableDefault", code: "NOT_APPLICABLE", message: "Only an activity type carries a billable default, as true or false." });
    return issues;
  } },
  // ── Time (TIME module; T-Q3, T-Q5–T-Q7) ─────────────────────────────────────────────────────────────────────
  "time.entry.log": { key: "time.entry.log", label: "Log time", permission: "time.log", reasonRequired: false, transaction: "time entry + audit + outbox + idempotency", auditAction: "time.entry.logged", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    timeEntryIssues(issues, input);
    if (input.billable !== undefined && typeof input.billable !== "boolean") issues.push({ field: "billable", code: "INVALID", message: "Billable is yes or no." });
    return issues;
  } },
  "time.entry.edit": { key: "time.entry.edit", label: "Edit a time entry", permission: "time.log", reasonRequired: false, transaction: "versioned time entry + audit + outbox + idempotency", auditAction: "time.entry.edited", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "entryId", input.entryId); required(issues, "jobId", input.jobId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    timeEntryIssues(issues, input);
    if (typeof input.billable !== "boolean") issues.push({ field: "billable", code: "INVALID", message: "Billable is yes or no." });
    return issues;
  } },
  "time.entry.void": { key: "time.entry.void", label: "Void a time entry", permission: "time.log", reasonRequired: false, transaction: "time entry voided (never deleted) + audit + outbox + idempotency", auditAction: "time.entry.voided", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "entryId", input.entryId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "time.entry.bill": { key: "time.entry.bill", label: "Mark time billed", permission: "finance.manage", reasonRequired: false, transaction: "time entry billed ref + audit + outbox + idempotency", auditAction: "time.entry.billed", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "entryId", input.entryId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (input.billedRef !== null && (typeof input.billedRef !== "string" || !input.billedRef.trim() || input.billedRef.trim().length > 120)) issues.push({ field: "billedRef", code: "INVALID", message: "The invoice reference, up to 120 characters — or none, to unbill." });
    return issues;
  } },
  // ── Time PR B: the figures the reads compare against ─────────────────────────────────────────────────────────
  "staff.capacity.set": { key: "staff.capacity.set", label: "Set weekly capacity", permission: "admin.users", reasonRequired: false, transaction: "versioned membership capacity + audit + outbox + idempotency", auditAction: "staff.capacity.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "userId", input.userId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (!isTimeQuantity(input.weeklyCapacityHours, TIME_CAPACITY_MAX_HOURS) || input.weeklyCapacityHours <= 0) issues.push({ field: "weeklyCapacityHours", code: "INVALID", message: `Weekly capacity is more than 0 and at most ${TIME_CAPACITY_MAX_HOURS} hours, to two decimal places.` });
    return issues;
  } },
  "job.budget.set": { key: "job.budget.set", label: "Set a job's budgeted hours", permission: "job.manage", reasonRequired: false, transaction: "versioned job budget + audit + outbox + idempotency", auditAction: "job.budget.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (input.budgetedHours !== null && !isTimeQuantity(input.budgetedHours, JOB_BUDGET_MAX_HOURS)) issues.push({ field: "budgetedHours", code: "INVALID", message: "Budgeted hours are 0 or more, to two decimal places — or none, to clear the budget." });
    return issues;
  } },
  "job.fee.set": { key: "job.fee.set", label: "Set a job's fee", permission: "finance.manage", reasonRequired: false, transaction: "versioned job fee (amount never in the payload) + audit + outbox + idempotency", auditAction: "job.fee.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobId", input.jobId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (input.feeAmount !== null && !isTimeQuantity(input.feeAmount, JOB_FEE_MAX)) issues.push({ field: "feeAmount", code: "INVALID", message: "The fee is 0 or more, to the penny — or none, to clear it." });
    return issues;
  } },
  "reference.value.deactivate": { key: "reference.value.deactivate", label: "Deactivate a lookup value", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "reference.value.deactivated", validate: (input, context) => {
    // Deactivating takes a value out of every picker, so it says why (ruled P7).
    const issues = baseIssues(context, true);
    if (!isLookupCategory(input.categoryKey)) issues.push({ field: "categoryKey", code: "INVALID", message: "That is not a lookup managed here." });
    required(issues, "valueId", input.valueId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "reference.value.reinstate": { key: "reference.value.reinstate", label: "Reinstate a lookup value", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "reference.value.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (!isLookupCategory(input.categoryKey)) issues.push({ field: "categoryKey", code: "INVALID", message: "That is not a lookup managed here." });
    required(issues, "valueId", input.valueId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // Job types (admin C1). Firm configuration like the lookups, so admin.lookups (the design's chip); deactivated, never
  // deleted (R3), and a deactivation says why, as a lookup's does.
  "job_type.create": { key: "job_type.create", label: "Add a job type", permission: "admin.lookups", reasonRequired: false, transaction: "job type + audit + outbox + idempotency", auditAction: "job_type.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    jobTypeIssues(issues, input);
    return issues;
  } },
  "job_type.update": { key: "job_type.update", label: "Edit a job type", permission: "admin.lookups", reasonRequired: false, transaction: "versioned job type + audit + outbox + idempotency", auditAction: "job_type.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    jobTypeIssues(issues, input);
    required(issues, "jobTypeId", input.jobTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "job_type.deactivate": { key: "job_type.deactivate", label: "Deactivate a job type", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "job_type.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "jobTypeId", input.jobTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "job_type.reinstate": { key: "job_type.reinstate", label: "Reinstate a job type", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "job_type.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobTypeId", input.jobTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // Milestone templates (admin C2). Templates are admin.templates (the design's chip). Moving the default and
  // deactivating each change what new jobs are scheduled from, so each says why (ruled plan, §3).
  "milestone_template.create": { key: "milestone_template.create", label: "Add a milestone template", permission: "admin.templates", reasonRequired: false, transaction: "template + its items + audit + outbox + idempotency", auditAction: "milestone_template.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    milestoneTemplateIssues(issues, input);
    return issues;
  } },
  "milestone_template.update": { key: "milestone_template.update", label: "Edit a milestone template", permission: "admin.templates", reasonRequired: false, transaction: "versioned template + its items + audit + outbox + idempotency", auditAction: "milestone_template.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    milestoneTemplateIssues(issues, input);
    required(issues, "templateId", input.templateId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "milestone_template.set_default": { key: "milestone_template.set_default", label: "Make a template the default", permission: "admin.templates", reasonRequired: true, transaction: "default moved atomically + audit + outbox + idempotency", auditAction: "milestone_template.default_set", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "templateId", input.templateId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "milestone_template.deactivate": { key: "milestone_template.deactivate", label: "Deactivate a milestone template", permission: "admin.templates", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "milestone_template.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "templateId", input.templateId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "milestone_template.reinstate": { key: "milestone_template.reinstate", label: "Reinstate a milestone template", permission: "admin.templates", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "milestone_template.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "templateId", input.templateId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // Job file types (admin C3). Firm configuration, so admin.lookups (the design's chip). The key is set at create and is
  // never an update field; a deactivation says why, as a lookup's does.
  "job_file_type.create": { key: "job_file_type.create", label: "Add a job file type", permission: "admin.lookups", reasonRequired: false, transaction: "file type + audit + outbox + idempotency", auditAction: "job_file_type.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (typeof input.fileTypeKey !== "string" || !FILE_TYPE_KEY_PATTERN.test(input.fileTypeKey.trim())) issues.push({ field: "fileTypeKey", code: "INVALID", message: "A key is lower-case letters, digits and underscores, starting with a letter (2–41 characters). It can never be changed." });
    fileTypeIssues(issues, input);
    return issues;
  } },
  "job_file_type.update": { key: "job_file_type.update", label: "Edit a job file type", permission: "admin.lookups", reasonRequired: false, transaction: "versioned file type + audit + outbox + idempotency", auditAction: "job_file_type.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    fileTypeIssues(issues, input);
    required(issues, "fileTypeId", input.fileTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "job_file_type.deactivate": { key: "job_file_type.deactivate", label: "Deactivate a job file type", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "job_file_type.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "fileTypeId", input.fileTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "job_file_type.reinstate": { key: "job_file_type.reinstate", label: "Reinstate a job file type", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "job_file_type.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "fileTypeId", input.fileTypeId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // Commercial lookups (admin Phase E1). admin.lookups; a deactivation needs a reason, and so does moving the default.
  "vat.create": { key: "vat.create", label: "Add a VAT rate", permission: "admin.lookups", reasonRequired: false, transaction: "VAT rate + audit + outbox + idempotency", auditAction: "vat.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    vatRateIssues(issues, input);
    return issues;
  } },
  "vat.update": { key: "vat.update", label: "Edit a VAT rate", permission: "admin.lookups", reasonRequired: false, transaction: "versioned VAT rate + audit + outbox + idempotency", auditAction: "vat.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    vatRateIssues(issues, input);
    vatIdIssues(issues, input);
    return issues;
  } },
  "vat.set_default": { key: "vat.set_default", label: "Make a VAT rate the default", permission: "admin.lookups", reasonRequired: true, transaction: "default moved (one per organisation) + audit + outbox + idempotency", auditAction: "vat.default_set", validate: (input, context) => {
    const issues = baseIssues(context, true);
    vatIdIssues(issues, input);
    return issues;
  } },
  "vat.deactivate": { key: "vat.deactivate", label: "Deactivate a VAT rate", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "vat.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    vatIdIssues(issues, input);
    return issues;
  } },
  "vat.reinstate": { key: "vat.reinstate", label: "Reinstate a VAT rate", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "vat.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    vatIdIssues(issues, input);
    return issues;
  } },
  "currency.create": { key: "currency.create", label: "Add a currency", permission: "admin.lookups", reasonRequired: false, transaction: "currency + audit + outbox + idempotency", auditAction: "currency.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    currencyCodeIssue(issues, input.code);
    currencyIssues(issues, input);
    return issues;
  } },
  "currency.update": { key: "currency.update", label: "Edit a currency", permission: "admin.lookups", reasonRequired: false, transaction: "versioned currency + audit + outbox + idempotency", auditAction: "currency.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    currencyIssues(issues, input);
    currencyIdIssues(issues, input);
    return issues;
  } },
  "currency.set_default": { key: "currency.set_default", label: "Make a currency the default", permission: "admin.lookups", reasonRequired: true, transaction: "default moved (one per organisation) + audit + outbox + idempotency", auditAction: "currency.default_set", validate: (input, context) => {
    const issues = baseIssues(context, true);
    currencyIdIssues(issues, input);
    return issues;
  } },
  "currency.deactivate": { key: "currency.deactivate", label: "Deactivate a currency", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "currency.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    currencyIdIssues(issues, input);
    return issues;
  } },
  "currency.reinstate": { key: "currency.reinstate", label: "Reinstate a currency", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "currency.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    currencyIdIssues(issues, input);
    return issues;
  } },
  // The service catalogue (admin Phase E2). The definition under admin.lookups; the amounts under finance.manage, and
  // never in the audit's values (E-Q8, NZC-120).
  "job_item.create": { key: "job_item.create", label: "Add a catalogue item", permission: "admin.lookups", reasonRequired: false, transaction: "catalogue item + audit + outbox + idempotency", auditAction: "job_item.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (typeof input.itemCode !== "string" || !JOB_ITEM_CODE_PATTERN.test(input.itemCode)) issues.push({ field: "itemCode", code: "INVALID", message: "A code is upper-case letters, digits, - and _ (up to 30), e.g. ASSESS. It can never be changed." });
    jobItemIssues(issues, input);
    return issues;
  } },
  "job_item.update": { key: "job_item.update", label: "Edit a catalogue item", permission: "admin.lookups", reasonRequired: false, transaction: "versioned catalogue item + audit + outbox + idempotency", auditAction: "job_item.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    jobItemIssues(issues, input);
    jobItemIdIssues(issues, input);
    return issues;
  } },
  "job_item.deactivate": { key: "job_item.deactivate", label: "Deactivate a catalogue item", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "job_item.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    jobItemIdIssues(issues, input);
    return issues;
  } },
  "job_item.reinstate": { key: "job_item.reinstate", label: "Reinstate a catalogue item", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "job_item.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    jobItemIdIssues(issues, input);
    return issues;
  } },
  "job_item.price.set": { key: "job_item.price.set", label: "Set a catalogue item's cost and sell price", permission: "finance.manage", reasonRequired: false, transaction: "versioned amounts + audit (which, never what) + outbox + idempotency", auditAction: "job_item.price_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    jobItemIdIssues(issues, input);
    for (const field of ["defaultCostAmount", "defaultSellAmount"] as const) {
      const value = input[field];
      if (value !== null && !isCatalogueAmount(value, JOB_ITEM_AMOUNT_MAX)) issues.push({ field, code: "INVALID", message: "An amount is a number from 0, to two places — or blank, not yet priced." });
    }
    return issues;
  } },
  // Job-type templates (admin Phase E3). admin.lookups; the template's own version, apart from the type's definition.
  "job_type.items.set": { key: "job_type.items.set", label: "Set a job type's included items", permission: "admin.lookups", reasonRequired: false, transaction: "versioned template (never deleted: dropped items kept as not included) + audit + outbox + idempotency", auditAction: "job_type.items_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "jobTypeId", input.jobTypeId);
    if (!positive(input.expectedItemsVersion)) issues.push({ field: "expectedItemsVersion", code: "INVALID", message: "Expected template version must be positive." });
    if (!Array.isArray(input.items)) { issues.push({ field: "items", code: "INVALID", message: "The included items are a list." }); return issues; }
    if (input.items.length > JOB_TYPE_ITEMS_MAX) issues.push({ field: "items", code: "TOO_MANY", message: `A template includes at most ${JOB_TYPE_ITEMS_MAX} items.` });
    const seen = new Set<string>();
    input.items.forEach((item, index) => {
      if (!item || !text(item.itemId)) { issues.push({ field: `items.${index}.itemId`, code: "REQUIRED", message: "Each included item names a catalogue item." }); return; }
      if (seen.has(item.itemId)) issues.push({ field: `items.${index}.itemId`, code: "DUPLICATE", message: "An item is included once; set its quantity instead." });
      seen.add(item.itemId);
      if (!isTemplateQuantity(item.quantity)) issues.push({ field: `items.${index}.quantity`, code: "INVALID", message: "A quantity is above 0, to two places." });
      if (typeof item.isRequired !== "boolean") issues.push({ field: `items.${index}.isRequired`, code: "INVALID", message: "Say whether the item is required." });
    });
    return issues;
  } },
  // Suppliers and their rate card (admin Phase E4). admin.lookups, except the agreed rate (finance.manage, E-Q8). A
  // contact's details are sealed (E-Q6), and no result — so no audit value — ever carries them or the rate.
  "supplier.create": { key: "supplier.create", label: "Add a supplier", permission: "admin.lookups", reasonRequired: false, transaction: "supplier + audit + outbox + idempotency", auditAction: "supplier.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    supplierIssues(issues, input);
    return issues;
  } },
  "supplier.update": { key: "supplier.update", label: "Edit a supplier", permission: "admin.lookups", reasonRequired: false, transaction: "versioned supplier + audit + outbox + idempotency", auditAction: "supplier.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    supplierIssues(issues, input);
    versioned(issues, "supplierId", input.supplierId, input.expectedVersion);
    return issues;
  } },
  "supplier.deactivate": { key: "supplier.deactivate", label: "Deactivate a supplier", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "supplier.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    versioned(issues, "supplierId", input.supplierId, input.expectedVersion);
    return issues;
  } },
  "supplier.reinstate": { key: "supplier.reinstate", label: "Reinstate a supplier", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "supplier.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    versioned(issues, "supplierId", input.supplierId, input.expectedVersion);
    return issues;
  } },
  "supplier.contact.add": { key: "supplier.contact.add", label: "Add a supplier contact", permission: "admin.lookups", reasonRequired: false, transaction: "contact (sealed) + audit (which fields, never what) + outbox + idempotency", auditAction: "supplier.contact_added", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "supplierId", input.supplierId);
    supplierContactIssues(issues, input);
    return issues;
  } },
  "supplier.contact.update": { key: "supplier.contact.update", label: "Edit a supplier contact", permission: "admin.lookups", reasonRequired: false, transaction: "versioned contact (sealed) + audit (which fields, never what) + outbox + idempotency", auditAction: "supplier.contact_updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    supplierContactIssues(issues, input);
    versioned(issues, "contactId", input.contactId, input.expectedVersion);
    return issues;
  } },
  "supplier.contact.deactivate": { key: "supplier.contact.deactivate", label: "Deactivate a supplier contact", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "supplier.contact_deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    versioned(issues, "contactId", input.contactId, input.expectedVersion);
    return issues;
  } },
  "supplier.contact.reinstate": { key: "supplier.contact.reinstate", label: "Reinstate a supplier contact", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "supplier.contact_reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    versioned(issues, "contactId", input.contactId, input.expectedVersion);
    return issues;
  } },
  "supplier_item.create": { key: "supplier_item.create", label: "Add a service to a supplier's rate card", permission: "admin.lookups", reasonRequired: false, transaction: "rate-card line + audit + outbox + idempotency", auditAction: "supplier_item.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "supplierId", input.supplierId);
    supplierItemIssues(issues, input);
    return issues;
  } },
  "supplier_item.update": { key: "supplier_item.update", label: "Edit a rate-card service", permission: "admin.lookups", reasonRequired: false, transaction: "versioned rate-card line + audit + outbox + idempotency", auditAction: "supplier_item.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    supplierItemIssues(issues, input);
    versioned(issues, "serviceItemId", input.serviceItemId, input.expectedVersion);
    return issues;
  } },
  "supplier_item.deactivate": { key: "supplier_item.deactivate", label: "Deactivate a rate-card service", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "supplier_item.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    versioned(issues, "serviceItemId", input.serviceItemId, input.expectedVersion);
    return issues;
  } },
  "supplier_item.reinstate": { key: "supplier_item.reinstate", label: "Reinstate a rate-card service", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "supplier_item.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    versioned(issues, "serviceItemId", input.serviceItemId, input.expectedVersion);
    return issues;
  } },
  "supplier_item.rate.set": { key: "supplier_item.rate.set", label: "Set a rate-card service's agreed rate", permission: "finance.manage", reasonRequired: false, transaction: "versioned rate + audit (that, never what) + outbox + idempotency", auditAction: "supplier_item.rate_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    versioned(issues, "serviceItemId", input.serviceItemId, input.expectedVersion);
    if (input.agreedRate !== null && !isAgreedRate(input.agreedRate)) issues.push({ field: "agreedRate", code: "INVALID", message: "A rate is a number from 0, to two places — or blank, not yet agreed." });
    return issues;
  } },
  // Message templates (admin Phase F1). admin.templates; the key from the registry, set once; content versioned and audited.
  "message_template.create": { key: "message_template.create", label: "Word a message in the organisation's own terms", permission: "admin.templates", reasonRequired: false, transaction: "template + audit + outbox + idempotency", auditAction: "message_template.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    messageTemplateKeyIssues(issues, input.templateKey);
    messageTemplateContentIssues(issues, input);
    return issues;
  } },
  "message_template.update": { key: "message_template.update", label: "Edit a message template", permission: "admin.templates", reasonRequired: false, transaction: "versioned template + audit + outbox + idempotency", auditAction: "message_template.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    messageTemplateKeyIssues(issues, input.templateKey);
    messageTemplateContentIssues(issues, input);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "message_template.deactivate": { key: "message_template.deactivate", label: "Go back to a message's built-in wording", permission: "admin.templates", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "message_template.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    messageTemplateKeyIssues(issues, input.templateKey);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "message_template.reinstate": { key: "message_template.reinstate", label: "Use a message template again", permission: "admin.templates", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "message_template.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    messageTemplateKeyIssues(issues, input.templateKey);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // The BD funnel (admin Phase F2). admin.lookups; the key set once; the last active stage stays.
  "bd_stage.create": { key: "bd_stage.create", label: "Add a funnel stage", permission: "admin.lookups", reasonRequired: false, transaction: "funnel stage + audit + outbox + idempotency", auditAction: "bd_stage.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (typeof input.stageKey !== "string" || !BD_STAGE_KEY_PATTERN.test(input.stageKey)) issues.push({ field: "stageKey", code: "INVALID", message: "A key is lower-case letters, digits and - (up to 40), e.g. qualified. It can never be changed." });
    bdStageIssues(issues, input);
    return issues;
  } },
  "bd_stage.update": { key: "bd_stage.update", label: "Edit a funnel stage", permission: "admin.lookups", reasonRequired: false, transaction: "versioned funnel stage + audit + outbox + idempotency", auditAction: "bd_stage.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    bdStageIssues(issues, input);
    bdStageIdIssues(issues, input);
    return issues;
  } },
  "bd_stage.deactivate": { key: "bd_stage.deactivate", label: "Deactivate a funnel stage", permission: "admin.lookups", reasonRequired: true, transaction: "deactivation (never deletion; never the last active stage) + audit + outbox + idempotency", auditAction: "bd_stage.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    bdStageIdIssues(issues, input);
    return issues;
  } },
  "bd_stage.reinstate": { key: "bd_stage.reinstate", label: "Reinstate a funnel stage", permission: "admin.lookups", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "bd_stage.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    bdStageIdIssues(issues, input);
    return issues;
  } },
  // Custom field definitions (admin Phase F3). admin.settings (F-Q5); the values are each entity's workstream's.
  "custom_field.create": { key: "custom_field.create", label: "Add a custom field", permission: "admin.settings", reasonRequired: false, transaction: "definition + audit + outbox + idempotency", auditAction: "custom_field.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (!isCustomFieldEntityType(input.entityType)) issues.push({ field: "entityType", code: "INVALID", message: "Choose what the field belongs to: a client, job, contact, quote or supplier." });
    if (typeof input.fieldKey !== "string" || !CUSTOM_FIELD_KEY_PATTERN.test(input.fieldKey)) issues.push({ field: "fieldKey", code: "INVALID", message: "A key is lower-case letters, digits, _ and -, starting with a letter (up to 64). It can never be changed." });
    if (!isCustomFieldType(input.fieldType)) issues.push({ field: "fieldType", code: "INVALID", message: "Choose a field type." });
    customFieldIssues(issues, input, isCustomFieldType(input.fieldType) ? input.fieldType : null);
    return issues;
  } },
  "custom_field.update": { key: "custom_field.update", label: "Edit a custom field", permission: "admin.settings", reasonRequired: false, transaction: "versioned definition (options never removed) + audit + outbox + idempotency", auditAction: "custom_field.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    // The type is the held one, checked against the options and default by the command once it has read it.
    customFieldIssues(issues, input, null);
    customFieldIdIssues(issues, input);
    return issues;
  } },
  "custom_field.deactivate": { key: "custom_field.deactivate", label: "Deactivate a custom field", permission: "admin.settings", reasonRequired: true, transaction: "deactivation (never deletion; values kept) + audit + outbox + idempotency", auditAction: "custom_field.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    customFieldIdIssues(issues, input);
    return issues;
  } },
  "custom_field.reinstate": { key: "custom_field.reinstate", label: "Reinstate a custom field", permission: "admin.settings", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "custom_field.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    customFieldIdIssues(issues, input);
    return issues;
  } },
  // Portal broadcasts (admin Phase F4). admin.settings (R7); deactivating says why; never deleted.
  "portal_broadcast.create": { key: "portal_broadcast.create", label: "Write a portal broadcast", permission: "admin.settings", reasonRequired: false, transaction: "broadcast + audit + outbox + idempotency", auditAction: "portal_broadcast.created", validate: (input, context) => {
    const issues = baseIssues(context, false);
    portalBroadcastIssues(issues, input);
    return issues;
  } },
  "portal_broadcast.update": { key: "portal_broadcast.update", label: "Edit a portal broadcast", permission: "admin.settings", reasonRequired: false, transaction: "versioned broadcast + audit + outbox + idempotency", auditAction: "portal_broadcast.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    portalBroadcastIssues(issues, input);
    portalBroadcastIdIssues(issues, input);
    return issues;
  } },
  "portal_broadcast.deactivate": { key: "portal_broadcast.deactivate", label: "Take a portal broadcast down", permission: "admin.settings", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "portal_broadcast.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    portalBroadcastIdIssues(issues, input);
    return issues;
  } },
  "portal_broadcast.reinstate": { key: "portal_broadcast.reinstate", label: "Put a portal broadcast back up", permission: "admin.settings", reasonRequired: false, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "portal_broadcast.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    portalBroadcastIdIssues(issues, input);
    return issues;
  } },
  // Team & access (admin Phase B, B1; ruled phaseB-team-access-plan.md). admin.users throughout, except rates, which
  // are finance.manage (R9 (c): finance.view also reaches Consultant). A role change, a deactivation and a reinstatement
  // each say why. The guards that need the roster — the last active admin, and changing yourself — are the command's.
  "staff.add": { key: "staff.add", label: "Add a member of staff", permission: "admin.users", reasonRequired: false, transaction: "membership (sealed) + audit + outbox + idempotency", auditAction: "staff.added", validate: (input, context) => {
    const issues = baseIssues(context, false);
    staffNameIssues(issues, input.displayName);
    if (!isWorkEmail(input.email)) issues.push({ field: "email", code: "INVALID", message: "Enter a work email address." });
    if (input.positionValueId !== undefined && input.positionValueId !== null && !text(input.positionValueId)) issues.push({ field: "positionValueId", code: "INVALID", message: "Choose a position, or none." });
    return issues;
  } },
  "staff.update": { key: "staff.update", label: "Edit a member of staff", permission: "admin.users", reasonRequired: false, transaction: "versioned membership (sealed) + audit + outbox + idempotency", auditAction: "staff.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "userId", input.userId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    staffNameIssues(issues, input.displayName);
    if (input.positionValueId !== undefined && input.positionValueId !== null && !text(input.positionValueId)) issues.push({ field: "positionValueId", code: "INVALID", message: "Choose a position, or none." });
    return issues;
  } },
  // Audited as staff.role.assign, the action the operator command has always written, so a person's role history reads
  // as one series whichever path made the change.
  "staff.role.assign": { key: "staff.role.assign", label: "Change a member's role", permission: "admin.users", reasonRequired: true, transaction: "versioned membership + last-admin check + audit + outbox + idempotency", auditAction: "staff.role.assign", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "userId", input.userId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (!oneOf(input.role, staffRoles)) issues.push({ field: "role", code: "INVALID", message: "Choose one of the five roles." });
    return issues;
  } },
  "staff.deactivate": { key: "staff.deactivate", label: "Deactivate a member of staff", permission: "admin.users", reasonRequired: true, transaction: "deactivation (never deletion) + last-admin check + audit + outbox + idempotency", auditAction: "staff.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "userId", input.userId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "staff.reinstate": { key: "staff.reinstate", label: "Reinstate a member of staff", permission: "admin.users", reasonRequired: true, transaction: "reinstatement + audit + outbox + idempotency", auditAction: "staff.reinstated", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "userId", input.userId);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  // A correction needs a reason; a rate from a new date does not. Neither is ever an edit in place.
  "staff.rate.set": { key: "staff.rate.set", label: "Set a staff rate", permission: "finance.manage", reasonRequired: false, transaction: "append-only rate row + audit + outbox + idempotency", auditAction: "staff.rate.set", validate: (input, context) => {
    const correcting = input.supersedesRateId !== undefined && input.supersedesRateId !== null;
    const issues = baseIssues(context, correcting);
    required(issues, "userId", input.userId);
    if (!isCalendarDay(input.effectiveFrom)) issues.push({ field: "effectiveFrom", code: "INVALID", message: "The date the rate applies from." });
    for (const field of ["costPerHour", "sellPerHour"] as const) {
      const value = input[field];
      if (value !== undefined && value !== null && !isTwoDecimalAmount(value, STAFF_RATE_MAX)) issues.push({ field, code: "INVALID", message: "An hourly amount from 0, to two decimal places." });
    }
    if ((input.costPerHour ?? null) === null && (input.sellPerHour ?? null) === null) issues.push({ field: "costPerHour", code: "REQUIRED", message: "Give a cost rate, a sell rate, or both." });
    if (input.currency !== undefined && !isCurrencyCode(input.currency)) issues.push({ field: "currency", code: "INVALID", message: "A three-letter currency code, e.g. GBP." });
    if (correcting && !text(input.supersedesRateId)) issues.push({ field: "supersedesRateId", code: "INVALID", message: "Name the rate being corrected." });
    return issues;
  } },
  // Organisation settings (admin Phase D, D1; ruled phaseD-org-settings-plan.md). admin.settings throughout (Admin, matrix
  // v8). The bank details are their own command, and always say why (Q2); applying the intensity defaults to existing
  // clients does too (Q5).
  "organisation.profile.update": { key: "organisation.profile.update", label: "Edit the organisation profile", permission: "admin.settings", reasonRequired: false, transaction: "versioned profile + audit + outbox + idempotency", auditAction: "organisation.profile.updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    for (const key of ORGANISATION_PROFILE_FIELDS) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== null && typeof value !== "string") issues.push({ field: key, code: "INVALID", message: "Text, or empty." });
    }
    if (issues.length === 0) issues.push(...profileIssues(normaliseProfile(input)));
    return issues;
  } },
  "organisation.logo.set": { key: "organisation.logo.set", label: "Upload the organisation logo", permission: "admin.settings", reasonRequired: false, transaction: "logo asset + profile pointer + audit + outbox + idempotency", auditAction: "organisation.logo.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "fileName", input.fileName);
    if (!oneOf(input.contentType, organisationLogoContentTypes)) issues.push({ field: "contentType", code: "INVALID", message: "The logo must be a PNG or SVG." });
    if (!text(input.dataBase64) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64)) issues.push({ field: "dataBase64", code: "INVALID", message: "The logo file could not be read." });
    else if (Math.floor(input.dataBase64.length * 3 / 4) > CLIENT_LOGO_MAX_BYTES) issues.push({ field: "dataBase64", code: "TOO_LARGE", message: `The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.` });
    return issues;
  } },
  "organisation.logo.remove": { key: "organisation.logo.remove", label: "Remove the organisation logo", permission: "admin.settings", reasonRequired: false, transaction: "profile pointer cleared (asset retained) + audit + outbox + idempotency", auditAction: "organisation.logo.removed", validate: (_input, context) => baseIssues(context, false) },
  "organisation.bank.set": { key: "organisation.bank.set", label: "Set the organisation's bank details", permission: "admin.settings", reasonRequired: true, transaction: "versioned bank details + audit (no values) + outbox + idempotency", auditAction: "organisation.bank.set", validate: (input, context) => {
    const issues = baseIssues(context, true);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    for (const key of ORGANISATION_BANK_FIELDS) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== null && typeof value !== "string") issues.push({ field: key, code: "INVALID", message: "Text, or empty." });
    }
    if (issues.length === 0) issues.push(...bankIssues(normaliseBank(input)));
    return issues;
  } },
  "organisation.intensityDefault.set": { key: "organisation.intensityDefault.set", label: "Define a default intensity metric", permission: "admin.settings", reasonRequired: false, transaction: "versioned default definition + audit + outbox + idempotency", auditAction: "organisation.intensity_default.set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "label", input.label);
    required(issues, "unitWording", input.unitWording);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.metricKey ?? "")) issues.push({ field: "metricKey", code: "INVALID", message: "A metric key is lower-case letters, digits, dashes or underscores." });
    if (!intensityDividers.includes(input.divider as IntensityDivider)) issues.push({ field: "divider", code: "INVALID", message: "The divider is one of 1, 10, 100, 1,000, 10,000, 100,000 or 1,000,000." });
    if (!isIntensityIconKey(input.iconKey ?? "")) issues.push({ field: "iconKey", code: "INVALID", message: "The icon must come from the curated set." });
    if (input.unitKind !== undefined && !intensityUnitKinds.includes(input.unitKind)) issues.push({ field: "unitKind", code: "INVALID", message: "A metric counts either a thing (text) or the client's currency." });
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." });
    return issues;
  } },
  "organisation.intensityDefault.deactivate": { key: "organisation.intensityDefault.deactivate", label: "Deactivate a default intensity metric", permission: "admin.settings", reasonRequired: false, transaction: "versioned default definition (inactive) + audit + outbox + idempotency", auditAction: "organisation.intensity_default.deactivated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "metricKey", input.metricKey);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "organisation.intensityDefaults.apply": { key: "organisation.intensityDefaults.apply", label: "Apply the intensity defaults to clients with none", permission: "admin.settings", reasonRequired: true, transaction: "defaults onto every client without a metric + one audit + outbox + idempotency", auditAction: "organisation.intensity_defaults.applied", validate: (input, context) => {
    const issues = baseIssues(context, true);
    if (!Number.isInteger(input.expectedClients) || input.expectedClients < 1) issues.push({ field: "expectedClients", code: "INVALID", message: "Confirm how many clients this applies to." });
    return issues;
  } },
  "client.strategy.assign": { key: "client.strategy.assign", label: "Add a strategy to the plan", permission: "strategy.manage", reasonRequired: false, transaction: "client action + audit + outbox + idempotency", auditAction: "client_strategy_assigned", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "clientId", input.clientId);
    // Every strategy on a plan advances something the client has to disclose. The database
    // holds this too, as a deferred constraint trigger; saying it here means the drawer can
    // refuse before the round trip rather than surfacing a constraint name.
    if (!Array.isArray(input.srsRequirementIds) || input.srsRequirementIds.length === 0) {
      issues.push({ field: "srsRequirementIds", code: "REQUIRED", message: "Align this strategy to at least one UK SRS requirement." });
    }
    // Exactly one of the two shapes: from the catalogue, or standing on its own.
    const fromCatalogue = typeof input.strategyId === "string" && input.strategyId.trim() !== "";
    const bespoke = input.bespoke;
    if (fromCatalogue === Boolean(bespoke)) {
      issues.push({ field: "strategyId", code: "INVALID", message: "Add either a catalogue lever or a bespoke action, not both." });
    } else if (bespoke) {
      required(issues, "bespoke.title", bespoke.title);
      if (!oneOf(bespoke.scope, strategyScopes)) issues.push({ field: "bespoke.scope", code: "INVALID", message: "Scope must be 1, 2, 3 or governance." });
      if (!oneOf(bespoke.controlLevel, strategyControlLevels)) issues.push({ field: "bespoke.controlLevel", code: "INVALID", message: "Choose how much of this the client controls." });
    }
    if (input.targetDate !== undefined && input.targetDate !== null && !isoDate(input.targetDate)) {
      issues.push({ field: "targetDate", code: "INVALID", message: "Enter the target date as dd/mm/yyyy." });
    }
    return issues;
  } },
  "client.strategy.update": { key: "client.strategy.update", label: "Update a strategy", permission: "strategy.manage", reasonRequired: false, transaction: "versioned client action + audit + outbox + idempotency", auditAction: "client_strategy_updated", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "clientStrategyId", input.clientStrategyId);
    // The same rule on update: a strategy cannot be edited into having no alignment.
    if (!Array.isArray(input.srsRequirementIds) || input.srsRequirementIds.length === 0) {
      issues.push({ field: "srsRequirementIds", code: "REQUIRED", message: "Align this strategy to at least one UK SRS requirement." });
    }
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    if (!oneOf(input.status, strategyStatuses)) issues.push({ field: "status", code: "INVALID", message: "Status must be planned, in progress or complete." });
    if (!Number.isInteger(input.progressPct) || input.progressPct < 0 || input.progressPct > 100) {
      issues.push({ field: "progressPct", code: "INVALID", message: "Progress must be a whole percentage from 0 to 100." });
    } else if ((input.status === "complete") !== (input.progressPct === 100)) {
      // The same rule the database holds: "done" means one thing, and the form should not
      // be able to offer a combination that will be refused on save.
      issues.push({ field: "progressPct", code: "INCONSISTENT", message: "A complete action is at 100%, and an action at 100% is complete." });
    }
    if (input.targetDate !== undefined && input.targetDate !== null && !isoDate(input.targetDate)) {
      issues.push({ field: "targetDate", code: "INVALID", message: "Enter the target date as dd/mm/yyyy." });
    }
    return issues;
  } },
  // ── Knowledge library (NZC-081) ──
  //
  // Capture is open to every role; approval and publication are the two tiers, and they are
  // separate capabilities because they are separate risks. Nothing here lets the library be
  // written without a person: an AI-drafted answer enters as a draft and needs approval.
  "knowledge.capture": {
    key: "knowledge.capture", label: "Offer an answer to the knowledge library", permission: "knowledge.capture",
    reasonRequired: false,
    transaction: "idempotent draft (reopens an existing one) + version history + audit + outbox + idempotency",
    auditAction: "knowledge_captured",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "question", input.question);
      required(issues, "sourceKey", input.sourceKey);
      // The answer may be empty at capture — someone can record the question and let an
      // approver write the answer. The question cannot: it is the entry's identity.
      return issues;
    },
  },
  "knowledge.alias.add": {
    key: "knowledge.alias.add", label: "Add a phrasing to a library entry", permission: "knowledge.capture",
    reasonRequired: false, transaction: "alias + version history + audit + outbox + idempotency",
    auditAction: "knowledge_alias_added",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "entryId", input.entryId);
      required(issues, "question", input.question);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  "knowledge.edit": {
    key: "knowledge.edit", label: "Edit a library entry", permission: "knowledge.approve",
    reasonRequired: false, transaction: "versioned entry + version history + audit + outbox + idempotency",
    auditAction: "knowledge_edited",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "entryId", input.entryId);
      required(issues, "question", input.question);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  "knowledge.approve": {
    key: "knowledge.approve", label: "Approve for internal use", permission: "knowledge.approve",
    reasonRequired: false, transaction: "status + provenance + version history + audit + outbox + idempotency",
    auditAction: "knowledge_approved",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "entryId", input.entryId);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  // Admin only, by the matrix. The tier is what makes something client-facing, so the
  // capability that crosses it is deliberately narrower than the one that approves.
  "knowledge.publish": {
    key: "knowledge.publish", label: "Publish to the public tier", permission: "knowledge.publish",
    reasonRequired: false, transaction: "status + provenance + version history + audit + outbox + idempotency",
    auditAction: "knowledge_published",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "entryId", input.entryId);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  "knowledge.reject": {
    key: "knowledge.reject", label: "Reject a draft", permission: "knowledge.approve",
    reasonRequired: true, transaction: "deactivation (never deletion) + version history + audit + outbox + idempotency",
    auditAction: "knowledge_rejected",
    validate: (input, context) => {
      const issues = baseIssues(context, true);
      required(issues, "entryId", input.entryId);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  "knowledge.merge": {
    key: "knowledge.merge", label: "Merge a duplicate into an entry", permission: "knowledge.approve",
    reasonRequired: false, transaction: "aliases moved + deactivation + version history + audit + outbox + idempotency",
    auditAction: "knowledge_merged",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "entryId", input.entryId);
      required(issues, "intoEntryId", input.intoEntryId);
      if (input.entryId && input.entryId === input.intoEntryId) {
        issues.push({ field: "intoEntryId", code: "INVALID", message: "An entry cannot be merged into itself." });
      }
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      return issues;
    },
  },
  // Reuses `strategy.manage`: entering an estimate is managing the strategy, and that
  // capability is already held by exactly Admin and Consultant. A new capability with the
  // same holders would be a matrix version that changed nobody's access.
  "client.strategy.estimate.set": {
    key: "client.strategy.estimate.set", label: "Set a strategy's reduction estimate", permission: "strategy.manage",
    reasonRequired: false,
    transaction: "versioned client strategy + audit + outbox + idempotency",
    auditAction: "client_strategy_estimate_set",
    validate: (input, context) => {
      const issues = baseIssues(context, false);
      required(issues, "clientStrategyId", input.clientStrategyId);
      if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
      const estimate = input.estimate;
      if (estimate === null) return issues;
      if (!Number.isFinite(estimate.amount) || estimate.amount < 0) {
        issues.push({ field: "amount", code: "INVALID", message: "A reduction is zero or more — a negative figure is an increase, not a saving." });
      }
      if (!(estimateUnits as readonly string[]).includes(estimate.unit)) {
        issues.push({ field: "unit", code: "INVALID", message: "Enter the reduction in tCO₂e per year, or as a percentage of the baseline scope." });
      }
      if (estimate.unit === "percent" && Number.isFinite(estimate.amount) && estimate.amount > 100) {
        issues.push({ field: "amount", code: "INVALID", message: "A reduction cannot be more than 100% of the scope it applies to." });
      }
      if (!(estimateScopes as readonly string[]).includes(estimate.scope)) {
        issues.push({ field: "scope", code: "INVALID", message: "Say which scope the reduction lands on — a percentage means nothing without it." });
      }
      // The basis is what separates an estimate from an unsourced claim, so it is required
      // in the command as well as in the database.
      required(issues, "assumptions", estimate.assumptions);
      if (!(estimateSources as readonly string[]).includes(estimate.source)) {
        issues.push({ field: "source", code: "INVALID", message: "Record whether this was seeded from the catalogue or entered by a consultant." });
      }
      if (estimate.confidence != null && !(estimateConfidences as readonly string[]).includes(estimate.confidence)) {
        issues.push({ field: "confidence", code: "INVALID", message: "Confidence is low, medium or high." });
      }
      return issues;
    },
  },
  "client.strategy.remove": { key: "client.strategy.remove", label: "Remove an action from the plan", permission: "strategy.manage", reasonRequired: true, transaction: "deactivation (never deletion) + audit + outbox + idempotency", auditAction: "client_strategy_removed", validate: (input, context) => {
    const issues = baseIssues(context, true);
    required(issues, "clientStrategyId", input.clientStrategyId);
    // What a client once intended to do is part of the engagement's history, so dropping
    // it from the plan is a deliberate, reasoned act rather than a tidy-up.
    required(issues, "reason", input.reason);
    if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." });
    return issues;
  } },
  "srs.assessment.start": { key: "srs.assessment.start", label: "Start an SRS readiness assessment", permission: "srs.manage", reasonRequired: false, transaction: "assessment stamped with the active framework version + optional NZI pre-fill + audit + outbox + idempotency", auditAction: "srs_assessment_started", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); if (!isoDate(input.assessedOn)) issues.push({ field: "assessedOn", code: "INVALID", message: "Enter the assessment date as dd/mm/yyyy." }); return issues; } },
  "srs.assessment.item.set": { key: "srs.assessment.item.set", label: "Answer an SRS requirement", permission: "srs.manage", reasonRequired: false, transaction: "assessment item upsert + audit + outbox + idempotency", auditAction: "srs_assessment_item_set", validate: (input, context) => {
    const issues = baseIssues(context, false);
    required(issues, "assessmentId", input.assessmentId);
    required(issues, "requirementId", input.requirementId);
    if (input.maturity !== null && !(Number.isInteger(input.maturity) && input.maturity >= 0 && input.maturity <= 4)) issues.push({ field: "maturity", code: "INVALID", message: "Maturity is a step on the five-point ladder, 0 to 4." });
    if (input.evidenceKind != null && !oneOf(input.evidenceKind, ["document", "data", "note"] as const)) issues.push({ field: "evidenceKind", code: "INVALID", message: "Evidence is a document, a data reference or a note." });
    // Evidence that names nothing is not evidence.
    if (input.evidenceKind != null && !text(input.evidenceRef) && !text(input.evidenceNote)) issues.push({ field: "evidenceNote", code: "REQUIRED", message: "Evidence needs a reference or a note." });
    if (input.dueDate != null && !isoDate(input.dueDate)) issues.push({ field: "dueDate", code: "INVALID", message: "Enter the due date as dd/mm/yyyy." });
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." });
    return issues;
  } },
  "srs.assessment.complete": { key: "srs.assessment.complete", label: "Complete an SRS readiness assessment", permission: "srs.manage", reasonRequired: false, transaction: "assessment status + completion stamp + audit + outbox + idempotency", auditAction: "srs_assessment_completed", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "assessmentId", input.assessmentId); if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." }); return issues; } },
  "client.targets.set": { key: "client.targets.set", label: "Set reduction targets", permission: "target.edit", reasonRequired: false, transaction: "versioned target record + benchmark stamp + audit + outbox + idempotency", auditAction: "client_targets_set", validate: (input, context) => { const issues = [...baseIssues(context, false), ...forwardTargetIssues(input)]; required(issues, "clientId", input.clientId); if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be zero or greater." }); return issues; } },
  "client.logo.set": { key: "client.logo.set", label: "Upload client logo", permission: "client.edit", reasonRequired: false, transaction: "logo asset + client pointer + audit + outbox + idempotency", auditAction: "client_logo_set", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "fileName", input.fileName); if (!oneOf(input.contentType, clientLogoContentTypes)) issues.push({ field: "contentType", code: "INVALID", message: "The logo must be a PNG, SVG, JPEG or WebP." }); if (!text(input.dataBase64) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64)) issues.push({ field: "dataBase64", code: "INVALID", message: "The logo file could not be read." }); else if (Math.floor(input.dataBase64.length * 3 / 4) > CLIENT_LOGO_MAX_BYTES) issues.push({ field: "dataBase64", code: "TOO_LARGE", message: `The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.` }); return issues; } },
  "client.logo.remove": { key: "client.logo.remove", label: "Remove client logo", permission: "client.edit", reasonRequired: false, transaction: "client pointer cleared (asset retained) + audit + outbox + idempotency", auditAction: "client_logo_removed", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); return issues; } },
  "report.section.edit": { key:"report.section.edit",label:"Edit report section",permission:"report.edit",reasonRequired:false,transaction:"versioned report section + section history + audit + outbox",auditAction:"report_section_edited",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sectionKey",input.sectionKey);if(text(input.sectionKey)&&!isCrpReportSectionKey(input.sectionKey))issues.push({field:"sectionKey",code:"INVALID",message:"Unknown report section."});issues.push(...reportSectionBodyIssues(input.bodyHtml));if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});if(input.contentSource!=null&&!oneOf(input.contentSource,["ai","client-edited"] as const))issues.push({field:"contentSource",code:"INVALID",message:"Content source must be ai or client-edited."});return issues;} },
  "report.section.reset": { key:"report.section.reset",label:"Reset report section to template",permission:"report.edit",reasonRequired:false,transaction:"versioned report section + section history + audit + outbox",auditAction:"report_section_reset",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sectionKey",input.sectionKey);if(text(input.sectionKey)&&!isCrpReportSectionKey(input.sectionKey))issues.push({field:"sectionKey",code:"INVALID",message:"Unknown report section."});if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});return issues;} },
  "report.section.regenerate": { key:"report.section.regenerate",label:"Regenerate report section (AI)",permission:"report.edit",reasonRequired:false,transaction:"versioned report section + section history + audit + outbox",auditAction:"report_section_regenerated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sectionKey",input.sectionKey);if(text(input.sectionKey)&&!isCrpReportSectionKey(input.sectionKey))issues.push({field:"sectionKey",code:"INVALID",message:"Unknown report section."});if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});return issues;} },
  "assurance.gap.resolve": { key:"assurance.gap.resolve",label:"Resolve a data-integrity gap",permission:"snapshot.review",reasonRequired:false,transaction:"versioned gap resolution + audit + outbox",auditAction:"assurance_gap_resolved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"gapKey",input.gapKey);required(issues,"reason",input.reason);if(text(input.reason)&&input.reason.trim().length>1000)issues.push({field:"reason",code:"TOO_LONG",message:"A resolution reason must be 1,000 characters or fewer."});if(!oneOf(input.flagType,["yoy_movement","completeness","zero_blank","unmapped","out_of_boundary"] as const))issues.push({field:"flagType",code:"INVALID",message:"Unknown gap flag type."});if(input.scopeRowId!=null&&typeof input.scopeRowId!=="string")issues.push({field:"scopeRowId",code:"INVALID",message:"Scope row id is invalid."});if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});return issues;} },
  "emissions.target.upsert": { key:"emissions.target.upsert",label:"Save emissions target",permission:"target.edit",reasonRequired:false,transaction:"versioned target + audit + outbox",auditAction:"emissions_target_saved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});if(!Number.isInteger(input.baselineYear)||!Number.isInteger(input.interimYear)||!Number.isInteger(input.netZeroYear)||!(input.baselineYear<input.interimYear&&input.interimYear<input.netZeroYear))issues.push({field:"interimYear",code:"INVALID_RANGE",message:"Years must run baseline, interim, then net zero."});if(typeof input.baselineTco2e!=="number"||!Number.isFinite(input.baselineTco2e)||input.baselineTco2e<=0)issues.push({field:"baselineTco2e",code:"INVALID",message:"Baseline emissions must be greater than zero."});if(typeof input.interimReductionPercent!=="number"||!Number.isFinite(input.interimReductionPercent)||input.interimReductionPercent<=0||input.interimReductionPercent>=100)issues.push({field:"interimReductionPercent",code:"INVALID",message:"Interim reduction must be between 0 and 100 percent."});return issues;} },
  "site.create":{key:"site.create",label:"Create client site",permission:"site.manage",reasonRequired:false,transaction:"client site + audit + outbox + idempotency",auditAction:"client_site_created",validate:(input,context)=>{const issues=baseIssues(context,false);issues.push(...siteAddressIssues(input));required(issues,"name",input.name);if(text(input.jobId)===text(input.clientId))issues.push({field:"clientId",code:"INVALID",message:"Create a site from exactly one of a job or a client."});if(text(input.clientId)&&input.inServiceFrom===undefined)issues.push({field:"inServiceFrom",code:"REQUIRED",message:"State the in-service date, or mark the site as in service from before records."});if(input.inServiceFrom!=null&&!isoDate(input.inServiceFrom))issues.push({field:"inServiceFrom",code:"INVALID",message:"Enter a real in-service date, as dd/mm/yyyy."});if(input.floorAreaM2!=null&&!positiveArea(input.floorAreaM2))issues.push({field:"floorAreaM2",code:"INVALID",message:"Floor area must be greater than zero."});return issues;}},
  "site.edit":{key:"site.edit",label:"Edit client site",permission:"site.manage",reasonRequired:false,transaction:"versioned client site + audit + outbox + idempotency",auditAction:"client_site_updated",validate:(input,context)=>{const issues=baseIssues(context,false);issues.push(...siteAddressIssues(input));required(issues,"siteId",input.siteId);required(issues,"name",input.name);if(input.inServiceFrom!==null&&!isoDate(input.inServiceFrom))issues.push({field:"inServiceFrom",code:"INVALID",message:"Enter a real in-service date, as dd/mm/yyyy."});if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  // CLIENT-04: coordinates derived from a postcode and country by the geocoder, best effort — audited like any write.
  "site.location.set":{key:"site.location.set",label:"Locate a client site",permission:"site.manage",reasonRequired:false,transaction:"site coordinates + audit + outbox + idempotency",auditAction:"client_site_located",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});issues.push(...locationIssues(input));return issues;}},
  "client.location.set":{key:"client.location.set",label:"Locate a client",permission:"client.edit",reasonRequired:false,transaction:"client coordinates + audit + outbox + idempotency",auditAction:"client_located",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"clientId",input.clientId);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});issues.push(...locationIssues(input));return issues;}},
  "site.registeredOffice":{key:"site.registeredOffice",label:"Set registered office",permission:"site.manage",reasonRequired:false,transaction:"registered-office constraint + audit + outbox + idempotency",auditAction:"client_site_registered_office_changed",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(typeof input.isRegisteredOffice!=="boolean")issues.push({field:"isRegisteredOffice",code:"INVALID",message:"Registered-office flag must be true or false."});if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "site.vacate":{key:"site.vacate",label:"Vacate client site",permission:"site.manage",reasonRequired:false,transaction:"effective-dated site lifecycle + audit + outbox + idempotency",auditAction:"client_site_vacated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(!isoDate(input.effectiveDate))issues.push({field:"effectiveDate",code:"REQUIRED",message:"Vacating a site requires its effective date (the first day out of service)."});if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "site.reinstate":{key:"site.reinstate",label:"Reinstate client site",permission:"site.manage",reasonRequired:false,transaction:"effective-dated site lifecycle + audit + outbox + idempotency",auditAction:"client_site_reinstated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "site.archive":{key:"site.archive",label:"Archive client site",permission:"site.manage",reasonRequired:true,transaction:"deactivation (never deletion; rows keep the site) + audit + outbox + idempotency",auditAction:"client_site_archived",validate:(input,context)=>{const issues=baseIssues(context,true);required(issues,"siteId",input.siteId);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "site.unarchive":{key:"site.unarchive",label:"Unarchive client site",permission:"site.manage",reasonRequired:false,transaction:"reactivation + audit + outbox + idempotency",auditAction:"client_site_unarchived",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "site.floorArea.record":{key:"site.floorArea.record",label:"Record site floor area",permission:"site.manage",reasonRequired:false,transaction:"effective-dated floor-area record + versioned site + audit + outbox + idempotency",auditAction:"client_site_floor_area_recorded",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"siteId",input.siteId);if(!positiveArea(input.floorAreaM2))issues.push({field:"floorAreaM2",code:"INVALID",message:"Floor area must be greater than zero."});if(input.effectiveFrom!==null&&!isoDate(input.effectiveFrom))issues.push({field:"effectiveFrom",code:"INVALID",message:"Enter a real effective-from date, as dd/mm/yyyy."});if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});return issues;}},
  "emissions.intensity.upsert":{key:"emissions.intensity.upsert",label:"Save intensity target",permission:"target.edit",reasonRequired:false,transaction:"versioned intensity target + audit + outbox",auditAction:"intensity_target_saved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"denominatorUnit",input.denominatorUnit);if(!oneOf(input.metric,["turnover","employee","floor-area"] as const))issues.push({field:"metric",code:"INVALID",message:"Intensity metric is invalid."});if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be zero or greater."});if(input.metric==="floor-area"){if(input.reportingDenominator!=null)issues.push({field:"reportingDenominator",code:"INVALID",message:"Floor-area intensity derives its denominator from the in-boundary sites' floor area (NZC-071); do not type one."});}else if(!(typeof input.reportingDenominator==="number"&&input.reportingDenominator>0))issues.push({field:"reportingDenominator",code:"INVALID",message:"Value must be greater than zero."});if(!(input.baselineIntensity>0))issues.push({field:"baselineIntensity",code:"INVALID",message:"Baseline intensity must be greater than zero."});if(!Number.isInteger(input.baselineYear)||!Number.isInteger(input.interimYear)||!Number.isInteger(input.netZeroYear)||!(input.baselineYear<input.interimYear&&input.interimYear<input.netZeroYear))issues.push({field:"interimYear",code:"INVALID_RANGE",message:"Years must run baseline, interim, then net zero."});if(!(input.interimReductionPercent>0&&input.interimReductionPercent<100))issues.push({field:"interimReductionPercent",code:"INVALID",message:"Interim reduction must be between 0 and 100 percent."});return issues;}},
  "purchased.goods.category.create":{key:"purchased.goods.category.create",label:"Create purchased-goods category",permission:"scoperow.edit",reasonRequired:false,transaction:"client category + audit + outbox",auditAction:"purchased_goods_category_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"name",input.name);return issues;}},
  /**
   * Admin alone, and spanning organisations — a person is not confined to one tenant. The
   * tenant-crossing read behind it returns pointers and counts rather than names; this decides.
   */
  "subject.review.decide":{key:"subject.review.decide",label:"Rule on an identity question",permission:"subject.review",reasonRequired:false,transaction:"subject links + review decision + audit + outbox + idempotency",auditAction:"subject_review_decided",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"reviewId",input.reviewId);if(!(["linked","distinct","deferred"] as const).includes(input.decision))issues.push({field:"decision",code:"INVALID",message:"A review is linked, distinct or deferred."});if(input.decision!=="deferred"&&!String(input.basis??"").trim())issues.push({field:"basis",code:"REQUIRED",message:"Record why — a decision about who somebody is has to be explicable later."});if(String(input.basis??"").length>1000)issues.push({field:"basis",code:"TOO_LONG",message:"A basis is at most 1000 characters."});return issues;}},
  /**
   * Its own capability (NZC-110). Deciding what a client is shown is a disclosure decision about
   * that client's view, not administration of their portal users, and holding one has never implied
   * the other — so it is `category.visibility`, own-clients for a consultant, and a new matrix
   * version rather than a stretch of `portal.admin`.
   */
  "client.category.visibility.set":{key:"client.category.visibility.set",label:"Decide whether a client sees a category",permission:"category.visibility",reasonRequired:false,transaction:"client category visibility + audit + outbox + idempotency",auditAction:"client_category_visibility_set",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"clientId",input.clientId);required(issues,"categoryCode",input.categoryCode);if(typeof input.note==="string"&&input.note.length>500)issues.push({field:"note",code:"TOO_LONG",message:"A note is at most 500 characters."});return issues;}},
  /**
   * Naming, not measuring. It carries `clientfactor.manage` rather than a capability of its own:
   * that permission already allows creating a client factor *with its own emission value*, so a
   * label that cannot change a number is strictly weaker than what its holders may already do, and
   * a new capability would produce an identical row in the matrix.
   */
  "client.factor.alias.set":{key:"client.factor.alias.set",label:"Name a factor for a client",permission:"clientfactor.manage",reasonRequired:false,transaction:"client factor alias + audit + outbox + idempotency",auditAction:"client_factor_alias_set",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"clientId",input.clientId);required(issues,"factorId",input.factorId);if(input.label!==null&&input.label.trim()==="")issues.push({field:"label",code:"REQUIRED",message:"Give the factor a name, or withdraw the one it has."});if(input.label!==null&&input.label.trim().length>200)issues.push({field:"label",code:"TOO_LONG",message:"A factor name is at most 200 characters."});return issues;}},
  "client.factor.create":{key:"client.factor.create",label:"Create client factor",permission:"clientfactor.manage",reasonRequired:false,transaction:"client factor + audit + outbox + idempotency",auditAction:"client_factor_created",validate:(input,context)=>{const issues=baseIssues(context,false);for(const [field,value] of [["jobId",input.jobId],["scope",input.scope],["reportLabel",input.reportLabel],["unit",input.unit],["geography",input.geography],["source",input.source]] as const)required(issues,field,value);if(!crpScopeOptions.some(option=>option.value===input.scope))issues.push({field:"scope",code:"INVALID",message:"Select a controlled CRP scope category."});if(typeof input.kgco2ePerUnit!=="number"||!Number.isFinite(input.kgco2ePerUnit)||input.kgco2ePerUnit<0)issues.push({field:"kgco2ePerUnit",code:"INVALID",message:"Factor value must be zero or greater."});if(!Number.isInteger(input.vintageYear)||input.vintageYear<1990||input.vintageYear>2100)issues.push({field:"vintageYear",code:"INVALID",message:"Factor vintage year is invalid."});if(input.evidenceFileName&&(!input.evidenceHash||!input.evidenceStorageProvider))issues.push({field:"evidenceHash",code:"REQUIRED",message:"Evidence files require a storage provider and integrity hash."});return issues;}},
  "client.factor.update":{key:"client.factor.update",label:"Update client factor",permission:"clientfactor.manage",reasonRequired:false,transaction:"versioned client factor + audit + outbox + idempotency",auditAction:"client_factor_updated",validate:(input,context)=>{const issues=baseIssues(context,false);for(const [field,value] of [["clientFactorId",input.clientFactorId],["reportLabel",input.reportLabel],["unit",input.unit],["geography",input.geography],["source",input.source]] as const)required(issues,field,value);if(!positive(input.expectedVersion))issues.push({field:"expectedVersion",code:"INVALID",message:"Expected version must be positive."});if(typeof input.kgco2ePerUnit!=="number"||!Number.isFinite(input.kgco2ePerUnit)||input.kgco2ePerUnit<0)issues.push({field:"kgco2ePerUnit",code:"INVALID",message:"Factor value must be zero or greater."});if(!Number.isInteger(input.vintageYear)||input.vintageYear<1990||input.vintageYear>2100)issues.push({field:"vintageYear",code:"INVALID",message:"Factor vintage year is invalid."});if(input.evidenceFileName&&(!input.evidenceHash||!input.evidenceStorageProvider))issues.push({field:"evidenceHash",code:"REQUIRED",message:"Evidence files require a storage provider and integrity hash."});return issues;}},
  "client.factor.archive":{key:"client.factor.archive",label:"Archive client factor",permission:"clientfactor.manage",reasonRequired:false,transaction:"client factor archived flag + reference guard + audit + outbox",auditAction:"client_factor_archived",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"clientFactorId",input.clientFactorId);if(typeof input.archived!=="boolean")issues.push({field:"archived",code:"INVALID",message:"Archived flag must be true or false."});return issues;}},
  "emission.source.group.create":{key:"emission.source.group.create",label:"Create emission-source group",permission:"scoperow.edit",reasonRequired:false,transaction:"source group + audit + outbox + idempotency",auditAction:"emission_source_group_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"name",input.name);if(input.factorId!=null&&(!text(input.datasetId)||!text(input.unit)))issues.push({field:"datasetId",code:"REQUIRED",message:"A group factor must identify its dataset and unit."});return issues;}},
  "emission.source.group.sync":{key:"emission.source.group.sync",label:"Roll up an emission-source group",permission:"scoperow.edit",reasonRequired:false,transaction:"deterministic roll-up of enabled members + one auto-generated scope row + audit + outbox + idempotency",auditAction:"emission_source_group_synced",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"groupId",input.groupId);return issues;}},
  "emission.source.create":{key:"emission.source.create",label:"Create emission source",permission:"scoperow.edit",reasonRequired:false,transaction:"emission source + audit + outbox + idempotency",auditAction:"emission_source_created",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sourceName",input.sourceName);required(issues,"dataSource",input.dataSource);if(!crpScopeOptions.some(option=>option.value===input.scope))issues.push({field:"scope",code:"INVALID",message:"Select a controlled CRP scope category."});if(!(["asset","vehicle","commuting","spend","travel"] as const).includes(input.sourceType))issues.push({field:"sourceType",code:"INVALID",message:"Source type is invalid."});if(input.quantity!==null&&(!Number.isFinite(input.quantity)||input.quantity<0))issues.push({field:"quantity",code:"INVALID",message:"Quantity must be zero or greater."});if(!Number.isFinite(input.applyPct)||input.applyPct<0||input.applyPct>100)issues.push({field:"applyPct",code:"INVALID",message:"Apportionment must be between 0 and 100 percent."});if(input.factorSource==="client"&&!input.clientFactorId)issues.push({field:"clientFactorId",code:"REQUIRED",message:"Select the client factor used by this source."});if(input.factorSource==="dataset"&&input.clientFactorId)issues.push({field:"clientFactorId",code:"INVALID",message:"Dataset sources cannot reference a client factor."});if(input.detail.kind!==input.sourceType)issues.push({field:"detail",code:"INVALID",message:"Source detail must match the selected source type."});if(input.sourceType==="spend"&&!text(input.purchasedGoodsCategoryId))issues.push({field:"purchasedGoodsCategoryId",code:"REQUIRED",message:"Select the controlled purchased-goods category for this spend line."});if(input.purchasedGoodsCategoryId!=null&&typeof input.purchasedGoodsCategoryId!=="string")issues.push({field:"purchasedGoodsCategoryId",code:"INVALID",message:"Purchased-goods category is invalid."});issues.push(...monthlyActivityIssues(input.monthlyActivity),...activityGrainIssues(input));return issues;}},
  "emission.source.sync":{key:"emission.source.sync",label:"Sync emission source to scope",permission:"scoperow.edit",reasonRequired:false,transaction:"source-locked canonical row upsert + audit + outbox + idempotency",auditAction:"emission_source_synced",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sourceId",input.sourceId);return issues;}},
  "emission.source.activity.update":{key:"emission.source.activity.update",label:"Update emission-source activity",permission:"scoperow.edit",reasonRequired:false,transaction:"versioned source activity + audit + outbox + idempotency",auditAction:"emission_source_activity_updated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sourceId",input.sourceId);if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected source version must be one or greater."});if(input.quantity!==null&&(!Number.isFinite(input.quantity)||input.quantity<0))issues.push({field:"quantity",code:"INVALID",message:"Quantity must be zero or greater."});if(!Number.isFinite(input.applyPct)||input.applyPct<0||input.applyPct>100)issues.push({field:"applyPct",code:"INVALID",message:"Apportionment must be between 0 and 100 percent."});if(input.quantity!==null&&!input.unit?.trim())issues.push({field:"unit",code:"REQUIRED",message:"Activity unit is required when quantity is present."});issues.push(...monthlyActivityIssues(input.monthlyActivity),...activityGrainIssues(input));return issues;}},
  "emission.source.status.update":{key:"emission.source.status.update",label:"Change emission-source status",permission:"scoperow.edit",reasonRequired:false,transaction:"versioned source status + linked canonical row + audit + outbox + idempotency",auditAction:"emission_source_status_updated",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"sourceId",input.sourceId);if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)issues.push({field:"expectedVersion",code:"INVALID",message:"Expected source version must be one or greater."});if(typeof input.enabled!=="boolean")issues.push({field:"enabled",code:"INVALID",message:"Source status must be enabled or archived."});return issues;}},
  "emission.source.rollforward":{key:"emission.source.rollforward",label:"Roll forward previous-year spend mappings",permission:"scoperow.edit",reasonRequired:false,transaction:"prior-year mapping copy + re-pinned datasets + audit + outbox + idempotency",auditAction:"emission_sources_rolled_forward",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);if(input.fromJobId!=null&&(typeof input.fromJobId!=="string"||input.fromJobId.trim()===""))issues.push({field:"fromJobId",code:"INVALID",message:"Source job is invalid."});return issues;}},
  "scope.row.rollforward":{key:"scope.row.rollforward",label:"Roll forward previous-year scope rows",permission:"scoperow.edit",reasonRequired:false,transaction:"prior-year row copy + re-pinned datasets + audit + outbox + idempotency",auditAction:"scope_rows_rolled_forward",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"priorJobId",input.priorJobId);if(!Array.isArray(input.rowIds)||input.rowIds.length===0||input.rowIds.some(id=>typeof id!=="string"||!id.trim()))issues.push({field:"rowIds",code:"REQUIRED",message:"Select at least one prior-year row to roll forward."});return issues;}},
  "emission.source.import.commit":{key:"emission.source.import.commit",label:"Commit a spend import batch",permission:"scoperow.edit",reasonRequired:false,transaction:"token verify + batched spend sources + audit + outbox + idempotency",auditAction:"spend_import_committed",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"token",input.token);if(!Array.isArray(input.rows)||input.rows.length===0)issues.push({field:"rows",code:"REQUIRED",message:"Import at least one row."});else if(input.rows.length>10_000)issues.push({field:"rows",code:"TOO_MANY",message:"An import may carry at most 10,000 rows."});return issues;}},
  "emission.source.import.void":{key:"emission.source.import.void",label:"Void a spend import batch",permission:"scoperow.edit",reasonRequired:false,transaction:"audited soft-void of pending batch rows + linked rows + audit + outbox",auditAction:"spend_import_voided",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"jobId",input.jobId);required(issues,"batchId",input.batchId);return issues;}},
  "client.import.mapping.save":{key:"client.import.mapping.save",label:"Save a client's import column map",permission:"scoperow.edit",reasonRequired:false,transaction:"versioned client import mapping + audit + outbox",auditAction:"client_import_mapping_saved",validate:(input,context)=>{const issues=baseIssues(context,false);required(issues,"clientId",input.clientId);if(input.importKind!=="spend")issues.push({field:"importKind",code:"INVALID",message:"Import kind must be spend."});if(typeof input.columns!=="object"||input.columns===null||Array.isArray(input.columns))issues.push({field:"columns",code:"INVALID",message:"Column map must be an object."});return issues;}},
  "dataset.override.add": { key: "dataset.override.add", label: "Add manual dataset", permission: "dataset.manage", reasonRequired: true, transaction: "resolution + warning + audit", auditAction: "dataset_override_added", validate: (input, context) => { const issues = baseIssues(context, true); required(issues, "jobId", input.jobId); required(issues, "scope", input.scope); required(issues, "datasetId", input.datasetId); required(issues, "reportingFrom", input.reportingFrom); required(issues, "reportingTo", input.reportingTo); return issues; } },
  "portal.access.grant": { key: "portal.access.grant", label: "Grant portal access", permission: "portal.admin", reasonRequired: false, transaction: "access grant + job grants + invitation outbox", auditAction: "portal_access_granted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "clientId", input.clientId); required(issues, "userId", input.userId); if (!input.jobIds.length) issues.push({ field: "jobIds", code: "REQUIRED", message: "Grant at least one job." }); return issues; } },
  "sales.opportunity.convert": { key: "sales.opportunity.convert", label: "Convert won opportunity", permission: "job.manage", reasonRequired: false, transaction: "client + quote + optional job + outbox", auditAction: "opportunity_converted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "opportunityId", input.opportunityId); required(issues, "quoteId", input.quoteId); if (input.expectedStatus !== "WON") issues.push({ field: "expectedStatus", code: "PRECONDITION", message: "Opportunity must be WON." }); return issues; } },
  "lca.assessment.create": { key: "lca.assessment.create", label: "Create LCA assessment", permission: "scoperow.edit", reasonRequired: false, transaction: "assessment + audit + outbox + idempotency", auditAction: "lca_assessment_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaAssessmentIssues(input)]; required(issues, "jobId", input.jobId); return issues; } },
  "lca.assessment.update": { key: "lca.assessment.update", label: "Update LCA assessment", permission: "scoperow.edit", reasonRequired: false, transaction: "versioned assessment + audit + outbox + idempotency", auditAction: "lca_assessment_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaAssessmentIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "lca.lineItem.create": { key: "lca.lineItem.create", label: "Create LCA line item", permission: "scoperow.edit", reasonRequired: false, transaction: "line item + audit + outbox + idempotency", auditAction: "lca_line_item_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaLineItemIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); return issues; } },
  "lca.lineItem.update": { key: "lca.lineItem.update", label: "Update LCA line item", permission: "scoperow.edit", reasonRequired: false, transaction: "line item + audit + outbox + idempotency", auditAction: "lca_line_item_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaLineItemIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); return issues; } },
  "lca.lineItem.delete": { key: "lca.lineItem.delete", label: "Delete LCA line item", permission: "scoperow.edit", reasonRequired: false, transaction: "line item removal + audit + outbox + idempotency", auditAction: "lca_line_item_deleted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); return issues; } },
  "lca.lineItem.bulkCreate": { key: "lca.lineItem.bulkCreate", label: "Bulk-add LCA line items", permission: "scoperow.edit", reasonRequired: false, transaction: "line items + audit + outbox + idempotency", auditAction: "lca_line_items_bulk_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); if (!Array.isArray(input.lines) || input.lines.length === 0) issues.push({ field: "lines", code: "REQUIRED", message: "Add at least one line item." }); else input.lines.forEach((line, index) => lcaLineItemIssues(line).forEach((issue) => issues.push({ ...issue, field: `lines.${index}.${issue.field}` }))); return issues; } },
  "lca.transportLeg.create": { key: "lca.transportLeg.create", label: "Add transport leg", permission: "scoperow.edit", reasonRequired: false, transaction: "transport leg + line-item transport total + audit + outbox + idempotency", auditAction: "lca_transport_leg_created", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaTransportLegIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); return issues; } },
  "lca.transportLeg.update": { key: "lca.transportLeg.update", label: "Update transport leg", permission: "scoperow.edit", reasonRequired: false, transaction: "transport leg + line-item transport total + audit + outbox + idempotency", auditAction: "lca_transport_leg_updated", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaTransportLegIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); required(issues, "legId", input.legId); return issues; } },
  "lca.transportLeg.delete": { key: "lca.transportLeg.delete", label: "Delete transport leg", permission: "scoperow.edit", reasonRequired: false, transaction: "transport leg removal + line-item transport total + audit + outbox + idempotency", auditAction: "lca_transport_leg_deleted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); required(issues, "legId", input.legId); return issues; } },
  "lca.lineItem.gapFill": { key: "lca.lineItem.gapFill", label: "Gap-fill LCA line item", permission: "scoperow.edit", reasonRequired: false, transaction: "line item + audit + outbox + idempotency", auditAction: "lca_line_item_gap_filled", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaGapFillIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "lineItemId", input.lineItemId); return issues; } },
  "lca.assessment.calculate": { key: "lca.assessment.calculate", label: "Calculate LCA assessment", permission: "scoperow.edit", reasonRequired: false, transaction: "line items + transport legs + assessment totals + audit + outbox + idempotency", auditAction: "lca_assessment_calculated", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "lca.assessment.review.approve": { key: "lca.assessment.review.approve", label: "Approve LCA assessment", permission: "snapshot.review", reasonRequired: false, transaction: "assessment review + audit + outbox + idempotency", auditAction: "lca_assessment_approved", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "lca.assessment.review.reject": { key: "lca.assessment.review.reject", label: "Reject LCA assessment", permission: "snapshot.review", reasonRequired: false, transaction: "assessment review + audit + outbox + idempotency", auditAction: "lca_assessment_rejected", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "reviewerNote", input.reviewerNote); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "lca.assessment.snapshot.create": { key: "lca.assessment.snapshot.create", label: "Freeze LCA result snapshot", permission: "report.edit", reasonRequired: false, transaction: "content-addressed snapshot + audit + outbox + idempotency", auditAction: "lca_result_snapshot_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); if (!positive(input.expectedVersion)) issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be positive." }); return issues; } },
  "lca.scenario.create": { key: "lca.scenario.create", label: "Create LCA scenario", permission: "scoperow.edit", reasonRequired: false, transaction: "scenario + audit + outbox + idempotency", auditAction: "lca_scenario_created", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "name", input.name); return issues; } },
  "lca.scenario.update": { key: "lca.scenario.update", label: "Update LCA scenario", permission: "scoperow.edit", reasonRequired: false, transaction: "scenario + audit + outbox + idempotency", auditAction: "lca_scenario_updated", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "scenarioId", input.scenarioId); required(issues, "name", input.name); return issues; } },
  "lca.scenario.delete": { key: "lca.scenario.delete", label: "Delete LCA scenario", permission: "scoperow.edit", reasonRequired: false, transaction: "scenario removal + audit + outbox + idempotency", auditAction: "lca_scenario_deleted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "scenarioId", input.scenarioId); return issues; } },
  "lca.scenario.multiplier.set": { key: "lca.scenario.multiplier.set", label: "Set LCA scenario multiplier", permission: "scoperow.edit", reasonRequired: false, transaction: "scenario multiplier + audit + outbox + idempotency", auditAction: "lca_scenario_multiplier_set", validate: (input, context) => { const issues = [...baseIssues(context, false), ...lcaScenarioMultiplierIssues(input)]; required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "scenarioId", input.scenarioId); return issues; } },
  "lca.scenario.multiplier.delete": { key: "lca.scenario.multiplier.delete", label: "Delete LCA scenario multiplier", permission: "scoperow.edit", reasonRequired: false, transaction: "scenario multiplier removal + audit + outbox + idempotency", auditAction: "lca_scenario_multiplier_deleted", validate: (input, context) => { const issues = baseIssues(context, false); required(issues, "jobId", input.jobId); required(issues, "assessmentId", input.assessmentId); required(issues, "scenarioId", input.scenarioId); required(issues, "multiplierId", input.multiplierId); return issues; } },
};

export function validateCommand<K extends CommandKey>(key: K, input: CommandInputMap[K], context: CommandContext) { return commandDefinitions[key].validate(input, context); }

// ---- Model-fidelity extensions (proposed canonical model, 29 Aug 2026) ----
// Additive and optional on ScopeRowWriteFields; see docs/MODEL_FIDELITY_DATA_ENTRY.md.
export type DataConfidence = "H" | "M" | "L";
export type FactorSource = "dataset" | "client";

export type ClientFactorEvidence = { fileName: string; storageProvider: "local" | "sharepoint"; url: string | null; externalItemId: string | null; hash: string };
export type ClientFactor = {
  id: string; organisationId: string; clientId: string; jobId: string | null;
  scope: string; categoryPath: string[]; reportLabel: string; description: string;
  unit: string; ghgUnit: string; kgco2ePerUnit: number;
  geography: string; vintageYear: number; version: number;
  source: string; evidence: ClientFactorEvidence | null;
  archived: boolean; createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string | null;
};

export type ClientSite = {
  id: string; organisationId: string; clientId: string; name: string;
  addressLines: string[]; postcode: string | null;
  latitude: number | null; longitude: number | null; geocodeSource: string | null; geocodePrecision: string | null;
  /** NZC-070 — one term, one meaning: the same lifecycle pair as `ClientSiteReadModel`. */
  inServiceFrom: string | null; vacatedEffective: string | null;
  archived: boolean; createdBy: string; createdAt: string;
};

export type EmissionSourceKind = "asset" | "vehicle" | "commuting" | "spend" | "travel";
export type CommutingDetail = { kind: "commuting"; vehicleRegistration: string | null; commuteMode: string; distanceUnit: string; wfhDaysPerYear: number | null; wfhHoursPerDay: number | null; employeeName: string | null };
export type VehicleDetail = { kind: "vehicle"; vehicleRegistration: string | null; make: string | null; model: string | null; fuel: string | null };
export type SpendDetail = { kind: "spend"; netValue: number; vatPercent: number | null; glCode: string | null; category: string };
export type AssetDetail = { kind: "asset" };
// S1 (data-entry UX review item 5) — one business-travel trip: a mode, a leg and
// an optional carrier. Many trips roll up to one canonical Scope 3.6 row.
export type TravelDetail = { kind: "travel"; travelMode: string; origin: string | null; destination: string | null; carrier: string | null; distanceUnit: string; passengers: number | null };
export type EmissionSourceDetail = CommutingDetail | VehicleDetail | SpendDetail | AssetDetail | TravelDetail;

export type EmissionSourceGroup = { id: string; jobId: string; name: string; datasetId: string | null; factorId: string | null; factorLabel: string | null; unit: string | null };
// S1 — the deterministic roll-up state of a group: one auto-generated scope row over its enabled members.
export type EmissionGroupRollup = { groupId: string; rowId: string; scope: string; autoPairKind: string | null; reviewStatus: "pending" | "approved" | "rejected"; memberCount: number; enabledMemberCount: number; summedQuantity: number | null; enabled: boolean; stale: boolean };
export type EmissionSource = {
  id: string; jobId: string; groupId: string | null;
  scope: string; sourceType: EmissionSourceKind; sourceSubtype: string | null;
  siteId: string | null; sourceName: string; assetIdentifier: string | null;
  purchasedGoodsCategoryId: string | null;
  datasetId: string | null; factorId: string | null; factorSource: FactorSource; clientFactorId: string | null;
  quantity: number | null; unit: string | null; applyPct: number | null;
  dataSource: string; dataConfidence: DataConfidence | null;
  monthlyActivity: MonthlyActivitySlot[]; detail: EmissionSourceDetail;
  notes: string | null; calculatedTco2e: number | null; enabled: boolean;
  submittedByPortal: boolean; reviewStatus: "pending" | "approved" | "rejected" | null; version: number;
  scopeRowId: string | null; scopeRowVersion: number | null; scopeRowReviewStatus: "pending" | "approved" | "rejected" | null;
  rolledForwardFromSourceId: string | null; factorVersionMoved: boolean;
  yoyPriorQuantity: number | null; yoyPriorUnit: string | null;
};

// Previous-year rollforward (NZC-030) — preview of the prior job's spend mappings.
export type SpendRollforwardLine = {
  priorSourceId: string; description: string; glCode: string | null;
  purchasedGoodsCategoryId: string | null; purchasedGoodsCategoryLabel: string | null;
  factorSource: FactorSource; factorLabel: string | null;
  pinnedFactorVersion: string | null; currentFactorVersion: string | null; factorVersionMoved: boolean;
  datasetInJobSelection: boolean; alreadyRolledForward: boolean;
};
export type SpendRollforwardPreview = {
  priorJob: { id: string; number: string; reportingYear: number } | null;
  lines: SpendRollforwardLine[];
};

// NZC-063 — previous-year rollforward generalised to every scope-row type (not
// just the spend register): the prior job's enabled canonical rows, factor +
// hierarchy + site copied in, with the same moved-factor / not-in-selection /
// already-rolled-forward lineage the spend mechanism already surfaces.
export type ScopeRowRollforwardLine = {
  priorRowId: string; sourceLabel: string; scope: string; categoryCode: string | null; categoryLabel: string;
  siteId: string | null; siteLabel: string | null;
  factorSource: FactorSource; factorLabel: string | null;
  pinnedFactorVersion: string | null; currentFactorVersion: string | null; factorVersionMoved: boolean;
  datasetInJobSelection: boolean; alreadyRolledForward: boolean;
};
export type ScopeRowRollforwardPreview = {
  priorJob: { id: string; number: string; reportingYear: number } | null;
  rows: ScopeRowRollforwardLine[];
};
