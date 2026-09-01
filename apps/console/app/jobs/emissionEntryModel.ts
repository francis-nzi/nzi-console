// UX1a — the one shared data-entry field order (NZC-046 / DATA_ENTRY_UX.md §3–§4).
// Pure spec: given a category + audience + mode, return the canonical field
// sequence and the action set. `EmissionEntryForm.tsx` renders this verbatim so
// the CRP workspace and the client portal are provably the same capture process
// (the portal is a constrained mirror — same order, fewer fields).
import type { EmissionCategory, ScopeQualityTier, ScopeRowReadModel, ScopeRowWriteFields } from "@nzi/contracts";
import { scopeMeta } from "@nzi/contracts";

export type EntryAudience = "crm" | "portal";
export type EntryMode = "new" | "existing";

/** The controlled draft the shared capture component edits (both surfaces). */
export type EmissionEntryDraft = {
  activity: string;
  quantity: string;
  unit: string;
  vatPercent: string;
  glCode: string;
  spendCategoryId: string;
  registration: string;
  manualMode: boolean;
  manualDetail: string;
  factorId: string;
  qualityTier: string;
  dataConfidence: string;
  note: string;
  monthlyOpen: boolean;
  monthly: Record<string, string>;
};

export type EntryFactorOption = { id: string; label: string; unit?: string; isClientFactor?: boolean };

/** Result of the two-step DVLA registration lookup (UX1 lookup). */
export type RegistrationLookupOutcome =
  | {
      ok: true;
      make: string | null;
      fuelType: string | null;
      suggestedClass: string;
      year: number | null;
      /** CRM only — a suggested factor when one matched. */
      factorId?: string | null;
      factorLabel?: string | null;
    }
  | { ok: false; message: string };
export type EmissionEntryLineageStep = { label: string; detail: string };

export type EmissionEntryFieldKey =
  | "siteBanner"
  | "registrationFinder"
  | "activity"
  | "quantity"
  | "unit"
  | "monthly"
  | "spendDetails"
  | "factor"
  | "qualityTier"
  | "dataConfidence"
  | "note"
  | "documents"
  | "lineage";

export type EmissionEntryControl =
  | "banner"
  | "registration"
  | "smart-search"
  | "number"
  | "unit-select"
  | "months"
  | "spend-group"
  | "factor-select"
  | "select"
  | "textarea"
  | "dropzone"
  | "lineage";

export type EmissionEntryField = {
  key: EmissionEntryFieldKey;
  label: string;
  control: EmissionEntryControl;
  hint?: string;
  /** collapsed / not required to save a draft */
  optional?: boolean;
};

export type EmissionEntryAction = {
  key: "saveDraft" | "save" | "submit" | "reject" | "approve";
  label: string;
  variant: "primary" | "ghost";
};

const REG_KINDS = new Set(["vehicle", "travel", "commuting"]);

export const isRegistrationKind = (category: EmissionCategory): boolean =>
  REG_KINDS.has(category.kind);

export const isSpendKind = (category: EmissionCategory): boolean =>
  category.kind === "spend";

/** Manual-entry helper text for the "…or enter manually" link, by reg kind. */
export function manualEntryHint(category: EmissionCategory): string {
  if (category.kind === "commuting") return "mode · WFH days";
  if (category.kind === "travel") return "air · rail · hotel";
  return "make · model · fuel";
}

/**
 * The canonical field order for one entry, both surfaces. The portal drops the
 * factor / quality / confidence / lineage fields — it never sees or sets them.
 */
