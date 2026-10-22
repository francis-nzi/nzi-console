/**
 * What a client's portal offers them — the permission profile (portal data-entry phase 1; RULING-portal-dataentry-01,
 * decisions 2 and 3; BUILD-portal-dataentry-phase1 §1, §3).
 *
 * Defined once, here, and read by everything that needs it: the commands validate against it, the backend resolves the
 * effective profile from it, and Portal Management draws its controls from it. Migration 0176's CHECK holds the same
 * value sets, and a test pins the two together.
 *
 * ## The model
 * - **The org default** is `PORTAL_PROFILE_DEFAULT` — code, not a row (phase 1: the per-client decisions are what Portal
 *   Management needs; an editable organisation default can follow without changing this shape).
 * - **A client's decisions** overlay it, one per key, recorded as decisions in the `client_category_visibility` (NZC-110)
 *   pattern: a row only where somebody decided; withdrawing returns the key to the default.
 * - **History is not a setting.** It is always visible to the client — it is how the shared-write model stays honest — so
 *   it is not a key here and nothing can switch it off.
 * - **Scope and category on/off** are separate registers (0176 scope, 0096 category), composed by `categoryShown`.
 *
 * ## Two readers
 * The portal is told only what it may offer (`PortalOfferedProfile`): an area that is off is absent, never "hidden", and
 * nothing counts or names what was withheld. Staff are told the decisions themselves, so the CRM can answer "why does this
 * client see it differently?" (NZC-087).
 */

export const PORTAL_PROFILE_KEYS = [
  "setup", "time", "datasets", "milestones",
  "entryDrawer",
  "evidenceProvenance", "factorCalculation", "dataQuality", "sourceDetail",
  "deactivate",
] as const;
export type PortalProfileKey = (typeof PORTAL_PROFILE_KEYS)[number];

/**
 * Each key's own value set. Milestones is `view` or `hidden`, never `edit` (decision 3): a portal principal never edits a
 * milestone, whatever is configured.
 */
export const PORTAL_PROFILE_VALUES = {
  setup: ["visible", "hidden"],
  time: ["visible", "hidden"],
  datasets: ["visible", "hidden"],
  milestones: ["view", "hidden"],
  entryDrawer: ["simple", "detailed"],
  evidenceProvenance: ["visible", "hidden"],
  factorCalculation: ["visible", "hidden"],
  dataQuality: ["visible", "hidden"],
  sourceDetail: ["visible", "hidden"],
  deactivate: ["enabled", "disabled"],
} as const satisfies Record<PortalProfileKey, readonly string[]>;

export type PortalProfileValue<K extends PortalProfileKey = PortalProfileKey> = (typeof PORTAL_PROFILE_VALUES)[K][number];
export type PortalProfile = { [K in PortalProfileKey]: PortalProfileValue<K> };

/** The org default: what a client gets with no decision recorded (ruling, decision 2). */
export const PORTAL_PROFILE_DEFAULT: PortalProfile = Object.freeze({
  setup: "hidden",
  time: "hidden",
  datasets: "hidden",
  milestones: "view",
  entryDrawer: "simple",
  evidenceProvenance: "hidden",
  factorCalculation: "hidden",
  dataQuality: "hidden",
  sourceDetail: "hidden",
  deactivate: "disabled",
});

export type PortalProfileGroup = "areas" | "entry" | "rowSections" | "actions";
/** How Portal Management names and groups each key. */
export const PORTAL_PROFILE_LABELS: Record<PortalProfileKey, { group: PortalProfileGroup; label: string; hint: string }> = {
  setup: { group: "areas", label: "Setup", hint: "The job's setup area." },
  time: { group: "areas", label: "Time", hint: "Time recorded on the job." },
  datasets: { group: "areas", label: "Datasets (add and edit)", hint: "Adding and editing the job's datasets." },
  milestones: { group: "areas", label: "Milestones", hint: "View-only at most: the client never edits a milestone." },
  entryDrawer: { group: "entry", label: "Entry drawer", hint: "The simple first-entry drawer, or the detailed row drawer." },
  evidenceProvenance: { group: "rowSections", label: "Evidence & provenance", hint: "In the detailed row drawer." },
  factorCalculation: { group: "rowSections", label: "Factor & calculation", hint: "In the detailed row drawer." },
  dataQuality: { group: "rowSections", label: "Data quality", hint: "In the detailed row drawer." },
  sourceDetail: { group: "rowSections", label: "Source detail", hint: "In the detailed row drawer." },
  deactivate: { group: "actions", label: "Deactivate a row", hint: "The deactivate action on a row." },
};
export const PORTAL_PROFILE_VALUE_LABELS: Record<string, string> = {
  visible: "Shown", hidden: "Hidden", view: "View only", simple: "Simple", detailed: "Detailed", enabled: "Enabled", disabled: "Disabled",
};
export const PORTAL_PROFILE_GROUP_LABELS: Record<PortalProfileGroup, string> = {
  areas: "Areas", entry: "Entry", rowSections: "Detailed row drawer — sections", actions: "Actions",
};

