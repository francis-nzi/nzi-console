# NZI Console — Clients and Jobs lists: parity with live v7

**What this is.** The plan for bringing `/clients` (`ClientsBoard.tsx`) and `/jobs` (`JobsIndex.tsx`) up to live
v7's searching, filtering, sorting and paging. It is here for ruling before the build. **Nothing is built yet.**

**Status (29 Sep 2026).** Characterised from the console and from v7's code (only its `frontend/src`, `api/` and
`sql_migrations/`). **Ruled 29 Sep 2026 — approved; PR 1 built** (`feat/list-parity`).

**The rulings.**

- **D1 — Risk is deferred to PR 2.** PR 1 is §2–§5 without the Risk column or filter, and so carries no migration.
  PR 2 (separate, ruled) adds the `job_milestones` model, `job_plan` in the extract contract, a loader backfill for
  imported jobs, and the milestone-based Risk rule with its column and filter.
- **D2 — approved, landing with Risk.** The column stays "Risk"; the `at-risk` status is relabelled "At risk
  (relationship)" when the Risk column lands (PR 2), not before.
- **D3 — approved.** The Jobs manager filter is an exact match on the resolved label (job manager → job owner →
  client manager), with options from the tenant's data.
- **D4 — approved.** Option counts are faceted: over the search and every *other* active filter.
- **D5 — approved.** Jobs Status defaults to every status except cancelled, and the control shows that default.
- **D6 — approved.** Search lives in each list's toolbar. `CommandSearch` stays the workspace jumper, with a
  corrected placeholder.

**As built, where it differs in detail from §2–§5 below.**

- The full-set reads survive as `listAllClients` / `listAllJobs` (Control Room, the job-create client picker, one
  client by id). The paged reads take the names `listClients` / `listJobs` and are served at
  `/api/isolated/client-list` and `/api/isolated/job-list`. The existing `clients`/`jobs` endpoints are unchanged
  for their other callers.
- The empty distinction is made by the board, not the screen contract. The list contracts are never "empty"; the page
  carries `unfilteredTotal`, which is 0 for "no clients yet", while `total` is 0 for "none match".
- The Clients "Reports due / overdue" tile (a pattern match on a free-text label) is replaced by "Without an owner".
  The honest version of that tile is Risk, which comes in PR 2.
- The averages (completeness, progress) are over the rows that record one. An unrecorded value is not a nought; the
  old browser average counted it as 0.
- A page past the end is served as the last page, and the response says which page it served.
- The TopBar placeholder is fixed in one place ("Go to a workspace…"), and the per-page placeholder prop is
  removed from every page.

## 1. Where things stand

**Console.**

- Both pages call `loadScreen` → `/api/isolated/<key>` → `withTenantRead(pool, org, listX)`.
- `listClients` and `listJobs` (`readModels.ts`) have no `WHERE`, `LIMIT` or parameters. Both route handlers are
  `GET()` with no request, so they cannot read a query string.
- Filtering is done in the browser with pills. The TopBar `CommandSearch` only jumps between 9 workspaces.
- There is no shared table, pagination or `aria-sort` anywhere in the codebase. The only clamp precedent is
  `listAuditEvents` (1–250).
- `isEmpty` in the screen contract treats an empty array as "Nothing here yet". A filter that matches nothing would
  hit that and hide the toolbar.
- The metric strips on both pages are computed from the full list in the browser. They stop being true once the
  list is paged.

**v7** (the behaviour this matches):

| | Clients (`api/client_index_routes.py`) | Jobs (`api/job_management_routes.py`) |
|---|---|---|
| Search | name, industry (`ILIKE`, 250 ms debounce) | job number, title, client name (300 ms) |
| Filters | Industry, Status, Owner, Portfolio, Risk (exact); Client Manager (partial) | CRM (`coalesce(job.crm_name, client.crm_owner)`, partial); Job Group; End date "next 60 days" |
| Filter options | facets with counts, from the tenant's data | CRM from active users; Job Group hard-coded |
| Sort | Client, Industry, Status, Owner, Risk | Job, Client, Title, CRM, End date, Status, Risk |
| Paging | 25/50/100/200, default 50, cap 200; Prev/Next; "Page X of Y"; "N total" | same |
| Other | archived clients hidden by default | default sort: job number descending |

