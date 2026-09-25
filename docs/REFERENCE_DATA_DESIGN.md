# NZI Console — Reference data: identity, import, spanning jobs, client data

**What this is.** The ruled design for bringing NZI Pro v7's emission-factor library into the console, and the two
model changes that library needs to be usable: curated identity that survives annual updates, and jobs whose
reporting period spans two editions. Ruled 25 Sep 2026 (design approved in full; spanning methodology ruled by
Francis). Code follows this document in gated stops; nothing here is built yet.

**Reading order:** `ARCHITECTURE.md` §4.5 → this document → `DECISIONS.md` (NZC-056, NZC-145, NZC-157, NZC-160,
NZC-163, NZC-164).

---

## 1. Why the console's factor model is flat, and why it gains an identity layer

**Verified from the record.** `ARCHITECTURE.md` §4.5 (24 Aug) specifies `Dataset { source, …, year, version,
licence } → Factor (scope, levels, uom, ghg_unit, value)` — year on the dataset, value on the factor. Migration 0009
(25 Aug) built that. NZC-056 confirms one shared `emission_factors` with no parallel `factor_lookup`. The
normalised shape (`admin_factor_definitions` + `*_year_values`) appears in the repository only as a description of
the *live* v7 platform (`WORKFLOWS.md`). No decision moved the console off a normalised design; none was recorded.

**Why flat is not enough.** v7 normalised for **curation**, not resolution. NZI edits a factor's identity to fit the
business ("Purchased Goods and Services", not "&"), and report labels are refined by people over months. Those edits
must survive when a new year's data is added. A flat row per `(dataset, factor_id)` duplicates the label per year:
curate 2024, add 2025, and the edit does not carry.

**Why not full normalisation.** Resolution works flat: a rule names a `factor_id`, the resolver looks it up in the
job's selected datasets, and a stable id across year-datasets lets a rule authored once resolve every year. Moving
unit, scopes and label off the value rows would touch 28 queries across 13 files, the five `primaryFactorFor` call
sites, calculation, three portal paths, LCA, spend import and about twenty test and seed files — 8–12 days, for no
change in any resolved number.

**The ruled middle path.** `emission_factors` stays the flat value table (value, unit, scopes, per year). A small
identity table holds the human-curated fields once. It is the normalised core — moving unit and scopes onto it later
is additive — so nothing here has to be undone.

## 2. The identity layer — migration 0125

### `nzi_console.factor_identities`

| Column | Meaning |
|---|---|
| `organisation_id`, `factor_id` | primary key — the stable cross-year identity |
| `label` | the curated display name |
| `report_label` | the curated report wording |
| `business_category` | NZI's business category |
| `levels text[]` | the curated hierarchy (levels 1–4) |
| `source_label` | what the source called it at import — kept so later imports can be diffed |
| `source_system`, `legacy_factor_id` | provenance (§4) |
| `version`, `curated_by`, `curated_at` | curation history |

Forced row-level security with the tenant policy, grants without DELETE. **Every value row points at one:** a foreign
key `emission_factors (organisation_id, factor_id) → factor_identities`, so a factor has exactly one identity by
construction. 0125 backfills identities for the existing synthetic ids from their labels so the key holds for every
row.

### `nzi_console.emission_factors_display` — the read path

A `security_invoker` view (so row-level security applies to the caller) joining each value row to its identity and
exposing the curated label, report label, levels and category. The label-reading queries move to it; the resolver
does not — it resolves by `factor_id` and dataset and reads only unit and scopes.

**Report label order:** the row's own explicit report label → the client's alias (§6) → the identity's
`report_label` → the identity's `label`. Scope rows still snapshot `factor_label` at write and calculation, so an
issued report never changes its wording.

**Curation after import:** a `factor_identity.curate` command (audited, `factor.manage`) and a small admin screen —
**after onboarding**. The import brings v7's curated identity across on day one.

## 3. The factor id

**`v7-<factor_id>`**, where `factor_id` is v7's `definitions.factor_id` integer — the key year-values hang on, stable
across editions by construction.

Not `original_id`: it is a per-year-value attribute that churns (a diagnostic found 630 of 64,051 identities with more
than one `original_id` across years; the format changed between editions; v7 needed an 86,989-row alias crosswalk).

- **Unique within a dataset** — to be confirmed by the uniqueness query (one definition, one row per dataset after the
  `kgCO2e` filter). If a definition carries several units in one dataset, the id becomes `v7-<factor_id>.<unit>`, the
  unit segment joining words with `_`.