export function buildEmissionEntryFields(
  category: EmissionCategory,
  audience: EntryAudience,
  mode: EntryMode,
): EmissionEntryField[] {
  const spend = isSpendKind(category);
  const reg = isRegistrationKind(category);
  const scopeLabel = scopeMeta[category.scope].label;
  const scopedTo = `Scope ${category.scope} · ${category.name}`;
  const fields: EmissionEntryField[] = [];

  // 1 — site is context, shown as a banner, changed on the row not here (§2)
  fields.push({
    key: "siteBanner",
    label: "Site",
    control: "banner",
    hint: "This entry is allocated to the site chosen at the top of data entry.",
  });

  // 2 — registration finder, only for the three reg categories (§4)
  if (reg) {
    fields.push({
      key: "registrationFinder",
      label: category.kind === "commuting" ? "Vehicle / mode" : "Vehicle",
      control: "registration",
      hint: `DVLA registration lookup, or enter ${manualEntryHint(category)} manually.`,
    });
  }

  // 3 — activity smart-search, scoped to this category's factors
  fields.push({
    key: "activity",
    label: spend
      ? audience === "portal"
        ? "Supplier / description"
        : "Activity / source"
      : audience === "portal"
        ? "Activity"
        : "Activity / source",
    control: "smart-search",
    hint: `Smart search — ${scopedTo} factors only.`,
  });

  // 4 + 5 — quantity + unit (spend relabels to net value + VAT %)
  fields.push({
    key: "quantity",
    label: spend ? "Net value (£)" : "Quantity",
    control: "number",
  });
  fields.push({
    key: "unit",
    label: spend ? "VAT %" : "Unit",
    control: spend ? "number" : "unit-select",
    optional: spend,
  });

  // 6 — monthly breakdown, directly under quantity, collapsed (§3)
  fields.push({
    key: "monthly",
    label: "Add monthly breakdown",
    control: "months",
    hint: "Reporting-period aligned (NZC-032).",
    optional: true,
  });

  // 7 — spend details, only under Purchased Goods and Services (§4)
  if (spend) {
    fields.push({
      key: "spendDetails",
      label: "Spend details",
      control: "spend-group",
      hint:
        audience === "portal"
          ? "GL / nominal code and your authorised purchased-goods category."
          : "GL / nominal code and PG&S sub-category. Consultant maps factors and syncs to Scope 3.1.",
    });
  }

  // 8–10 — factor + quality + confidence: consultant only, portal never sees them
  if (audience === "crm") {
    fields.push({
      key: "factor",
      label: "Emission factor",
      control: "factor-select",
      hint: `Set from the selected activity; limited to ${scopedTo}.`,
    });
    fields.push({ key: "qualityTier", label: "Quality tier", control: "select" });
    fields.push({
      key: "dataConfidence",
      label: "Data confidence",
      control: "select",
      hint: "NZC-044.",
    });
  }

  // 11 — evidence note
  fields.push({
    key: "note",
    label: audience === "portal" ? "Evidence note" : "Notes",
    control: "textarea",
    optional: true,
  });

  // 12 — supporting documents
  fields.push({
    key: "documents",
    label: "Supporting documents",
    control: "dropzone",
    hint: "PDF · image · spreadsheet · virus-scanned on upload.",
    optional: true,
  });

  // 13 — calculation lineage + provenance, consultant view of an existing row
  if (audience === "crm" && mode === "existing") {
    fields.push({
      key: "lineage",
      label: "Calculation lineage",
      control: "lineage",
      hint: `${scopeLabel} · provenance travels with the row.`,
    });
  }

  return fields;
}

export function emissionEntryActions(
  audience: EntryAudience,
  mode: EntryMode,
): EmissionEntryAction[] {
  if (audience === "portal") {
    return [
      { key: "saveDraft", label: "Save draft", variant: "ghost" },
      { key: "submit", label: "Submit for review", variant: "primary" },
    ];
  }
  if (mode === "existing") {
    return [
      { key: "reject", label: "Reject", variant: "ghost" },
      { key: "approve", label: "Approve row", variant: "primary" },
    ];
  }
  return [
    { key: "saveDraft", label: "Save draft", variant: "ghost" },
    { key: "save", label: "Save entry", variant: "primary" },
  ];
}

/** Empty-state copy for a category with no entries — neutral, never a demand (§8, NZC-046). */
export const NO_DATA_NOTE =
  "No data yet — shown for completeness. Empty categories are excluded from the report.";

// ── UX1c — mapping the shared draft to/from the canonical scope row ────────────
// The accordion's Add-entry and drawer edit both run through `EmissionEntryForm`;
// these pure mappers turn its draft into `scope.row.create` / `scope.row.update`
// input (stamping the category code and the site-as-context) and back.

export type EntryFactorRef = {
  id: string;
  label: string;
  unit?: string;
  /** top-level scope "1" | "2" | "3" — for filtering to a category's scope */
  scope?: "1" | "2" | "3";
  datasetId?: string | null;
  datasetVersion?: string | null;
  factorSource?: "dataset" | "client";
  clientFactorId?: string | null;
};

