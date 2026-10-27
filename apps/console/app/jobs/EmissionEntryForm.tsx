"use client";
// UX1a — the one shared capture component (NZC-046 / DATA_ENTRY_UX.md §3).
// Renders the governed input spec (NZC-102) so the CRP workspace and the client
// portal are the same process: identical field order, progressive disclosure keyed
// on the category kind, the portal a constrained mirror that never shows the
// factor / quality / confidence / lineage fields. Endpoint wiring is the caller's
// job (UX1b CRP accordion, UX1d portal accordion) — this component is presentational.
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  emissionCategoryTaxonomy, ENTRY_BASES, ENTRY_BASIS_LABEL, openingEntryBasis, openingEntryBasisSource, renderInputSpec, routeSpendLine,
  spendCategoryOf, spendRoutingLabel, spendValueLabel, SUPPLY_SOURCES, SUPPLY_SOURCE_LABELS, vatAppliesByDefault,
  type EntryBasis, type InputSpecCategory, type JobEntryBasis,
} from "@nzi/contracts";
import type { EmissionCategory } from "@nzi/contracts";
import {
  draftBasis,
  emissionEntryActions,
  factorsForBasis,
  fieldsForBasis,
  isRegistrationKind,
  isSpendFactor,
  matchFactorByActivity,
  openingCurrency,
  spendCurrencies,
  quickAddSaveIssue,
  factorOptionText,
  searchActivityOptions,
  needsOverrideReason,
  seedWithDeclared,
  type DeclaredOption,
  type EmissionEntryDraft,
  type EmissionEntryLineageStep,
  type EntryAudience,
  type EntryFactorOption,
  type EntryMode,
  type RegistrationLookupOutcome,
  vehicleLookupPatch,
} from "./emissionEntryModel";

export * from "./emissionEntryModel";

export type EmissionEntryFormProps = {
  /**
   * The governed spec for this category (NZC-102), loaded server-side and passed down. Null when
   * the spec could not be read — the form then renders no fields rather than falling back to a
   * second definition of them, because a fallback is the dual source this replaced.
   */
  spec: InputSpecCategory | null;
  category: EmissionCategory;
  audience: EntryAudience;
  /** Site is context (§2) — chosen at the top of data entry, shown here read-only. */
  site: { id: string | null; label: string };
  /** Scope + category-scoped factor set, already filtered by the caller. */
  factors: EntryFactorOption[];
  units: string[];
  reportingMonths: string[];
  spendCategories?: { id: string; name: string }[];
  entry?: (Partial<EmissionEntryDraft> & { title?: string }) | null;
  lineage?: EmissionEntryLineageStep[];
  provenance?: { label: string; value: string }[];
  busy?: boolean;
  error?: string;
  notice?: string;
  /** DA4 (NZC-058), behind `entry-lean-capture` — core-fields-only new-entry capture. */
  leanCapture?: boolean;
  onSubmit: (draft: EmissionEntryDraft) => void | Promise<void>;
  onSaveDraft?: (draft: EmissionEntryDraft) => void | Promise<void>;
  onCancel: () => void;
  onReject?: () => void | Promise<void>;
  onApprove?: () => void | Promise<void>;
  /**
   * Dedup slice 2 (0171): the organisation's active usage types, for the spec's `usageType` field. Only the consultant's data
   * entry passes them; without them the field is not drawn (the spec offers it to `crm` only, and the portal never reads the
   * staff vocabulary).
   */
  usageTypes?: Array<{ id: string; label: string }>;
  /** Two-step DVLA lookup: resolve a registration to a vehicle spec (+ a suggested factor for CRM). */
  onLookupRegistration?: (registration: string) => Promise<RegistrationLookupOutcome>;
  /** JW-13 — open the job's datasets (the Setup stage may be collapsed, so a plain link would land nowhere). */
  onOpenDatasets?: () => void;
  /**
   * The category's declared factor for this entry, when its category resolves declaratively (Stop 2b). A new entry
   * starts on it, with its unit shown before a quantity is typed; choosing a different factor asks why.
   */
  declared?: DeclaredOption | null;
  /**
   * Portal data-entry phase 2: the client's Data view writes the job's own scope row on save (pending staff review), not a
   * staged record — one action, and the hint says so.
   */
  portalDirect?: boolean;
  /**
   * Data entry D1 (R4): the job's basis settings — the organisation's default per category, this client's last choice per
   * category, and the client's currency. A fresh entry opens on the client's choice, else the default, else the seed (PG&S =
   * Spend, the rest Activity). Fetched as the drawer opens, so it may arrive after the first render; it moves the toggle only
   * until somebody touches it.
   */
  entryBasis?: JobEntryBasis | null;
  /**
   * D1 (R5): a basis the caller fixes — the portal's bucket flow, whose authorised source already says activity or spend. The
   * toggle still shows, on that basis, with the other disabled; nothing about the bucket flow changes.
   */
  basisLocked?: EntryBasis;
  /**
   * D2 (R2): every factor the job offers, with its scope — so a spend line allocated to a category in another scope (fuel to
   * Company Vehicles from a PG&S drawer) can be priced with a spend factor of that scope. Without it, allocation stays in scope.
   */
  allFactors?: Array<EntryFactorOption & { scope?: "1" | "2" | "3" }>;
};