- **Never read as a category variant.** It ends in digits (or a `_`-joined unit), so `<id>-b` is always the
  business-travel variant of `<id>` and nothing else (NZC-145).
- **Safe in option keys:** no `:` or `|`.
- **Referenced by rules via lookup, locked by test.** A rule for "car, diesel, km" is written by querying the
  imported identities by levels, label and unit and pinning the id; each rule carries an intent assertion (for example
  "`v7-1234` is car / diesel / km, Scope 1") so a wrong id fails CI.

## 4. Provenance and integrity — also 0125

**`emission_factors`:** `source_system` (`'nzi-pro-v7'`), `legacy_factor_id` (= `definitions.factor_id`, the
identity), `legacy_original_id` (the per-year `original_id`), `source_levels text[]`, `source_category`, `ghg_unit` —
nullable so the synthetic seed stays valid; a check requires the legacy ids whenever `source_system` is set; a unique
index on `(organisation_id, dataset_id, source_system, legacy_factor_id)` for a one-to-one, re-runnable load.

**`emission_factor_datasets`:** `source_system`, `source_family`, `legacy_dataset_id`, `content_sha256`.

**Load checks (refuse):** loaded rows equal extracted rows, per dataset and in total; no duplicate id within a
dataset; no id that parses as a registered variant; no negative factor; no unknown scope; an id already present in an
earlier edition of its source must carry the same unit, scope and `ghg_unit`; no active dataset whose validity
overlaps another active dataset of the same source family and country; a dataset that exists with a different
content hash is refused (a changed edition is a new dataset); the same hash is a no-op.

**Load reports (do not refuse):** units the console's unit registry does not recognise; ids that vanished from, or
are new since, the source's previous edition — above all any id a rule references.

**Organisation.** Loaded into the operating organisation that owns the jobs. The tenant is the NZI firm; a client is
a row inside it; portal users read through it. Selections and aliases carry foreign keys requiring same-organisation
datasets and factors, so a global reference organisation would need those keys and about twenty-five joins rewritten
and a cross-tenant read exception. A second organisation, if one appears, gets its own load, as
`provision_organisation` does for the rest of the reference set.

## 5. The import

**Filter:** `ghg_unit = 'kgCO2e'` (v7 holds only kgCO₂e plus one anomalous kWh(net) row). The expected count is
re-taken after the filter.

**`emission_factor_datasets`** — one row per year-scoped v7 dataset, loaded first:

| Column | From |
|---|---|
| `dataset_id` | `<family>-<country>-<year>` |
| `name` / `version` | v7 dataset name / source edition |
| `valid_from` / `valid_to` | min / max of its year-values |
| `country_code` / `source_name` | v7 dataset |
| `status` / `synthetic` | `'active'` / `false` |
| `licence` | per source — **input needed** (DESNZ/DEFRA: Open Government Licence v3.0; IEA: not open, rights to confirm) |
| `source_system` / `source_family` / `legacy_dataset_id` / `content_sha256` | provenance |

**`factor_identities`** — one row per `definitions.factor_id`: `label`, `report_label`, `business_category`,
`levels` from the v7 definition (its curated identity); `source_label` from `column_text`.

**`emission_factors`** — one row per definition per year: `factor_id` (§3), `label` ← `column_text` (the source's
own wording that year), `kgco2e_per_unit` ← `factor`, `activity_unit` ← `uom` (mapped, §5.1), `scopes` ← `scope`
(mapped), `active` true, and the provenance columns (§4).

### 5.1 Units

The console matches units exactly (case and surrounding space aside) against the registry in
`unitCompatibility.ts`; an unknown unit on either side is refused, never passed. Units convert within a dimension
(energy, volume, mass, distance, passenger-distance, freight) and not across. v7 `uom` values are mapped to the
registry's spellings through an explicit table, ruled before the load. Anything unmapped loads verbatim and is
reported: pickable by a person, never resolved by a rule. `kWh (Net CV)` / `kWh (Gross CV)` map to `kWh` with the
calorific basis kept in the identity's levels and label, so two identical-looking options never sit side by side.

**Division of work:** Francis runs the `psql` extract on live and the load on the console database; the transform is
built and tested here against a real local Postgres with a sample. The branch is gated (NZC-163) and ruled before it
runs.

## 6. Custom client data

