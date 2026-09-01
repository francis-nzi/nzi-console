// UX1a — the one shared data-entry field order (NZC-046 / DATA_ENTRY_UX.md §3–§4).
// Pure spec: given a category + audience + mode, return the canonical field
// sequence and the action set. `EmissionEntryForm.tsx` renders this verbatim so
// the CRP workspace and the client portal are provably the same capture process
// (the portal is a constrained mirror — same order, fewer fields).
import type { EmissionCategory } from "@nzi/contracts";
import { scopeMeta } from "@nzi/contracts";

export type EntryAudience = "crm" | "portal";
export type EntryMode = "new" | "existing";

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