/** The fields that belong to a basis (D1, R1): set aside when the toggle moves off it, restored when it comes back. */
const BASIS_BLOCK_FIELDS = [
  "activity", "quantity", "unit", "factorId", "factorOverrideReason", "registration", "manualMode", "manualDetail", "usageTypeId",
  "supplySource", "assertedVehicleAttributes", "vatPercent", "glCode", "spendCategoryId", "currency", "qualityTier", "allocateTo",
] as const satisfies ReadonlyArray<keyof EmissionEntryDraft>;
type BasisBlock = Pick<EmissionEntryDraft, (typeof BASIS_BLOCK_FIELDS)[number]>;

/** Why the drawer opened where it did (R4) — said once, until the toggle is moved. */
const openingBasisNote = (source: "client" | "organisation" | "seed", basis: EntryBasis, audience: EntryAudience): string =>
  source === "client"
    ? `Opened on ${ENTRY_BASIS_LABEL[basis]} — ${audience === "portal" ? "how you last recorded" : "how this client last recorded"} an entry here.`
    : `Opened on ${ENTRY_BASIS_LABEL[basis]} — the default for this category.`;

const QUALITY_TIERS = ["Measured", "Estimated", "Spend-based", "Survey"] as const;
const DATA_CONFIDENCE = ["H — High", "M — Medium", "L — Low"] as const;
const CLIENT_FACTOR_OPTION = "__client_factor__";