**The Risk rule in v7 is milestone-based, not date-of-job-end:**

- A job is **Overdue** if any unfinished milestone (data collection, first draft or final report, from `job_plan`)
  is more than 1 day past due.
- A job is **Due** if an unfinished milestone falls due within 7 days.
- Otherwise the job is **Healthy**, and that includes a job with no milestones at all.
- A client takes the worst of all its jobs.
- `jobs.due_date` (End date) plays no part.

## 2. The shared list mechanism

This is one mechanism, reused by both pages. Nothing is bespoke to either page.

- **`@nzi/contracts` — `listQuery`.** This holds a typed `ListQuery<SortKey, FilterKey>`:
  `{ search, filters, sort: {key, dir}, page, pageSize }`. It also holds
  `parseListQuery(searchParams, spec)` and `listQueryToSearchParams(query)`.
  - Parsing is a whitelist. Unknown filter or sort keys are dropped, `pageSize` must be one of 25/50/100/200
    (default 50), `page` is clamped to 1 or more, and search is trimmed and capped at 200 characters.
  - The URL is the only state. `page.tsx` hands `searchParams` to `parseListQuery`, and every control writes a new
    URL (`router.replace`, with page reset to 1 when a filter or search changes).
  - A filtered view can be shared and survives a refresh.
- **`@nzi/isolated-backend` — `listPage`.** This builds a parameterised SQL fragment from a per-list spec:
  - searchable expressions;
  - filter key → expression (exact, or `ANY($n)` for multi-select);
  - sort key → expression, always with a unique tiebreaker (`client_id` / `sequence`) so pages are stable.
  - Values are always bound parameters. Identifiers only ever come from the spec, never from input.
  - It runs `count(*) over ()` with `LIMIT/OFFSET` in one query, then one query for `filterOptions`.
  - Everything runs inside the caller's `withTenantRead`, so RLS scopes rows, totals and options alike.
- **`listClients` / `listJobs`** take `(db, query)` and return `{ rows, total, page, pageSize, filterOptions }`.
  - Existing callers that want the whole list are the Control Room, the job-create form's client picker and
    `?client=`. They move to named reads (`listClientsForPicker`, etc.) rather than an unbounded default.
- **Routes** become `GET(request)`, pass the parsed query through, and return 400 on a malformed query rather than
  silently coercing it.
- **`@nzi/ui` — `DataList`.** One accessible table and toolbar:
  - a labelled search input (debounced, then written to the URL);
  - labelled `<select>`s built from `filterOptions`, each option showing its count;
  - `aria-sort` on every sortable `<th>`, with a real `<button>` inside;
  - a page-size select, Prev/Next, "Page X of Y", "N total", and a "Clear filters" link.
  - The row's primary cell is a real `<a>` (to `/clients/{id}` and `/jobs/{id}`). A single click, or Enter from
    the keyboard, opens the client or job.
  - On Clients, clicking elsewhere on the row still selects it for the Evidence Drawer (drawer-first), and that
    also works from the keyboard.
- **Empty states.** "No clients yet" and "No clients match these filters" (with Clear filters) are two distinct
  states. The contract's `isEmpty` looks at `total` with no filters applied, not at the page's rows. A failed read
  stays a failure and is never shown as zero.

## 3. Clients

- **Search:** name and industry label (`coalesce(sector label, sector)`).
- **Filters:**

| Filter | Source |
|---|---|
| Industry | `sector_value_id`'s label, falling back to `sector` |
| Status | active / onboarding / at-risk / prospect |
| Owner | `owner_user_id`'s membership label, falling back to `owner_name` |
| Portfolio | `portfolio` |
| Client Manager | `client_manager_user_id`'s label, falling back to `client_manager` |
| Risk | see D1 |

- **Filter options:** Blank values appear as "Unspecified" or "Unassigned", and match rows where the value is
  NULL.
- **Sort:** Client, Industry, Status, Owner, Risk, and the existing metric columns where they are real columns.
- **Metric strip:** computed on the server over the filtered set (total, plus a count per Risk band), so it stays
  true across pages.