export const isPortalProfileKey = (value: unknown): value is PortalProfileKey => typeof value === "string" && (PORTAL_PROFILE_KEYS as readonly string[]).includes(value);
export function isPortalProfileValue<K extends PortalProfileKey>(key: K, value: unknown): value is PortalProfileValue<K> {
  return typeof value === "string" && (PORTAL_PROFILE_VALUES[key] as readonly string[]).includes(value);
}

/** The default overlaid with the client's active decisions. A decision the key does not understand is ignored, never guessed. */
export function resolvePortalProfile(decisions: ReadonlyArray<{ profileKey: string; value: string }>): PortalProfile {
  const profile: Record<string, string> = { ...PORTAL_PROFILE_DEFAULT };
  for (const decision of decisions) {
    if (isPortalProfileKey(decision.profileKey) && isPortalProfileValue(decision.profileKey, decision.value)) profile[decision.profileKey] = decision.value;
  }
  return profile as PortalProfile;
}

/**
 * The portal's reading: only what it may offer. Absent means not offered; nothing says "hidden", and nothing counts what
 * was withheld (NZC-110's discipline, applied to every toggle). Milestones, when offered, are view-only by definition.
 */
export type PortalOfferedProfile = {
  areas: Array<"setup" | "time" | "datasets" | "milestones">;
  entryDrawer: "simple" | "detailed";
  rowSections: Array<"evidenceProvenance" | "factorCalculation" | "dataQuality" | "sourceDetail">;
  actions: Array<"deactivate">;
};
export function offeredPortalProfile(profile: PortalProfile): PortalOfferedProfile {
  return {
    areas: (["setup", "time", "datasets", "milestones"] as const).filter((key) => profile[key] === "visible" || profile[key] === "view"),
    entryDrawer: profile.entryDrawer,
    rowSections: (["evidenceProvenance", "factorCalculation", "dataQuality", "sourceDetail"] as const).filter((key) => profile[key] === "visible"),
    actions: profile.deactivate === "enabled" ? ["deactivate"] : [],
  };
}

export const PORTAL_SCOPES = ["1", "2", "3"] as const;
export type PortalScope = (typeof PORTAL_SCOPES)[number];
export const isPortalScope = (value: unknown): value is PortalScope => typeof value === "string" && (PORTAL_SCOPES as readonly string[]).includes(value);
export const PORTAL_SCOPE_LABELS: Record<PortalScope, string> = { "1": "Scope 1 — direct", "2": "Scope 2 — purchased energy", "3": "Scope 3 — value chain" };

/**
 * The composition rule, defined once (BUILD §3): a category is shown to the client only when its scope is not hidden AND
 * the category itself is not hidden. A hidden scope hides every category in it without a row per category.
 */
export function categoryShown(category: { categoryCode: string; scope: string }, hidden: { scopes: ReadonlySet<string>; categories: ReadonlySet<string> }): boolean {
  return !hidden.scopes.has(category.scope) && !hidden.categories.has(category.categoryCode);
}

/** A recorded decision, as staff see it. */
export type PortalDecisionRecord<V> = { value: V; note: string; decidedBy: string; decidedByName: string | null; decidedAt: string };

/** The staff reading: the default, the decision (if any) and the effective result, per key, scope and category. */
export type PortalProfileStaffView = {
  clientId: string;
  profile: Array<{
    key: PortalProfileKey; group: PortalProfileGroup; label: string; hint: string;
    values: readonly string[]; defaultValue: string; effectiveValue: string;
    decision: PortalDecisionRecord<string> | null;
  }>;
  scopes: Array<{
    scope: PortalScope; label: string; effectiveVisible: boolean;
    decision: PortalDecisionRecord<boolean> | null;
    categories: Array<{
      categoryCode: string; name: string;
      /** The client sees it: its scope is on and it is not hidden itself. */
      shown: boolean;
      /** Why not, when not: the scope's switch takes precedence in the explanation, as it does in the rule. */
      hiddenBy: "scope" | "category" | null;
      decision: PortalDecisionRecord<boolean> | null;
    }>;
  }>;
};

/** What differs from the default, in words — the staff preview's "why does this client see it differently?". */
export function portalProfileDifferences(view: PortalProfileStaffView): string[] {
  const lines: string[] = [];
  for (const entry of view.profile) {
    if (entry.effectiveValue !== entry.defaultValue) lines.push(`${entry.label}: ${PORTAL_PROFILE_VALUE_LABELS[entry.effectiveValue] ?? entry.effectiveValue} (default ${PORTAL_PROFILE_VALUE_LABELS[entry.defaultValue] ?? entry.defaultValue})`);
  }
  for (const scope of view.scopes) {
    if (!scope.effectiveVisible) lines.push(`${scope.label}: hidden, with every category in it`);
    for (const category of scope.categories) if (category.hiddenBy === "category") lines.push(`${category.name}: hidden`);
  }
  return lines;
}