const monthLabel = (key: string) => {
  const parsed = new Date(`${key}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? key
    : parsed.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
};

// DA4 (NZC-058) — a lean-captured row leaves quality tier / data confidence
// genuinely unset (mapped to null by emissionEntryDraftToScopeRow) rather than
// silently defaulting, so the existing QA_INCOMPLETE / Approve gates still
// force the consultant to set them for real in the row's evidence panel —
// deferred, not skipped.
const blankDraft = (units: string[], seed?: Partial<EmissionEntryDraft> | null, lean = false): EmissionEntryDraft => ({
  activity: seed?.activity ?? "",
  quantity: seed?.quantity ?? "",
  unit: seed?.unit ?? units[0] ?? "",
  vatPercent: seed?.vatPercent ?? "",
  glCode: seed?.glCode ?? "",
  spendCategoryId: seed?.spendCategoryId ?? "",
  registration: seed?.registration ?? "",
  usageTypeId: seed?.usageTypeId ?? "",
  manualMode: seed?.manualMode ?? false,
  manualDetail: seed?.manualDetail ?? "",
  factorId: seed?.factorId ?? "",
  qualityTier: seed?.qualityTier ?? (lean ? "" : QUALITY_TIERS[0]),
  dataConfidence: seed?.dataConfidence ?? (lean ? "" : DATA_CONFIDENCE[1]),
  supplySource: seed?.supplySource ?? "",
  factorOverrideReason: seed?.factorOverrideReason ?? "",
  note: seed?.note ?? "",
  monthlyOpen: seed?.monthlyOpen ?? false,
  monthly: seed?.monthly ?? {},
});

export function EmissionEntryForm(props: EmissionEntryFormProps) {
  const { spec, category, audience, site, factors, units, reportingMonths, spendCategories = [], entry, lineage = [], provenance = [], leanCapture = false } = props;
  const mode: EntryMode = entry ? "existing" : "new";
  const lean = leanCapture && audience === "crm" && mode === "new";
  // D1 (R1, R2): Spend can be chosen where the category has a spend factor — one priced per a currency — among its options.
  const spendAvailable = props.basisLocked === "spend" || factors.some(isSpendFactor);
  const openingFor = (settings: JobEntryBasis | null | undefined): EntryBasis => props.basisLocked ?? openingEntryBasis({
    categoryCode: category.code, clientChoice: settings?.choices[category.code], organisationDefault: settings?.defaults[category.code], spendAvailable });
  // A new block for a basis: empty, in the client's currency for spend, the declared factor for activity, and the quality tier
  // spend implies (staff only — the portal never sets one).
  const freshBlock = (basis: EntryBasis, current: EmissionEntryDraft): BasisBlock => ({
    activity: "", quantity: "", unit: basis === "spend" ? "" : units[0] ?? "", factorId: "", factorOverrideReason: "", registration: "",
    manualMode: false, manualDetail: "", usageTypeId: current.usageTypeId === undefined ? undefined : "", supplySource: "",
    assertedVehicleAttributes: null, vatPercent: "", glCode: "", spendCategoryId: "",
    currency: basis === "spend" ? openingCurrency(factors, props.entryBasis?.currency, site.id ? props.entryBasis?.siteCurrencies?.[site.id] : null) : undefined,
    qualityTier: basis === "spend" && audience === "crm" ? "Spend-based" : lean ? "" : QUALITY_TIERS[0],
  });
  const [draft, setDraft] = useState<EmissionEntryDraft>(() => {
    const seeded = blankDraft(units, entry, lean);
    if (entry) return { ...seeded, basis: props.basisLocked ?? draftBasis(seeded, category) };
    const basis = openingFor(props.entryBasis);
    return basis === "spend" ? { ...seeded, ...freshBlock("spend", seeded), basis } : { ...seeded, basis };
  });
  const basis = draftBasis(draft, category);
  const spend = basis === "spend";
  // Whether a person has moved the toggle; until then the job's settings (which may arrive late) decide where it sits.
  const basisTouched = useRef(mode === "existing");
  const stashed = useRef<Partial<Record<EntryBasis, BasisBlock>>>({});
  const declaredAny = mode === "new" ? props.declared ?? null : null;
  // The declared factor is an activity factor (or, on a spend category, a spend one): it applies on its own basis only.
  const declared = declaredAny && isSpendFactor({ unit: declaredAny.unit }) === spend ? declaredAny : null;
  const [localError, setLocalError] = useState("");
  // The preview arrives after the form opens. It fills an empty choice only — never one a person already made.
  useEffect(() => {
    if (declaredAny) setDraft(current => (isSpendFactor({ unit: declaredAny.unit }) === (draftBasis(current, category) === "spend") ? seedWithDeclared(current, declaredAny) : current));
  }, [declaredAny, category]);
  const divergent = needsOverrideReason(draft, declared);

  // D1 (R1): only the basis block swaps. What was entered on the basis being left is set aside, and comes back if the toggle
  // does; site, period, notes and the rest of the entry are not touched.
  const switchBasis = (next: EntryBasis, chosen = true) => {
    if (chosen) basisTouched.current = true;
    setDraft(current => {
      const from = draftBasis(current, category);
      if (from === next) return current;
      stashed.current[from] = Object.fromEntries(BASIS_BLOCK_FIELDS.map(key => [key, current[key]])) as BasisBlock;
      const block = stashed.current[next] ?? freshBlock(next, current);
      const restored = { ...current, ...block, basis: next };
      return next === "activity" && declaredAny && !isSpendFactor({ unit: declaredAny.unit }) ? seedWithDeclared(restored, declaredAny) : restored;
    });
    setLookup({ state: "idle" });
    setSearchOpen(false);
  };
  // The job's settings arrive after the drawer opens: they place the toggle until somebody moves it, and Spend is never kept
  // where the options say it cannot be chosen.
  useEffect(() => {
    if (mode !== "new" || props.basisLocked) return;
    if (!basisTouched.current) switchBasis(openingFor(props.entryBasis), false);
    else if (!spendAvailable && draftBasis(draft, category) === "spend") switchBasis("activity", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entryBasis, spendAvailable]);
  // The options this basis may pick from: spend factors in the entry's currency, or activity factors. A locked basis (the
  // portal's bucket) keeps its authorised list exactly as it was.
  // D2 (R2): where a spend line is filed. The client's map routes it by its GL code, else its description — shown, and applied
  // until a person chooses otherwise ("allocate elsewhere"). An unmapped line stays in the drawer's own category: the person chose
  // it. The bucket flow (locked) never moves a line.
  const allocationTouched = useRef(false);
  // D3 (R1): the site's currency arrives with the job's settings, after the drawer opens. It is applied to a fresh spend line until
  // somebody chooses a currency.
  const currencyTouched = useRef(false);
  const siteCurrency = site.id ? props.entryBasis?.siteCurrencies?.[site.id] ?? null : null;
  useEffect(() => {
    if (mode !== "new" || !spend || props.basisLocked || currencyTouched.current || !siteCurrency || draft.currency === siteCurrency) return;
    setDraft(current => ({ ...current, currency: siteCurrency, factorId: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteCurrency, spend]);
  const mapRouting = spend && !props.basisLocked && props.entryBasis?.allocations?.length
    ? routeSpendLine(props.entryBasis.allocations, { glCode: draft.glCode, description: draft.activity }) : null;
  const mapped = mapRouting && mapRouting.by !== "residual" ? mapRouting : null;
  const filedCode = spend && draft.allocateTo ? draft.allocateTo : category.code;
  const filedCategory = spendCategoryOf(filedCode) ?? category;
  const filedFactors = filedCode === category.code || !props.allFactors ? factors
    : props.allFactors.filter(option => (option.scope ?? category.scope) === filedCategory.scope);
  useEffect(() => {
    if (!spend || props.basisLocked || allocationTouched.current) return;
    const target = mapped && mapped.categoryCode !== category.code ? mapped.categoryCode : undefined;
    if (target === draft.allocateTo) return;
    setDraft(current => {
      // The map's default spend factor fills an empty choice — never one a person already made.
      const option = mapped?.defaultFactorId ? (props.allFactors ?? factors).find(entry => entry.id === `dataset:${mapped.defaultDatasetId}|${mapped.defaultFactorId}`) : undefined;
      return { ...current, allocateTo: target, ...(option && !current.factorId ? { factorId: option.id, currency: option.unit ?? current.currency } : {}) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapped?.categoryCode, mapped?.allocationId, spend]);
  // R6: VAT-applies from the map entry that routed the line, else the category it is filed in (Investments takes none).
  const vatApplies = mapped && mapped.categoryCode === filedCode ? mapped.vatApplies : vatAppliesByDefault(filedCode);
  useEffect(() => { if (spend && !vatApplies && draft.vatPercent) setDraft(current => ({ ...current, vatPercent: "" })); }, [spend, vatApplies, draft.vatPercent]);
  // The categories a spend line can be allocated to: those whose scope has a spend factor the job offers.
  const allocatable = spend && !props.basisLocked ? emissionCategoryTaxonomy.filter(entry => entry.code === category.code
    || (props.allFactors ?? factors).some(option => isSpendFactor(option) && ((option as { scope?: string }).scope ?? category.scope) === entry.scope)) : [];
  const basisFactors = props.basisLocked ? factors : factorsForBasis(filedFactors, basis, spend ? draft.currency : null);
  const currencies = [...new Set([...spendCurrencies(filedFactors), ...(draft.currency ? [draft.currency] : [])])];
  const [lookup, setLookup] = useState<
    | { state: "idle" }
    | { state: "loading" }
    | { state: "done"; result: Extract<RegistrationLookupOutcome, { ok: true }> }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const listId = useId();

  // The fields are read from the governed spec (NZC-102), not built in code. `spec` is loaded
  // server-side and passed down; when it is absent the form renders nothing rather than falling
  // back to a second definition — a fallback would be the dual source this migration removes.
  // D1: laid out for the basis the toggle is on — the spec's own layout at the category's native basis (fieldsForBasis).
  const fields = useMemo(
    () => (spec ? fieldsForBasis(renderInputSpec(spec, audience, mode, leanCapture), category, basis) : []),
    [spec, audience, mode, leanCapture, category, basis]);
  const actions = useMemo(() => emissionEntryActions(audience, mode, props.portalDirect === true), [audience, mode, props.portalDirect]);
  const reg = isRegistrationKind(category);
  const scopedTo = `Scope ${category.scope} · ${category.name}`;

  const patch = (next: Partial<EmissionEntryDraft>) => setDraft(current => ({ ...current, ...next }));
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  // Suggestions show as soon as the box has focus (JW-13) — the first few of the category's options, narrowed as you type.
  const searchResults = searchActivityOptions(basisFactors, draft.activity);
  // CRM only: the portal's options are its bucket's, and an empty bucket is the consultant's to fix, not the client's.
  const noFactors = audience === "crm" && factors.length === 0;
  // A pick is the only way an activity is accepted: it sets the activity, its factor and that factor's unit (on spend, the
  // factor's currency is the entry's).
  const pickActivity = (option: (typeof factors)[number]) => {
    patch({ activity: option.label, factorId: option.id, ...(spend ? { currency: option.unit ?? draft.currency } : { unit: option.unit ?? draft.unit }),
      factorOverrideReason: declared && option.id === declared.optionId ? "" : draft.factorOverrideReason });
    setSearchOpen(false);
  };
  const setMonth = (key: string, value: string) => patch({ monthly: { ...draft.monthly, [key]: value } });

  const runLookup = async () => {
    const plate = draft.registration.trim();
    if (!plate || !props.onLookupRegistration) return;
    setLookup({ state: "loading" });
    try {
      const outcome = await props.onLookupRegistration(plate);
      setLookup(outcome.ok ? { state: "done", result: outcome } : { state: "error", message: outcome.message });
    } catch {
      setLookup({ state: "error", message: "Vehicle lookup failed — enter it manually." });
    }
  };
  // Activity takes the suggested factor's label (type · size · fuel), never the make — see vehicleLookupPatch.
  const applyLookup = (result: Extract<RegistrationLookupOutcome, { ok: true }>) => {
    patch(vehicleLookupPatch(draft, result, basisFactors, declared));
    setLookup({ state: "idle" });
  };

  const run = (key: string) => {
    if (props.busy) return;
    // A factor other than the declared one needs its reason before it goes anywhere; the server refuses it anyway.
    if ((key === "submit" || key === "save" || key === "saveDraft") && divergent && !draft.factorOverrideReason.trim()) {
      setLocalError("Say why this factor was chosen instead of the one declared for this category.");
      return;
    }
    // JW-9 — a CRM entry needs a real factor (the quantity may wait) and typed text is never saved as an activity.
    const issue = key === "save" || key === "saveDraft" ? quickAddSaveIssue(draft, basisFactors, category, audience) : null;
    if (issue) { setLocalError(issue); return; }
    setLocalError("");
    if (key === "submit") return void props.onSubmit(draft);
    if (key === "save") return void props.onSubmit(draft);
    if (key === "saveDraft") return void props.onSaveDraft?.(draft);
    if (key === "reject") return void props.onReject?.();
    if (key === "approve") return void props.onApprove?.();
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(audience === "portal" ? "submit" : mode === "existing" ? "approve" : "save");
  };

  return (
    <form className="nz-ef" aria-label={`${category.name} — ${mode === "new" ? "new entry" : entry?.title ?? "entry"}`} onSubmit={onFormSubmit}>
      {props.error || localError ? <div className="nz-banner warn" role="alert">{props.error || localError}</div> : null}
      {props.notice ? <div className="nz-banner ok" role="status">{props.notice}</div> : null}

      {/* D1 (R1): the first decision on every drawer. Only the basis block below it swaps. */}
      <div className="nz-ef-basis">
        <span className="nz-eyebrow" id={`${listId}-basis`}>How is this measured?</span>
        <div className="nz-seg" role="radiogroup" aria-labelledby={`${listId}-basis`}>
          {ENTRY_BASES.map(option => (
            <button key={option} type="button" role="radio" aria-checked={basis === option} className={basis === option ? `on ${option}` : option}
              disabled={props.busy || (props.basisLocked ? option !== props.basisLocked : option === "spend" && !spendAvailable)}
              onClick={() => switchBasis(option)}>{ENTRY_BASIS_LABEL[option]}</button>
          ))}
        </div>
        {props.basisLocked ? <span className="nz-hint">This source is recorded as {ENTRY_BASIS_LABEL[props.basisLocked].toLowerCase()}.</span>
          : !spendAvailable ? <span className="nz-hint nz-ef-basis-note">Spend isn&rsquo;t available here: no spend factor is {audience === "crm" ? `selected for ${category.name} in this job's datasets` : `offered for ${category.name}`}.</span>
          : spend ? <span className="nz-hint">Spend value, currency and VAT — priced with a spend factor.</span>
          : <span className="nz-hint">Physical units — no currency, no VAT.</span>}
        {mode === "new" && !props.basisLocked && !basisTouched.current && props.entryBasis ? (
          <span className="nz-hint nz-ef-basis-source">{openingBasisNote(openingEntryBasisSource({ clientChoice: props.entryBasis.choices[category.code], organisationDefault: props.entryBasis.defaults[category.code] }), basis, audience)}</span>
        ) : null}
      </div>

      {fields.map(field => {
        switch (field.control) {
          case "banner":
            return (
              <div key={field.key} className="nz-banner ok nz-ef-sitebanner" role="note">
                <span>Site: <b>{site.label}</b> — this entry is allocated here.
                  <span className="chip">↦ change on the row if needed</span></span>
              </div>
            );

          case "registration":
            return (
              <fieldset key={field.key} style={{ border: 0, padding: 0, margin: 0 }}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-ef-reg">
                  <label className="nz-fl">Registration (DVLA lookup)
                    <input className="nz-plate" placeholder="AB12 CDE" value={draft.registration}
                      onChange={event => { patch({ registration: event.target.value.toUpperCase(), assertedVehicleAttributes: null }); setLookup({ state: "idle" }); }} />
                  </label>
                  <button type="button" className="nz-btn" disabled={props.busy || lookup.state === "loading" || draft.registration.trim() === "" || !props.onLookupRegistration}
                    onClick={() => void runLookup()}>{lookup.state === "loading" ? "Looking up…" : "Look up"}</button>
                </div>
                {lookup.state === "error" ? <p className="nz-hint bad" role="alert">{lookup.message}</p> : null}
                {lookup.state === "done" ? (
                  <div className="nz-banner ok" role="status" style={{ margin: "6px 0", display: "block" }}>
                    <b>{[lookup.result.make, lookup.result.fuelType, lookup.result.year].filter(Boolean).join(" · ") || "Vehicle found"}</b>
                    {/* JW-11: what the vehicle is in the factor library's terms ("Small car · Petrol"), else its class. */}
                    {" — "}{lookup.result.classification ?? lookup.result.suggestedClass ?? "vehicle"}
                    {/* The band and what it was read from, so a wrong size is visible before it is used. */}
                    {lookup.result.sizeBasis ? <div className="nz-hint nz-lookup-size">{lookup.result.sizeBasis}
                      {audience === "crm" ? " — not right? Pick another size from the activities below." : "."}</div> : null}
                    {audience === "crm" && lookup.result.factorLabel ? <div className="nz-hint">Suggested factor: {lookup.result.factorLabel}</div> : null}
                    {audience === "crm" && !lookup.result.factorLabel ? <div className="nz-hint">No factor matched — pick one below.</div> : null}
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button type="button" className="nz-btn pri" onClick={() => applyLookup(lookup.result)}>Use this</button>
                      <button type="button" className="nz-btn" onClick={() => { setLookup({ state: "idle" }); patch({ manualMode: true, assertedVehicleAttributes: null }); }}>Not right — enter manually</button>
                    </div>
                  </div>
                ) : null}
                <p className="nz-ef-manual-link">
                  …or <button type="button" onClick={() => patch({ manualMode: !draft.manualMode })}>enter manually</button> ({(spec?.manualEntryHint ?? "")}).
                </p>
                {draft.manualMode ? (
                  <label className="nz-fl">
                    {category.kind === "commuting" ? "Mode / WFH" : category.kind === "travel" ? "Travel type" : "Make · model · fuel"}
                    <input className="nz-inp" value={draft.manualDetail} onChange={event => patch({ manualDetail: event.target.value })}
                      placeholder={category.kind === "commuting" ? "e.g. Car — diesel, 2 WFH days" : category.kind === "travel" ? "e.g. Air — short haul" : "e.g. Ford Transit, diesel"} />
                  </label>
                ) : null}
              </fieldset>
            );

          case "smart-search":
            // JW-9 — a combobox, not a datalist: the list is a suggestion, only a pick sets the activity and its
            // factor, and Enter picks the highlighted option or does nothing — it never submits the form (the
            // keyboard handling is TemplateSearchBar's). Saving is then held to quickAddSaveIssue.
            return (
              <div key={field.key} className="nz-fl nz-fast-add-search">
                <label className="nz-fl" style={{ margin: 0 }}>{field.label} <span className="muted">· smart search</span>
                  <input className="nz-inp" role="combobox" aria-expanded={searchOpen} aria-controls={listId} aria-autocomplete="list"
                    value={draft.activity}
                    placeholder={spend ? "Search suppliers / ledger…" : "Search this category’s activities…"}
                    onFocus={() => setSearchOpen(true)}
                    // Not closed on blur: the list sits in the form's flow, so closing it as focus leaves would move
                    // the buttons below it out from under the pointer mid-click. A pick or Escape closes it; a
                    // "no match" note left open is the feedback that the typed text is not an activity.
                    onKeyDown={event => {
                      if (event.key === "ArrowDown") { event.preventDefault(); setSearchOpen(true); setHighlighted(i => Math.min(i + 1, searchResults.length - 1)); }
                      else if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted(i => Math.max(i - 1, 0)); }
                      else if (event.key === "Enter") { event.preventDefault(); const picked = searchOpen ? searchResults[highlighted] : undefined; if (picked) pickActivity(picked); }
                      else if (event.key === "Escape") setSearchOpen(false);
                    }}
                    onChange={event => {
                      const activity = event.target.value;
                      setSearchOpen(true); setHighlighted(0);
                      // DA4 — lean capture auto-matches the factor from an exact
                      // activity pick instead of a separate required select. The
                      // matched factor also fixes the unit (its dataset activity
                      // unit) — the user never picks it.
                      if (lean) {
                        const matched = matchFactorByActivity(activity, basisFactors);
                        // An activity that names no factor keeps the declared one rather than clearing it (Stop 2b).
                        // A spend entry's unit is its currency, so a match on spend leaves the unit alone.
                        patch({ activity, factorId: matched?.id ?? declared?.optionId ?? "", ...(spend ? {} : { unit: matched?.unit ?? declared?.unit ?? draft.unit }) });
                      } else patch({ activity });
                    }} />
                </label>
                {/* JW-13: no factors at all is not a search that found nothing — it is a job with no datasets selected for
                    this category. Say so, and where to fix it, rather than showing an empty list. */}
                {noFactors ? (
                  <div className="nz-banner warn" role="status">
                    <div>No {category.name} factors are available for this job — select its reporting datasets in Setup.{" "}
                      {props.onOpenDatasets
                        ? <button type="button" className="nz-btn" style={{ marginTop: 6 }} onClick={props.onOpenDatasets}>Open the job&rsquo;s datasets</button>
                        : <a href="#job-datasets">Open the job&rsquo;s datasets</a>}</div>
                  </div>
                ) : searchOpen ? (
                  <ul className="nz-template-results" id={listId} role="listbox">
                    {searchResults.length === 0 ? <li className="nz-template-empty">No {filedCategory.name} {spend ? "spend factor" : "activity"} matches “{draft.activity.trim()}”.</li> : null}
                    {searchResults.map((option, index) => (
                      <li key={option.id}>
                        <button type="button" role="option" aria-selected={index === highlighted} className={index === highlighted ? "on" : ""}
                          onMouseEnter={() => setHighlighted(index)}
                          // Picked on mouse-down, before the input's blur closes the list.
                          onMouseDown={event => { event.preventDefault(); pickActivity(option); }}>
                          <b>{option.label}</b>
                          {/* DATASET-CURRENCY §2: which dataset this factor is from, before it is chosen. */}
                          {option.provenance ? <span className="nz-template-meta nz-factor-provenance">{option.provenance}{option.preferred ? <span className="nz-st done" style={{ marginLeft: 6 }}>Preferred</span> : null}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <span className="nz-hint">{field.hint}</span>
              </div>
            );

          case "number":
            // D1 (R3): on spend, the value is money — its currency and a single VAT % sit with it, and nowhere on activity.
            return field.key === "quantity" && spend ? (
              <div key={field.key} className="nz-ef-spend">
                <div className="nz-ef-two">
                  {/* D3 (R1): the value's label follows its currency — "Net value (£)" in EUR reads "Net value (€)". */}
                  <label className="nz-fl">{spendValueLabel(field.label, draft.currency)}
                    <input className="nz-inp" inputMode="decimal" value={draft.quantity} placeholder="e.g. 4,100"
                      onChange={event => patch({ quantity: event.target.value })} />
                  </label>
                  <label className="nz-fl">Currency
                    <select className="nz-sel" value={draft.currency ?? ""} aria-label="Currency"
                      onChange={event => {
                        const currency = event.target.value;
                        currencyTouched.current = true;
                        // A factor priced in another currency cannot price this entry: it is cleared, never converted — FX never
                        // enters the emissions (D3, R1).
                        const kept = basisFactors.find(option => option.id === draft.factorId)?.unit === currency;
                        patch({ currency, ...(kept ? {} : { factorId: "" }) });
                      }}>
                      {(currencies.length ? currencies : ["GBP"]).map(code => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </label>
                </div>
                {/* D3 (R1), local-first: a line is priced by a factor in its own currency, or not at all — never converted. */}
                {!props.basisLocked && draft.currency && !spendCurrencies(filedFactors).includes(draft.currency) ? (
                  <p className="nz-hint nz-ef-nofactor">No spend factor is priced in {draft.currency} in this job&rsquo;s datasets. Select the country&rsquo;s spend factors (CEDA or similar) for the job, or record the line in a currency that has one — it is never converted.</p>
                ) : null}
                <label className="nz-fl">VAT %
                  <input className="nz-inp" inputMode="decimal" value={draft.vatPercent} placeholder={vatApplies ? "20" : "No VAT"} disabled={!vatApplies}
                    onChange={event => patch({ vatPercent: event.target.value })} />
                  {/* D2 (R6): whether VAT applies is the map's or the category's; the client enters only the %. */}
                  {!vatApplies ? <span className="nz-hint nz-ef-novat">VAT doesn&rsquo;t apply to {filedCategory.name}.</span> : null}
                </label>
              </div>
            ) : field.key === "quantity" ? (
              <div key={field.key} className="nz-ef-two">
                <label className="nz-fl">{field.label}
                  <input className="nz-inp" inputMode="decimal" value={draft.quantity} placeholder="e.g. 12,400"
                    onChange={event => patch({ quantity: event.target.value })} />
                </label>
                {audience === "crm" ? (
                  <label className="nz-fl">Unit <span className="muted">· from the factor</span>
                    <input className="nz-inp" readOnly value={draft.unit || ""} placeholder="set by the emission factor"
                      aria-label="Unit — set by the selected emission factor" />
                  </label>
                ) : (
                  <label className="nz-fl">Unit
                    <select className="nz-sel" value={draft.unit} onChange={event => patch({ unit: event.target.value })}>
                      {(units.length ? units : [draft.unit || category.code]).map(unit => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </label>
                )}
              </div>
            ) : null;

          case "unit-select":
            return null; // rendered alongside quantity above

          case "months":
            return (
              <details key={field.key} className="nz-disc" open={draft.monthlyOpen}
                onToggle={event => patch({ monthlyOpen: (event.target as HTMLDetailsElement).open })}>
                <summary>Add monthly breakdown <span className="muted">· optional</span></summary>
                <div className="nz-disc-body">
                  {reportingMonths.length ? (
                    <>
                      <div className="nz-months">
                        {reportingMonths.map(month => (
                          <label key={month}>{monthLabel(month)}
                            <input inputMode="decimal" value={draft.monthly[month] ?? ""} aria-label={`${monthLabel(month)} value`}
                              onChange={event => setMonth(month, event.target.value)} />
                          </label>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button type="button" className="nz-btn" onClick={() => {
                          const first = draft.monthly[reportingMonths[0]!] ?? "";
                          patch({ monthly: Object.fromEntries(reportingMonths.map(month => [month, first])) });
                        }}>Copy month 1 → all</button>
                        <button type="button" className="nz-btn" onClick={() => patch({ monthly: {} })}>Clear</button>
                      </div>
                    </>
                  ) : <p className="muted" style={{ margin: 0 }}>No reporting period is set for this job yet.</p>}
                  <span className="nz-hint">{field.hint}</span>
                </div>
              </details>
            );

          case "spend-group":
            return (
              <fieldset key={field.key} style={{ border: 0, padding: 0, margin: 0 }}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className={category.code === "3.1" ? "nz-ef-two" : undefined}>
                  <label className="nz-fl">GL / nominal code
                    <input className="nz-inp" value={draft.glCode} placeholder="5200" onChange={event => patch({ glCode: event.target.value })} />
                  </label>
                  {/* A PG&S sub-category is PG&S's own: the write refuses one on any other category (D1, R2). */}
                  {filedCode === "3.1" ? (
                    <label className="nz-fl">{audience === "portal" ? "Category (authorised)" : "PG&S category"}
                      <select className="nz-sel" value={draft.spendCategoryId} onChange={event => patch({ spendCategoryId: event.target.value })}>
                        <option value="">Select a category</option>
                        {spendCategories.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
                {/* The spec's hint describes the drawer's own category; a line filed elsewhere gets the routing line below instead. */}
                {filedCode === category.code ? <span className="nz-hint">{field.hint}</span> : null}
                {/* D2 (R2): where the line is filed — the client's map's answer, shown; "allocate elsewhere" always open. */}
                {allocatable.length > 1 ? (
                  <label className="nz-fl nz-ef-allocation">Filed under
                    <select className="nz-sel" value={filedCode} aria-label="Filed under"
                      onChange={event => {
                        allocationTouched.current = true;
                        const next = event.target.value;
                        const nextScope = spendCategoryOf(next)?.scope;
                        // A factor that cannot price a line in the new scope is cleared, never carried somewhere it cannot price.
                        const keeps = (props.allFactors ?? factors).find(option => option.id === draft.factorId);
                        patch({ allocateTo: next === category.code ? undefined : next,
                          ...(keeps && ((keeps as { scope?: string }).scope ?? category.scope) === nextScope ? {} : { factorId: "" }) });
                      }}>
                      {allocatable.map(entry => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code}){entry.code === category.code ? " — this category" : ""}</option>)}
                    </select>
                    <span className="nz-hint nz-ef-routing">{mapped && mapped.categoryCode === filedCode && !allocationTouched.current
                      ? `Allocated by ${spendRoutingLabel(mapped).split(" — ")[1]} — change it here if this line belongs elsewhere.`
                      : filedCode === category.code ? "Filed in this category. Allocate it elsewhere if it belongs in another." : `Filed under ${filedCategory.name} instead of ${category.name}.`}</span>
                  </label>
                ) : null}
              </fieldset>
            );

          case "factor-select":
            return (
              <label key={field.key} className="nz-fl">{field.label}
                <select className="nz-sel" value={draft.factorId} onChange={event => {
                  const id = event.target.value;
                  // Back on the declared factor, a reason given for leaving it no longer applies.
                  const unit = basisFactors.find(option => option.id === id)?.unit;
                  patch({ factorId: id, ...(spend ? { currency: unit ?? draft.currency } : { unit: unit ?? draft.unit }),
                    factorOverrideReason: declared && id === declared.optionId ? "" : draft.factorOverrideReason });
                }}>
                  <option value="">Select a factor</option>
                  {basisFactors.map(option => <option key={option.id} value={option.id}>{factorOptionText(option)}{option.provenance ? ` — ${option.provenance}${option.preferred ? " (preferred)" : ""}` : ""}</option>)}
                  {/* A client factor is staff's to choose: never offered in the portal (the write refuses one too). */}
                  {audience === "crm" ? <option value={CLIENT_FACTOR_OPTION}>Client factor (EPD)…</option> : null}
                </select>
                <span className="nz-hint">{declared ? `Declared for this category: ${declared.label}` : field.hint}</span>
                {divergent ? (
                  <label className="nz-fl">Why this factor instead of the declared one?
                    <textarea className="nz-inp" rows={2} maxLength={500} value={draft.factorOverrideReason}
                      onChange={event => patch({ factorOverrideReason: event.target.value })}
                      placeholder="e.g. supplier-specific factor from the client's contract" />
                  </label>
                ) : null}
              </label>
            );

          // DA4 — lean capture: the factor is auto-matched, shown for
          // confirmation only. It is refined/overridden in the row's evidence
          // panel after saving, not picked here.
          case "factor-review": {
            const matched = basisFactors.find(option => option.id === draft.factorId) ?? null;
            return (
              <div key={field.key} className="nz-ef-factor-review">
                <span className="nz-eyebrow">{field.label}</span>
                {matched ? (
                  <div className="nz-banner ok" role="status">
                    <b>{matched.label}</b>{matched.unit ? ` · ${matched.unit}` : ""}
                    {declared && matched.id === declared.optionId ? <span className="chip">declared for this category</span> : null}
                  </div>
                ) : (
                  <div className="nz-banner warn" role="status">
                    No factor matched yet — pick a listed activity above, or set one after saving.
                  </div>
                )}
                <span className="nz-hint">{field.hint}</span>
                {divergent ? (
                  <label className="nz-fl">Why this factor instead of the declared one?
                    <textarea className="nz-inp" rows={2} maxLength={500} value={draft.factorOverrideReason}
                      onChange={event => patch({ factorOverrideReason: event.target.value })}
                      placeholder="e.g. supplier-specific factor from the client's contract" />
                  </label>
                ) : null}
              </div>
            );
          }

          // Each select names the field it renders. This was `qualityTier ? … : dataConfidence`, which
          // meant **every other select rendered as Data confidence** — bound to `draft.dataConfidence`,
          // so a new field would have silently overwritten a different value while looking like a working
          // form. `supplySource` was about to be that field. An unknown key now renders nothing rather
          // than something else, and `everySelectFieldHasAControl` fails on it in CI.
          case "select":
            if (field.key === "qualityTier") {
              return (
                <label key={field.key} className="nz-fl">Quality tier
                  <select className="nz-sel" value={draft.qualityTier} onChange={event => patch({ qualityTier: event.target.value })}>
                    {QUALITY_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
                  </select>
                </label>
              );
            }
            if (field.key === "dataConfidence") {
              return (
                <label key={field.key} className="nz-fl">Data confidence <span className="muted">· NZC-044</span>
                  <select className="nz-sel" value={draft.dataConfidence} onChange={event => patch({ dataConfidence: event.target.value })}>
                    {DATA_CONFIDENCE.map(level => <option key={level} value={level}>{level}</option>)}
                  </select>
                </label>
              );
            }
            if (field.key === "usageType") {
              if (!props.usageTypes) return null;
              // A value the row already holds stays shown even if it has since been withdrawn — the record still names it.
              const held = Boolean(draft.usageTypeId) && !props.usageTypes.some(option => option.id === draft.usageTypeId);
              return (
                <label key={field.key} className="nz-fl">{field.label} <span className="muted">· optional</span>
                  {field.hint ? <span className="muted"> · {field.hint}</span> : null}
                  <select className="nz-sel" data-usage-type value={draft.usageTypeId ?? ""} onChange={event => patch({ usageTypeId: event.target.value })}>
                    <option value="">Not specified</option>
                    {props.usageTypes.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                    {held ? <option value={draft.usageTypeId}>Withdrawn usage type</option> : null}
                  </select>
                </label>
              );
            }
            if (field.key === "supplySource") {
              return (
                <label key={field.key} className="nz-fl">{field.label}
                  {field.hint ? <span className="muted"> · {field.hint}</span> : null}
                  {/* No pre-selected value: the blank is what "not answered yet" looks like, and the
                      companion declines while it holds. Defaulting to grid would invent a Scope 3 row
                      for every entry nobody had got to. */}
                  <select className="nz-sel" value={draft.supplySource} onChange={event => patch({ supplySource: event.target.value })}>
                    <option value="">Not stated</option>
                    {SUPPLY_SOURCES.map(source => (
                      <option key={source} value={source}>{SUPPLY_SOURCE_LABELS[source]}</option>
                    ))}
                  </select>
                </label>
              );
            }
            return null;

          case "textarea":
            return (
              <label key={field.key} className="nz-fl">{field.label}
                <textarea className="nz-notes" rows={2} value={draft.note}
                  placeholder={audience === "portal" ? "Anything that helps the consultant verify this" : "Working note"}
                  onChange={event => patch({ note: event.target.value })} />
              </label>
            );

          case "dropzone":
            return (
              <div key={field.key}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-ef-dropzone">
                  <b>📎 Attach file</b>
                  {field.hint}
                </div>
              </div>
            );

          case "lineage":
            return (
              <div key={field.key}>
                <span className="nz-eyebrow">{field.label}</span>
                <div className="nz-lin">
                  {lineage.map((step, index) => (
                    <div className="stepl" key={`${step.label}-${index}`}><b>{step.label}</b><small>{step.detail}</small></div>
                  ))}
                </div>
                {provenance.length ? (
                  <>
                    <span className="nz-eyebrow">Provenance</span>
                    {provenance.map(item => (
                      <div className="nz-kv" key={item.label}><span className="k">{item.label}</span><span className="v">{item.value}</span></div>
                    ))}
                  </>
                ) : null}
              </div>
            );

          default:
            return null;
        }
      })}

      {lean ? (
        <p className="nz-hint">Quality tier, data confidence, evidence notes and supporting documents are set
          in the row's evidence panel after saving.</p>
      ) : null}

      <div className="nz-dact">
        <button type="button" className="nz-btn" onClick={props.onCancel}>Cancel</button>
        {actions.map(action => (
          <button key={action.key} type={action.variant === "primary" ? "submit" : "button"}
            className={action.variant === "primary" ? "nz-btn pri" : "nz-btn"} disabled={props.busy}
            onClick={action.variant === "primary" ? undefined : () => run(action.key)}>{action.label}</button>
        ))}
      </div>
      {audience === "portal" ? (
        <p className="nz-hint">{props.portalDirect ? "Saving adds this to your data straight away, marked for review. It counts once your adviser has reviewed it." : "Submitting sends this to NZI. Not counted in emissions until the consultant reviews it."}</p>
      ) : null}
      <span className="nz-sr-only">{scopedTo}</span>
    </form>
  );
}