**Client aliases (0125).** Re-keyed from `(client, dataset_id, factor_id)` to `(organisation, client, factor_id)`,
the foreign key moving to `factor_identities`. What a client calls a factor is a property of the factor, not of a
year's dataset — today an alias written against 2024 silently does not apply to a 2025 row. The migration folds
existing aliases across datasets and refuses, listing them, where one client's aliases for one factor disagree.

**Client factors across a client's jobs — verified.** A client factor created in one job with "Reusable across this
client" (the default) is stored without a job and offered in every job for that client, and to no other client. A
factor created with the box unticked is pinned to its job — and **cannot be promoted later**: `client.factor.update`
does not touch `job_id`. Fix, as its own small stop (no migration): a one-way *make reusable* command. Demotion is not
offered, because it would strand other jobs' rows.

**Client factor periods (deferred until after onboarding, unless the onboarding client has year-spanning custom
factors).** Today a new year's value for a client factor is an edit that bumps `version`, which marks every earlier
row "version moved" — a correction and a new vintage are the same act. The coherent model is the dataset tier's split
at small scale: `client_factor_values (client_factor_id, valid_from, valid_to, kgco2e_per_unit, version)`, so a new
year is a new period and `version` means a correction within one. Month-by-month pricing (§7) then applies to client
factors exactly as to dataset factors. Until it lands, a client factor prices every month at its single value —
today's behaviour, and correct for one vintage.

## 7. Spanning jobs — priced month by month

**Verified gap.** A UK financial-year job (April–March) spanning two editions: auto-selection selects **neither**
edition (it requires one dataset to cover the whole period); with both selected manually, every entry in an enabled
category is **refused** (`DECLARED_FACTOR_AMBIGUOUS`), even when the entry names one edition. The resolver sees no
date; a scope row is annual with a monthly split, and calculation prices it at one value.

**Ruled design — option (a):**

1. **Selection.** Auto-select every active dataset whose validity *overlaps* the period
   (`valid_from <= reporting_to AND valid_to >= reporting_from`), in the job's country plus `GLOBAL`. The job's
   country comes from the client's `registered_country` (validated two-letter code), falling back to GB with a visible
   warning, and is editable on the job. Both `'GB'` hardcodes go.
2. **Coverage.** For each source selected, the editions together must cover every reporting month. Uncovered months
   are warned, listed on the job — never priced by the nearest edition, never priced at zero.
3. **Ambiguity, redefined.** A factor is ambiguous only if two selected datasets carrying it are valid for the same
   month. Adjacent editions of one identity are not ambiguous. The load refuses overlapping active editions of one
   source; a manual selection that would overlap is refused.
4. **Resolution unchanged.** The resolver resolves the identity (`factor_id`). The row stores `factor_id` and the
   edition it was written against, for display; provenance lists every edition that prices it.
5. **Calculation.** tCO₂e = Σ over the row's months of that month's quantity × the value from the edition valid for
   that month ÷ 1,000. A month belongs to the edition covering its first day. **Quantity not split into months is
   apportioned by the days each edition covers; a monthly split overrides where present** (ruled by Francis). A
   single-edition job is exactly today's number, proved against every existing suite.
6. **Lineage.** Per edition: dataset, version, months, quantity, value, tCO₂e. `factor_version` reads
   "2024 v…; 2025 v…".
7. **Everything that prices a row** moves to the same rule: aggregation and monthly distribution, snapshot and report
   hashes, portal acceptance (via the shared resolver), and the characterisation, which gains spanning-job rows.

## 8. Sequence

Each a gated review stop (NZC-163); migrations are ruled before merge.

1. **0125** — identity table, display view, provenance columns, alias re-key.
2. **The import** — transform and load into both tables, tested on a sample; Francis extracts and loads.
3. **Re-point the enabled rules** from `electricity-demo` / `diesel-demo` to their `v7-…` ids (without it, jobs on
   real data fall to a person's pick), then re-size F2/F3 per enabled category, then retire the synthetic datasets.
4. **Spanning jobs, option (a).** Needed before onboarding if any onboarding job runs April–March.
5. **Client factor promotion** (small, independent).
6. **After onboarding:** curation command and screen; client factor periods; variant (`-b`/`-c`) rows at per-distance
   enablement, only for the bases the rules name.

## 9. Inputs outstanding

- The uniqueness query (does one definition appear more than once in a dataset?).
- Distinct `source`, `uom` and `scope` values — for the unit and scope mapping tables.
- Licence text per source; IEA's rights in particular.
- The organisation list on the console database.
- A 50–200-row sample in the extract's exact format.
