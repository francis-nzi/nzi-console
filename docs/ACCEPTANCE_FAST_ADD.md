# Fast row-adding: template search + Reuse Previous Year Rows · acceptance

Decisions **NZC-062** (template search) / **NZC-063** (reuse previous year). Flag: **`data-entry-fast-add`**
in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (one flag for both — split later only if they need independent
rollout). Sits in the CRP **Data entry** stage's accordion (`#data-entry-accordion`), directly below the
site selector and above the scope→category cards — rows added by either inherit the site context chosen
there.

> Brought forward ahead of the LCA track (Francis, 4 Sep 2026): "the two fast row-adding facilities the live
> site has" — consultants use both daily and they needed to land before LCA planning.

## What changes

### NZC-062 — Add rows from template

- **`packages/contracts/src/commands.ts`** — `FactorOption` gains `categories: FactorOptionCategory[]`
  (`{scope, scopeCode, label}` per entry in the factor's existing `scopes`, resolved through the already-shared
  `crpScopeCategoryLabel` — no new storage, no drift from how the rest of the app names scope→category).
- **`packages/isolated-backend/src/readModels.ts`** — `listJobFactorOptions` (reused unchanged apart from
  this) now derives `categories` per row. This is the **whole job factor library** — every selected
  dataset's factors + every client factor, already loaded once for the CRP workspace (`factors` prop) — so
  the search itself is instant, client-side, no new fetch.
- **`apps/console/app/jobs/templateSearch.ts`** (new, pure) — `buildTemplateSearchIndex`: a Scope 3 factor
  resolves to exactly one pickable (factor, category) pair (Scope 3 taxonomy codes **are** the GHG codes —
  unambiguous); a Scope 1/2 factor's `scopes` only names the bare scope, which spans several UI categories
  with no way to tell which one a factor belongs to — so it expands to **one candidate per category in that
  scope**, each independently pickable and distinguished by the category shown, rather than guessing or
  dumping the row to "Unsorted". `fuzzyScore`: an exact substring match ranks highest (earlier position
  wins); failing that, a subsequence match (every query character present, in order) — the fast, forgiving
  match "people love". `searchTemplateIndex` sorts/caps results.
- **`apps/console/app/jobs/TemplateSearchBar.tsx`** (new) — an always-visible search input (`#template-search`,
  no extra click to reveal it), full keyboard nav (↑/↓/Enter/Esc), results shown as
  `label · scope · category · unit · dataset`. A pick posts to the existing `POST /scope-rows`
  (`scope.row.create`, unforked) stamping `scope`, `categoryCode`, `sourceLabel`/`reportLabel` (the factor's
  own label), the current site context (`All sites` → `Unallocated`, `siteId: null`), `quantity: null`,
  `qualityTier: null` — genuinely unset, not defaulted, so the existing QA gates still force a real
  assessment before approval (same DA4 lean-capture principle). The query clears after each pick and the
  input keeps focus — multi-add, no re-navigation needed between picks.

### NZC-063 — Reuse Previous Year Rows

- **Migration `0055_scope_row_rollforward_origin.sql`** — `job_scope_rows.rolled_forward_from_row_id`
  (self-referencing FK + `WHERE NOT NULL` unique index, one rolled-forward copy per origin per job) —
  mirrors migration `0039`'s `job_emission_sources.rolled_forward_from_source_id` pattern exactly, at the
  canonical-row level instead of the spend register.