const QUALITY_TO_TIER: Record<string, ScopeQualityTier> = {
  Measured: "measured", Estimated: "estimated", "Spend-based": "spend-based", Survey: "survey",
};
const TIER_TO_QUALITY: Record<string, string> = {
  measured: "Measured", estimated: "Estimated", "spend-based": "Spend-based", survey: "Survey",
};
const CONFIDENCE_TO_CODE: Record<string, "H" | "M" | "L"> = {
  "H — High": "H", "M — Medium": "M", "L — Low": "L",
};
const CODE_TO_CONFIDENCE: Record<string, string> = {
  H: "H — High", M: "M — Medium", L: "L — Low",
};

export function parseEntryNumber(value: string | undefined): number | null {
  const trimmed = (value ?? "").replace(/[,\s]/g, "").trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Row `scope` string for a category — granular ("3.1") for Scope 3, the bare scope for Scope 1/2. */
export const categoryRowScope = (category: EmissionCategory): string =>
  category.scope === "3" ? category.code : category.scope;

export function emissionEntryDraftToScopeRow(
  draft: EmissionEntryDraft,
  category: EmissionCategory,
  site: { id: string | null; label: string | null },
  factors: EntryFactorRef[],
  reportingMonths: string[],
): ScopeRowWriteFields {
  const spend = isSpendKind(category);
  const factor = factors.find((option) => option.id === draft.factorId) ?? null;
  const isClient = factor?.factorSource === "client";
  const monthly = draft.monthlyOpen
    ? reportingMonths.map((month) => ({ month, quantity: parseEntryNumber(draft.monthly[month]) }))
    : [];
  const label = draft.activity.trim() || draft.registration.trim() || draft.manualDetail.trim() || category.name;
  const noteParts = [
    draft.note.trim(),
    spend && draft.vatPercent.trim() ? `VAT ${draft.vatPercent.trim()}%` : "",
  ].filter(Boolean);
  return {
    scope: categoryRowScope(category),
    categoryCode: category.code,
    sourceLabel: label,
    reportLabel: label,
    assetIdentifier: draft.registration.trim() || null,
    siteId: site.id,
    siteLabel: site.label,
    purchasedGoodsCategoryId: spend ? draft.spendCategoryId || null : null,
    purchasedGoodsCategoryLabel: null,
    quantity: parseEntryNumber(draft.quantity),
    unit: spend ? "GBP" : draft.unit.trim() || null,
    monthlyActivity: monthly,
    datasetId: isClient ? null : factor?.datasetId ?? null,
    factorId: factor?.id ?? null,
    factorVersion: factor?.datasetVersion ?? null,
    factorLabel: factor?.label ?? null,
    factorSource: isClient ? "client" : "dataset",
    clientFactorId: isClient ? factor?.clientFactorId ?? null : null,
    isCustomEntry: isClient,
    qualityTier: QUALITY_TO_TIER[draft.qualityTier] ?? null,
    dataConfidence: CONFIDENCE_TO_CODE[draft.dataConfidence] ?? null,
    notes: noteParts.join(" · ") || null,
    columnText: spend ? draft.glCode.trim() || null : null,
    overrideTco2e: null,
    overrideReason: null,
  };
}

export function scopeRowToEmissionEntryDraft(
  row: ScopeRowReadModel,
): Partial<EmissionEntryDraft> & { title: string } {
  return {
    title: row.sourceLabel,
    activity: row.sourceLabel,
    quantity: row.quantity == null ? "" : String(row.quantity),
    unit: row.unit ?? "",
    registration: row.assetIdentifier ?? "",
    factorId: row.factorId ?? "",
    qualityTier: row.qualityTier ? TIER_TO_QUALITY[row.qualityTier] ?? "Measured" : "Measured",
    dataConfidence: row.dataConfidence ? CODE_TO_CONFIDENCE[row.dataConfidence] ?? "M — Medium" : "M — Medium",
    note: row.notes ?? "",
    spendCategoryId: row.purchasedGoodsCategoryId ?? "",
    glCode: row.columnText ?? "",
    monthlyOpen: (row.monthlyActivity?.length ?? 0) > 0,
    monthly: Object.fromEntries(
      (row.monthlyActivity ?? []).map((slot) => [slot.month, slot.quantity == null ? "" : String(slot.quantity)]),
    ),
  };
}