## 4. Jobs

- **Search:** job number (the console number and `legacy_job_number`), title and client name.
- **Filters:**

| Filter | Source |
|---|---|
| Client Manager | the job's `client_manager_user_id` label, then its `owner_name`, then the client's manager label (see D3) |
| Job family | `job_family`, with options from the families present |
| End date | from/to range on `due_date`, with a "Next 60 days" preset matching v7 |
| Status | `status` |
| Risk | see D1 |

- **Sort:** Job (default, newest first), Client, Title, Client Manager, End date (nulls last), Status, Risk.
- **`?client=`** becomes an ordinary server-side filter, not a browser-side one.

## 5. Tests

These are real-Postgres suites (`listPageReal.test.ts`), seeding `org-a` and `org-b` with overlapping names,
industries, owners and portfolios:

- A search or filter that matches only org-b's rows returns 0 rows and 0 total in org-a.
- org-a's `filterOptions` never contain an org-b value, and the per-option counts are org-a's own.
- Each filter, the search, each sort key in both directions (including the tiebreak) and the paging arithmetic
  (last partial page, a page past the end) are covered.
- An unknown sort or filter key is refused. Every value is bound, and a hostile value (for example
  `'; drop …`, `%`, `_`) is matched literally.
- The Risk rule is covered at each boundary: −2, −1, 0, +7 and +8 days, completed milestones, and no milestones.
- There are unit tests for `parseListQuery` and `listQueryToSearchParams` (round trip, clamping).
- For `DataList`, a render test checks `aria-sort`, the labels, the link-first rows and keyboard selection.

## 6. For ruling

- **D1 — where Risk comes from.** v7 derives it from `job_plan` milestones. The console has no milestone model, and
  the v7 import did not extract `job_plan` (it is not among the 15 tables).
  - Deriving Risk from `due_date` would put a different meaning under the same word, which breaks
    one-term-one-meaning.
  - Showing "Healthy" for jobs with no milestone data would present missing data as good news.
  - **Recommendation:**
    - **PR 1 (this workstream):** add a `job_milestones` table (a migration with job, kind, due and completed
      columns, under RLS). Define Risk once in the read model as v7's rule over that table. Show **"Not set"**
      when a job has no milestones, and let the Risk filter include "Not set".
    - **PR 2 (follow-up):** add `job_plan` to the extract contract and a loader step that fills
      `job_milestones` for already-imported jobs. That requires a re-extract and a governed re-run of the
      load, ruled separately.
  - The alternative is to leave Risk out of PR 1 and bring it in with PR 2.
- **D2 — two meanings of "risk".** Client *status* already has `at-risk` (a relationship status). The new *Risk*
  column is milestone risk. Recommendation: keep the column name "Risk" as ruled, and rename the status label to
  "At risk (relationship)" in the Status filter and badge. The stored value does not change.
- **D3 — the Jobs manager filter.** v7 matches free text against `coalesce(job.crm_name, client.crm_owner)`.
  Recommendation: an exact match on the resolved label, in the order job manager → job owner → client manager,
  with options from the tenant's data (per the ruling), not from the active-user list.
- **D4 — option counts.** v7 counts each option against the current search (a faceted count). Recommendation:
  counts over the current search plus every *other* active filter (standard faceting), so no option leads to an
  empty page.
- **D5 — archived.** v7 hides archived clients by default. The console's client status has no archived value, and
  imported archived jobs are `cancelled`. Recommendation: the Jobs Status filter defaults to "all except
  cancelled", with the default shown in the control and not hidden.
- **D6 — the TopBar search.** Recommendation: search lives in each list's toolbar. `CommandSearch` stays the
  workspace jumper, and its "Search clients…" placeholder changes to say what it does. Wiring global search across
  entities is a separate piece of work.

**Delivery.** PR 1 covers §2–§5, with D1 as ruled. It is governed: it opens for ruling, and it merges only with
`ruled` on that head. The migration in PR 1 is frozen once opened.

---

## 7. PR 2 — milestone Risk (ruled 29 Sep 2026, built)