- **`packages/isolated-backend/src/readModels.ts`** — `listScopeRowRollforwardPreview`: finds the prior CRP
  job for this client with enabled `job_scope_rows` (any type — generalised from
  `listSpendRollforwardPreview`'s `source_type='spend'` filter on `job_emission_sources`), then lists every
  enabled row on it with the same lineage the spend mechanism already computes: `factorVersionMoved`
  (a newer version of the same dataset is now selected than what's pinned), `datasetInJobSelection`,
  `alreadyRolledForward`. Category label resolves through the UI taxonomy first (so a Scope 1/2
  `category_code` like `1.company-vehicles` shows "Company Vehicles", not the raw slug), falling back to
  `crpScopeCategoryLabel` for Scope 3 / uncategorised rows.
- **`packages/isolated-backend/src/postgresCommands.ts`** — `rollforwardScopeRows`: takes the consultant's
  **chosen** prior-row ids (not "roll everything" — a genuine select-all/per-row choice), re-pins each row's
  prior dataset selection if not already selected (same NZC-030 continuity reasoning as the spend
  mechanism — the pinned factor must stay resolvable), copies factor + hierarchy (`category_code`,
  `level_1`/`level_2`) + site (re-validated against this job's client; dropped if the site no longer exists)
  + asset identifier forward, stamps `rolled_forward_from_row_id`, quantity `NULL`, quality tier unset.
  Skips (not errors) a row already rolled forward.
- **`apps/console/app/jobs/ReuseYearPanel.tsx`** (new) — lists the prior job's rows with a select-all /
  per-row checkbox list, a `⚠ factor moved` / `dataset not in selection` badge per row, `Already rolled
  forward` rows shown but disabled (can't re-select). Confirm calls the new
  `POST /scope-rows/rollforward`.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | A Scope 3 factor search-indexes to exactly one category (the GHG code); a Scope 1/2 factor expands to one candidate per UI taxonomy category in that scope — never guesses, never silently dumps to Unsorted | `templateSearch.test.ts` |
| 2 | Fuzzy match ranks an exact substring above a subsequence match; matches on category text too (not just the factor label) | `templateSearch.test.ts` |
| 3 | A picked row is enabled, stamped with the selected site (`Unallocated` for "All sites"), quantity/quality tier genuinely unset, `pending` | code review (`scope.row.create` reused unforked, same server-side defaults as every other capture path) |
| 4 | Multi-add: the search stays open, query clears, input re-focuses after a pick | `fast-add.spec.ts` |
| 5 | Rollforward copies factor + hierarchy + site forward, re-pins the prior dataset, skips an already-rolled-forward row, quantity `NULL` | `scopeRowRollforward.test.ts` |
| 6 | The preview flags a moved factor / not-in-selection / already-rolled-forward per row, resolving Scope 1/2 category labels through the UI taxonomy | `scopeRowRollforward.test.ts` |
| 7 | The panel sits directly below the site selector and above the scope→category cards | `fast-add.spec.ts` (bounding-box order check) |
| 8 | No uncatalogued serious/critical axe violations; no horizontal overflow at 390/768/1280/1920 | `scanWithBaseline(page, "fast-add")` + `expectNoHorizontalOverflow` |
| 9 | **Flag hard-precondition** — once `#fast-add` is present, every check is hard. The one conditional skip (flag not yet live) is removed at the flip PR. | `fast-add.spec.ts` `openFastAdd` |
| 10 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green · flag OFF leaves Data entry unchanged | ✅ |

## Verification (PR #93)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `@nzi/contracts` — unaffected (type-only additions). `@nzi/isolated-backend` — +5
  (`scopeRowRollforward.test.ts`). `@nzi/console` unit suite — +13 (`templateSearch.test.ts`).
- `fast-add.spec.ts` (5) — skips until `data-entry-fast-add` is live; **harden at flip**.
- Migration `0055` — apply to isolated staging before this PR's deploy (read by `listScopeRowRollforwardPreview`
  / `rollforwardScopeRows`, both always-on once the flag ships).

## Flip

Append `data-entry-fast-add` to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` in the Render dashboard + rebuild; add
to `render.yaml`. Harden `fast-add.spec.ts` (remove the flag skip), run against deployed staging, record
here + the human pass (screen-reader on the search combobox and the reuse checklist; keyboard-only multi-add
end to end; the "factor moved" and "already rolled forward" states read clearly without colour alone).

## Rollback

Presentational + additive. Remove `data-entry-fast-add` + rebuild — Data entry renders as before (no
template search, no reuse panel). No data loss: migration `0055`'s column stays in place and simply goes
unread; any rows already created via either facility remain ordinary scope rows, editable the same way
regardless of the flag's state.
