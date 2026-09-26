# NZI Console — Reference data: identity, import, spanning jobs, client data

**What this is.** The design for bringing NZI Pro v7's emission-factor library into the console, and the two model
changes that library needs to be usable: curated identity that survives annual updates, and jobs whose reporting
period spans two editions. Ruled 25 Sep 2026 (design approved in full; spanning methodology ruled by Francis).

**Status (26 Sep 2026).** The identity layer and the import are **built, merged and loaded** — migrations 0125–0128,
the import in #317 and #319 — and §2–§5 describe what was built, superseding the earlier anchor (`v7-<original_id>`)
and extract (definitions plus year-values) of #309/#313. The real load ran into the console's isolated staging
database: **222 datasets, 3,859 identities, 80,678 value rows, 703 rows excluded, 19 removals.** Spanning jobs (§7),
client-data changes (§6) and re-pointing the enabled rules (§8) are not built yet.

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
| `source_system`, `source_family`, `legacy_original_id`, `legacy_db_id` | provenance (0126, §4) |
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
**after onboarding**. The import brought v7's curated identity across on day one.

## 3. The factor id — as built

**Source table: v7's `factor_lookup`**, one row per value (`db_id`), not `emission_factor_definitions` plus
`emission_factor_year_values`. Where they disagree, `factor_lookup`'s category is authoritative: it is the
operationally correct, suffix-aware one (the definitions' category is stale on suffixed rows). A disagreement is
counted, never "corrected".

**`factor_id = <family>-<normalised original_id>`.** `original_id` is v7's source code; the family comes from the
row's `source`:

| v7 `source` | Family |
|---|---|
| DESNZ, DEFRA (and any DEFRA revision) | `uk-ghg` |
| SWC (Small World Consulting) | `swc` |
| RICS / BRE ICE | `ice` |
| NZI | `nzi` |
| IEA 2025 | `iea` |
| CEDA 2025 (Watershed) | `ceda` |

The family prefix is what keeps codes apart: ICE numbers its factors `1`, `2`, `3`…, so the same code in two families
is two different factors. DESNZ and DEFRA share `uk-ghg` safely — on the full extract they have no `original_id` in
common and use different code shapes (DESNZ numeric, DEFRA `SPEND-SIC-…`).

**Normalisation.** Whitespace is trimmed and collapsed. A code containing a digit is kept exactly — case and suffix
included, because the suffix is part of what it means (`uk-ghg-21_316_3178_11_1`, `uk-ghg-SPEND-SIC-49.3-5-u`,
`ice-1`). A code with no digit is a name — IEA keys its grid factors by country — and becomes a lower-case,
accent-folded, hyphenated slug (`iea-puerto-rico`). The code v7 wrote is stored verbatim beside the id, which makes the
id reversible.

**Settled on the full extract (95,893 rows).** The id is unique within every dataset (zero collisions);
`original_id` recurs across years and countries, so one identity per code is curated once and applies wherever the code
is used; CEDA's recurrence of each code across its per-country files is by design. `definitions.factor_id` is not a key
— definition 9759 alone is five flight-class factors in one dataset — and is not carried.

Properties:

- **Safe in option keys.** An id that would contain `:`, `|` or whitespace is refused at load.
- **Case is kept.** Suffix matching is case-sensitive, so a code ending in an upper-case form of a registered suffix
  (`-C`) is not read as a variant; the load reports any such id.
- **Referenced by rules via lookup, locked by test.** A rule for "car, diesel, km" is written by querying the imported
  identities by levels, label and unit and pinning the id; each rule carries an intent assertion (for example
  "`uk-ghg-1_101_1017_8_1-vcp` is company vehicles / petrol / litres, Scope 1") so a wrong id fails CI.

### 3.1 Category variants come across in the data

v7 allocates one physical factor to several GHG categories the way the console does (NZC-145): base factors duplicated
with a suffix on `original_id`. The variant rows therefore **arrive with the import** — none is created at enablement.

**The registry matches v7 (0110, 0126).** `-b` 3.6, `-c` 3.7, `-p` 3.1, `-u` 3.4, `-d` 3.9 (0110), and 0126 added
v7's other five: `-vcd`, `-vcp`, `-vh`, `-vvd` — company-vehicle sub-types, Scope 1 — and `-bcp`, business travel by
petrol car (3.6). Variants span scopes.

- **`-cv` → `-vcp`, a transform alias** (ruled 25 Sep 2026). One DESNZ row (db 41459, "Company Vehicles – Petrol")
  carries an unregistered `-cv`; the transform mints its id with `-vcp` and keeps the v7 code verbatim in
  `legacy_original_id`. The registry gains no entry; each alias used is reported.
- **`-w` is retired.** It is not a v7 suffix; the registry retires it through the audited `factor.variant.retire`
  command (`npm run retire:category-variant`), and the import **excludes** `-w` rows (§4).
- `uk-ghg-X-c` parses as the commuting (3.7) variant of `uk-ghg-X`; an unregistered tag is a plain id, never grouped
  with a base.
- **Load checks on every id that parses as a variant** (reported, not refused — a variant row prices at its own value,
  so nothing is mis-priced meanwhile): its base is present in the same dataset, and carries the same value and unit.
- **What it gives the resolver.** The sub-flow rules for business travel and commuting compose `<base>-b` / `<base>-c`
  from the vehicle flow's answer; a category whose own variant of a base is on offer refuses the base.

## 4. Provenance and integrity — as built

### Provenance (0126)

| Table | Columns | Key |
|---|---|---|
| `emission_factors` | `source_system` (`'nzi-pro-v7'`), `legacy_original_id` (verbatim), `legacy_db_id` (the `factor_lookup` row), `source_levels text[]`, `source_category`, `ghg_unit`, `is_removal` (0128) | `(organisation_id, source_system, legacy_db_id)` — **the idempotency key**: a re-run lands on the same rows; also unique `(organisation_id, dataset_id, source_system, legacy_original_id)` |
| `factor_identities` | `source_system`, `source_family`, `legacy_original_id`, `legacy_db_id` (the lowest `db_id` carrying the code) | **natural key `(organisation_id, source_system, source_family, legacy_original_id)`** |
| `emission_factor_datasets` | `source_system`, `source_family`, `legacy_dataset_id` (the v7 dataset, or `a+b` for a merge), `content_sha256` | — |

`legacy_factor_id` (v7's `definitions.factor_id`) is **gone from both tables** (0126). Wherever `source_system` is set,
`legacy_original_id` is required, plus `legacy_db_id` on a value row and `source_family` on an identity. A factor
whose dataset belongs to a different family from its identity is refused, wherever it is written from.

### Cleaning

- **Absence.** Empty, and `NaN`, `nan`, `null`, `None` **in any case**, are SQL NULL; nothing else is. On the full
  extract that is 186,251 cells in 64,674 rows, mostly `level_2`–`level_4`. Case matters: `Green gas|NaN|` and
  `Green gas|nan|` are one category once cleaned.
- **Scope.** `Scope 1/2/3` → `'1'/'2'/'3'`; a bare `3` (two DEFRA rows) is read as Scope 3 and reported.
- **Units** are mapped to the console registry's spelling (§5.1).
- **Only kgCO₂e loads.** Three `kWh(net)` rows are excluded.

### Findings: refused, excluded, reported

A **refusal** blocks the whole load. An **exclusion** skips one row for one of a **closed list of six named
reasons**, lists it in the exclusion report, and lets the load go ahead. A **report** is shown and the load goes
ahead. The list is closed on purpose (ruled 25 Sep 2026): a row that fails for any reason not on it refuses the load,
so a new kind of bad row halts it rather than disappearing.

**Excluded — the closed six** (703 rows on the full extract):

| Reason | Rows | What |
|---|---|---|
| `factor-missing` | 88 | no factor value (all DESNZ `NaN`) |
| `column-shifted` | 1 | a currency that is not a three-letter code — the row's columns are shifted (db 35881) |
| `swc-no-country` | 599 | every SWC row: no region, and SWC is unused |
| `not-kgco2e` | 3 | `kWh(net)` rows — not emission factors |
| `retired-w` | 8 | a code ending in `-w` |
| `duplicate-upload-unit-conflict` | 4 | db 31415, 31416, 21722, 21723 only: nzi Walking/Cycling at 0 `passenger.km` in v7's `tmp*.csv` duplicate uploads, where the xlsx edition says 0 `miles`. **Self-checking:** excluded only while the value is 0 and the xlsx miles counterpart is present; otherwise refused as `ruled-exclusion-unverified` |

Every excluded row is written, dry run or not, to `<extract>.exclusions.csv` beside the extract.

**Refused — fail-closed.** Two sit right beside the exclusions and are deliberately *not* on the list:

- **A CEDA row with no region** (`no-country`). Excluding it would hide a data gap in a factor set that is in use;
  defaulting it would attach a spend factor to every job.
- **A negative factor outside ICE** (`negative-factor`).

The rest: no `db_id`, or one `db_id` twice with different content; no code, year, dataset or unit; an unknown source or
scope; a factor that is not a number; a code that cannot be an id; a country name that cannot be matched; two v7
datasets folding into one slug with no rule to order them (`edition-collision`); a ruled merge whose halves carry a shared
code at a different value, unit or scope (`merge-conflict`); one code twice in a dataset, or two codes normalising to one id;
the same code in a **different unit** in another dataset (`code-reused`); a ruled exclusion that no longer holds. At
write: a dataset already loaded with different content (a changed edition is a new dataset; the same hash is a no-op),
and an organisation that does not exist.

**Reported, not refused:** defaulted countries; units the registry does not know (loaded verbatim, pickable, never
resolved by a rule); currencies; category drift across datasets; variant checks (§3.1); ICE negatives; the `-cv`
alias; bare scopes; merge duplicates; codes whose scope changes by year; a dataset with no validity dates (bounded by
its year).

**Designed but not built:** the earlier design also called for refusing two active datasets of one family and country
with overlapping validity, and a loaded-equals-extracted count. Neither is in the load. The first is largely covered by
construction — one active dataset per family, country and year (§5) — but overlaps between years are not checked.

### Scope may vary by year

Ruled 25 Sep 2026. Scope is a property of each value row: DEFRA moved nine spend codes (`SPEND-SIC-05`,
`SPEND-SIC-06`, `SPEND-SIC-35.1`, `SPEND-SIC-35.2-3`, `SPEND-PROD-4.5.1`–`.5`) from Scope 3 to Scope 1 or 2 in 2025,
and each year's row keeps its own. The resolver reads scope from the value row it selects, never from the identity.
Only a change of **unit** across datasets is a reused code.

### Removals — `emission_factors.is_removal` (0128)

The flag marks a factor that may be negative because it represents **stored or sequestered carbon** — at present
exactly ICE's 19 "Including Carbon Storage" timber values (−0.58 to −1.39 kg), which load as priced. The database
refuses any negative without it — `CHECK (kgco2e_per_unit >= 0 OR is_removal)` — and the import sets it only on ICE
negatives, so the two guard each other: a non-ICE negative reaches the database with `is_removal = false` and is
refused. The flag defaults to false.

**Standing reporting rule.** A factor with `is_removal` is reported separately, as storage/removals, and **never
netted into gross Scope totals** (GHG Protocol). Nothing reads the flag yet: this is an open requirement on the
resolver and reporting build, not the import.

### Organisation

Loaded into the operating organisation that owns the jobs — `net-zero-international` (0127). The tenant is the NZI
firm; a client is a row inside it; portal users read through it. Selections and aliases carry foreign keys requiring
same-organisation datasets and factors, so a global reference organisation would need those keys and about twenty-five
joins rewritten and a cross-tenant read exception. A second organisation, if one appears, gets its own load, as
`provision_organisation` does for the rest of the reference set.

## 5. The import — as built

`packages/isolated-backend/src/v7ReferenceImport.ts` is pure: an extract in, a validated plan out, every rule tested
directly. `v7ReferenceLoad.ts` writes the plan in one transaction. `scripts/load-v7-reference.ts` is the operator
entry point.

### Countries

- **Region → ISO 3166-1 alpha-2**, through the committed ISO table (`iso3166.ts`) plus v7's spellings as aliases
  (`v7Countries.ts`) — "UK", "Tanzania_United Republic of", "Hong Kong, China", "Lao People's Democratic Rep.",
  "Chinese Taipei"… All 151 distinct regions in the full extract match; each of CEDA's 149 was checked against the ISO3
  code in its file name. A name that cannot be matched is refused, never guessed.
- **IEA takes its country from the code** (its region is empty; the code is the country name), so 56 countries stay 56
  datasets and never collapse into the family default. An IEA name that cannot be matched is refused.
- **Per-country datasets** for CEDA and IEA (`ceda-ag-2025`, `iea-no-2025`, …).
- **Empty region → the family default**, reported: **GB** for `uk-ghg` and `nzi`; **GLOBAL** for `ice` and `iea` (IEA
  never reaches it). **None for `swc` or `ceda`**: both are multi-country spend providers, and a defaulted spend factor
  would attach to every job. An SWC row is excluded; a CEDA row is refused.
- **CEDA "Rest of World" → `ROW`**, kept distinct from `GLOBAL`: job creation selects the job's own country and
  `GLOBAL`, **never `ROW`**, so a Rest-of-World factor is never auto-attached beside a country match.

### Datasets and editions

One dataset per **family, country and year**: `dataset_id = <family>-<country>-<year>` (`uk-ghg-gb-2025`).

| Column | From |
|---|---|
| `name` / `version` | the v7 file name, or `<source> <year>` |
| `valid_from` / `valid_to` | min / max of the rows' validity dates; the year's bounds where there are none (reported) |
| `country_code` | as above |
| `status` | `active`; an older edition sharing its slug is `superseded` (`…-original`) |
| `licence` | per source: "Source: <source>. Free public information, reproduced with attribution for open stakeholder verification." |
| `source_system` / `source_family` / `legacy_dataset_id` / `content_sha256` | provenance |

**When two v7 datasets fold into one slug:** a revision beats the edition it revises; otherwise a ruling in the
precedence file (`--precedence`) names the active edition or says `merge`. Anything else is refused with the numbers a
ruling needs.

**The ruled merges** (25 Sep 2026), applied by default: **`uk-ghg-gb-2021` … `uk-ghg-gb-2026` and `nzi-gb-2021` …
`nzi-gb-2026`**, twelve slugs. Each year arrives in two v7 datasets (1+8, 2+9, 3+10, 4+11, 5+12, 69+70). On the full
extract the second is a **duplicate v7 upload** (`tmp*.csv`), a subset of the first — **not complementary halves**,
as first assumed. Merging is correct either way:

- a code shared at the same value, unit and scope **loads once** (from the lowest `db_id`; 14,512 on the full
  extract);
- a code carried by only one half still loads;
- a shared code with a different value, unit or scope in each half **refuses the merge** — the guard that stopped two nzi slugs,
  resolved by the four ruled exclusions above.

A v7 duplicate-upload clean-up is Francis's, later; it does not block anything here.

### Rows

- **`factor_identities`** — one per code within its family: `label`, `report_label`, `business_category`, `levels`
  from the most recent row carrying the code; `source_label` from `column_text`.
- **`emission_factors`** — one per code per dataset: `label` ← `column_text` (the calorific basis added where the unit
  drops it), `kgco2e_per_unit` ← `factor`, `activity_unit` ← `uom` (§5.1), `scopes` ← that row's scope, `is_removal`,
  and the provenance columns.

### 5.1 Units

The console matches units exactly (case and surrounding space aside) against the registry in
`unitCompatibility.ts`; an unknown unit on either side is refused, never passed. v7 `uom` values are mapped through an
explicit table:

| v7 `uom` | Console unit |
|---|---|
| kg, km, miles, m2, litres, kWh, passenger.km, tonne.km, tonne, tonnes | the same |
| cubic metres | m3 |
| each, unit | units |
| Room per night | nights |
| kWh (Gross CV), kWh (Net CV) | kWh — distinct factors, the calorific basis kept in the label |
| anything else (m, million litres, per FTE Working Hour…) | loaded verbatim and reported: pickable by a person, never resolved by a rule until mapped |
| currencies | **every currency is loaded** as a spend unit, pickable, resolvable once that currency is enabled; CEDA's per-country code counts as one unit across currencies |

### 5.2 Load posture

- **Isolated non-production only, by design.** The load script, like the migration runner, refuses unless
  `NZI_DATABASE_BOUNDARY=isolated-non-production` is set and `NEXT_PUBLIC_APP_ENV` is not `production`. There is no
  confirmation flag and **no production path**.
- **Run from the Render Shell on the console service**, so the database URL stays in the service's environment and is
  never pasted into a local shell.
- **A dry run unless `--commit`.** The dry run prints every refusal, exclusion and report, and writes the exclusion
  report. `--commit` writes only a plan with no refusal, in one transaction, into `net-zero-international` (or
  `--organisation`).
- **Re-running is safe.** A dataset already loaded with the same content is left alone; one with different content is
  refused. A second `--commit` of the full extract writes nothing.
- **The extract is never committed** (NZC-020); tests run on a synthetic extract of the same shape.

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

1. ✅ **0125** — identity table, display view, provenance columns, alias re-key.
2. ✅ **0126** — provenance keyed by `legacy_original_id` and `legacy_db_id`; identities by family; the variant registry
   matched to v7.
3. ✅ **0127** — the operating organisation, `net-zero-international`.
4. ✅ **The import** (#317, #319) and **0128** (removals) — built, and loaded into staging.
5. **Re-point the enabled rules** from `electricity-demo` / `diesel-demo` to their `<family>-…` ids (without it, jobs
   on real data fall to a person's pick), then re-size F2/F3 per enabled category, then retire the synthetic datasets.
6. **Spanning jobs, option (a).** Needed before onboarding if any onboarding job runs April–March.
7. **Client factor promotion** (small, independent).
8. **After onboarding:** curation command and screen; client factor periods; the reporting treatment of removals (§4).

## 9. Inputs outstanding

- **Removals in reporting:** report `is_removal` factors separately and keep them out of gross Scope totals (§4).
- **Load checks designed but not built:** overlapping validity between active editions of one family and country, and a
  loaded-equals-extracted count (§4).
- **Licence text** is one attribution statement for every source; IEA's rights in particular are still to confirm.
- **v7 duplicate uploads:** Francis's clean-up of the `tmp*.csv` datasets in v7 (not blocking).