The PR 2 plan was reviewed before any of this was built, and its findings from v7's code are restated where they matter. This section
records the rulings and what was built.

**The rulings.**

- **R1 — the client roll-up's job set.** Provisionally **(b)**: cancelled jobs are excluded. v7 rolls up over every job
  (`api/client_index_routes.py:150–154`, no status predicate). The choice is confirmed on the dry-run numbers before
  commit. The dry run reports both (a) and (b), and names every client where (b) differs from v7, with the job and
  milestone behind it. Changing it is one line: `CLIENT_RISK_JOBS` in `milestoneRisk.ts`.
- **R2 — `job_plan` only.** `--tables job_plan` for the SQL generator and the manifest. The manifest records the
  subset, and the extract is deleted after the load.
- **R3 — re-runs.** v7 wins where the console has not touched the row. Where both sides changed, the job is refused and
  reported by job and kind, never silently.
- **R4 — who completed it.** v7's text is kept verbatim as `completed_by_label` (staff, unsealed, in the PII inventory).
  `completed_by_user_id` is set only on an exact, unique match to a membership. The report gives counts, not values.
- **R5 — rank.** Overdue 3 > Due 2 > Healthy 1 > Not set 0.
- **R6 — colours.** A status role, distinct from the scope-identity hues, with the label always beside the dot.
- **R7 — read side only.** The milestone command, the job-page control and the audit trail for edits are PR 3.
  Console-created jobs read "Not set" until then.
- **A1 — the operating day.** The console judges Risk on `todayInLondon()`. v7's `CURRENT_DATE` is UTC and turns over
  an hour early during British Summer Time. This is a **deliberate, more correct deviation** from v7. The parity check
  substitutes the same London day into v7's own rule, so the differences it reports are real rule differences, not
  timezone artefacts.
- **A2 — dirty v7 data.** A "completed by" with no completion keeps the due date, drops the label, and is counted. A
  completion with no "completed by" is fine.

**As built.**

- **Migration `0137_job_milestones.sql`:** operational and mutable. The application role may SELECT, INSERT and
  UPDATE, with no DELETE. RLS is forced. The primary key is `(organisation, job, kind)`.
  - The v7 identity (`source_system`, `legacy_db_id` = `<v7 job_id>:<kind>`) and `legacy_values` — the v7 values as
    last loaded — are what R3 compares. A console edit is therefore never mistaken for a v7 change.
  - There is no separate job index: the primary key already leads with `(organisation_id, job_id)`.
  - The migration is frozen from the moment the PR opens; any correction is 0138.
- **`milestoneRisk.ts`:** the one definition. It holds:
  - the SQL fragments both lists read — a per-job rank, and a per-client rank over the R1 job set;
  - `riskOf`, the same rule in TypeScript.
  - A real-database test runs both over the same rows on three operating days.
  - `jobs.due_date` is not referenced, and a test changes it wildly to prove it.
- **Contract:** `job_plan` is added to the extract contract. The three due dates and three completions are
  **required**, so an omitted completion cannot silently read as unfinished. "Completed by" and `updated_at` are
  optional.
  - Whenever `job_plan` is copied, `v7_client_risk.csv` is written beside it, in the same snapshot, and recorded in the
    manifest under `derived`. It holds v7's `_RISK_CASE_SQL` verbatim, with the London day substituted.
- **`load-v7-milestones`:** a separate step from the client load. That load treats history as immutable, and would
  refuse clients whose v7 data moved on since the first extract. This step reads only `job_plan`, one transaction per
  client, and a dry run is the load rolled back. It writes one audit event per client touched.
  - A `job_plan` row whose job is not in the console is reported, never created.
- **The lists:**
  - Risk is a column, a faceted filter (a fixed vocabulary of four levels, in severity order, with zero counts shown),
    and a sort on severity (ascending puts Overdue first, as v7's does).
  - Both specs take the operating day as a bound parameter.
  - The Overdue count joins both summaries, and the Clients hero line leads with it.
- **D2:** `clientStatusMeta["at-risk"]` reads "At risk (relationship)", which is the one source of that label. The
  Clients drawer banner no longer implies milestone risk.
