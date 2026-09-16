# NZI Console — design conventions (locked)

The standing UI conventions for the redesign. These are **load-bearing**: build every new
screen to them, and don't diverge without a decision. Cross-references: `DECISIONS.md`
(NZC-###), `PERMISSION_MATRIX.md` (NZC-022), `ARCHITECTURE.md`.

## 1. Foundations

- **Type:** Inter throughout.
- **Palette:** Emerald `#0BA75E`, Deep Pine `#0B7A4B`, Midnight `#0B1B2B`, Signal Amber
  `#FFC24B`, Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`.
- **Scope identity is brand-locked and categorical:** Scope 1 coral, Scope 2 amber,
  Scope 3 emerald — fixed order, never recoloured by rank. Amber text is illegible, so
  Scope 2 *text* uses a darker ink token (`--s2-ink`), never the fill colour.
- **`--danger` is a separate semantic token** from the scope palette. Never reuse Drop
  Coral (Scope 1) to mean "error/destructive"; destructive actions use `--danger`.

## 2. Theme-aware, three-state

Define the full light palette on bare `:root`. Redefine tokens for dark only, guarded:
`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){…} }` and again under
`:root[data-theme="dark"]{…}` so an explicit toggle wins both ways. Never give a colour its
only definition inside a media/`[data-theme]` block; always paint `body` an explicit token
background.

## 3. Shell & navigation

- Shell: left global **WorkspaceRail** · top **TopBar** (command/search + breadcrumbs) ·
  main · right **drawer slot** (EvidenceDrawer + edit drawers render here, never inline).
- The **client workspace** has its own left **area sub-nav** (Overview, Carbon Analytics,
  Reporting, Actions, SRS Readiness / Tasks, Notes, Files, Communications / Company
  Profile, Financials, AI Profile), between the global rail and the content. Areas are
  navigated by the sub-nav, not the breadcrumb.

### 3.1 Breadcrumbs (locked)

Breadcrumbs carry the **full hierarchy including client context**, and **every crumb is a
link** — no crumb is ever plain text.

Structure (matches the live system):

| Page | Breadcrumb |
|---|---|
| Client workspace | `Clients / <Client name>` |
| Job workspace | `Clients / <Client name> / Jobs / <Job No>` |
| Job sub-area (Scope rows, Spend Data, …) | `Clients / <Client name> / Jobs / <Job No> / <Area>` |

Link targets — each resolves to a real route:

- **Clients** → `/clients`
- **&lt;Client name&gt;** → `/clients/{clientId}`
- **Jobs** → the client's jobs list (`/clients/{clientId}/jobs`, or the client-scoped jobs route)
- **&lt;Job No&gt;** → `/jobs/{jobId}` (label is the clean job number, e.g. `J000712`)
- **&lt;Area&gt;** → `/jobs/{jobId}/{area}` — the current page; still a real link, styled as
  current with `aria-current="page"`.

Rules:

- Produce breadcrumbs from **one shared builder/component** fed by canonical client/job
  data; the client is resolved from the job's `clientId` and **never omitted** on job pages.
- No ad-hoc per-page crumb markup; no `<b>`/`<span>` stand-ins for links.
- `<nav aria-label="Breadcrumb">`; separators are decorative; the last crumb carries
  `aria-current="page"`.

### 3.2 Collapsible cards (locked)

Client Overview cards are collapsible, and **only "Active jobs & milestone progress" is
expanded by default** — Activity, Emissions history, Baseline & targets, and any future
Overview card are collapsed by default. The chevron toggles the card; state is per-viewer
convenience (may use `localStorage`), never load-bearing.

### 3.3 Reduction Strategies (locked)

The client area is **Reduction Strategies**, never bare "Strategies": `Strategy` is already one
of the four SRS pillars, and one term means one thing. The `strategy` **domain** (a reduction
strategy a client is pursuing) is distinct from the SRS `strategy` **pillar** (a disclosure
requirement group), and neither may borrow the other's name.

The plan is grouped by **lever** — an Admin-managed theme, many-to-many with strategies, so a
strategy appears under every lever it belongs to. **Control level** (direct control / supply
chain / influence) is a separate single-value axis and renders as a chip, never as the
grouping. Lever sections follow §3.2: collapsible, header as the control, count visible when
collapsed, state per-viewer and never load-bearing.

### 3.4 Drawer / side-panel (locked)

**Canonical example: the job scope-row panel** — Jobs → a CRP job → Data entry → open a scope
row. Its header reads "Scope row · version N / *source* / Scope N", its sections are Factor &
calculation, Data quality, Apportionment & site, Source detail, Monthly activity and Evidence &
provenance, and its footer holds **Save & calculate** and **History**. Every drawer and side panel
matches that anatomy.

- **Fixed header + scrollable body + pinned footer.** The header is eyebrow + title + subtitle
  (`.nz-dh` with `.kick`, `h3`, `.m`). Only the body scrolls. The primary action lives in the
  footer and **never scrolls out of view**, however many sections are open. Client-workspace
  drawers use `.nz-dh` / `.nz-db` / `.nz-df`; the evidence panel uses `.nz-dh` / `.nz-dbody` /
  `.nz-dact`.
- **An error from the footer's action renders in the footer**, beside the button that caused it —
  not at the top of a body the person may have scrolled away from.
- **Collapsible sections use `@nzi/ui` `Collapsible`:** a **left-aligned chevron** that rotates
  (▸ closed / ▾ open), **collapsed by default**, with the header carrying a count or summary so
  where the content (or the selections) sit still reads while it is closed.
- **Never a tick or check as a section affordance.** A check means *selected* or *complete*; an
  open section is neither. The chevron is the only header affordance.
- A collapsible that has to stay in the DOM while closed (the Reduction Strategies lever groups,
  which search must still find) may be hand-rolled, but uses the same chevron glyph, position and
  rotation.

## 4. Editing model

- **Drawer-based editing everywhere.** Records are edited in drawers opened from the page,
  not on a separate `/edit` page. There is **one editor per thing** — do not keep both a
  drawer and an edit-form field for the same data.
- **One shared field model** backs create and edit (same field groups, same validation).
- **`GatedButton`** for persistent gates: `aria-disabled` (not native `disabled`) plus a
  visible reason, so the control stays focusable and the reason is announced.
- **`InfoTip`** for help-on-demand next to a field/figure, rather than inline help clutter.
- `Drawer` and `Tabs` are shared `@nzi/ui` primitives; reuse them, don't re-implement.

## 5. Evidence & truth

- **Evidence-drawer-first:** no figure appears without its lineage one click away. Every
  emissions figure carries a `◈ Evidence` affordance opening the EvidenceDrawer with the
  provenance signature (factor set + version + data hash + as-at date), the data-quality
  tier, and the calculation lineage. Figures are **derived from the assured snapshot, never
  captured** (NZC-066 issue-time stamping).
- **Distinct data states** — empty / loading / degraded / failed / success are visibly
  different. **Never render a failed query as zero.** A figure that can't be resolved reads
  **"unavailable"**; a client with no prior year reads **"No earlier reviewed year"**, never
  a fabricated vs-baseline %.
- **Resolve, don't seed.** Screens show resolved per-client/per-job data or an honest empty
  state — never seeded placeholder figures. Two different clients must render different data.

## 6. Governance in the UI

- Every mutation is a **permission-checked command that emits an audit event**; UI gating is
  convenience only, the server check is authoritative. Capabilities come from
  `PERMISSION_MATRIX.md` (NZC-022) — never invent a capability string in a component.
- **Deactivate, never delete** (contacts, sites, factors, …). No hard-delete controls.
- **Effective-dating** for boundary-affecting records (e.g. sites): records carry
  in-service / vacated dates; the reporting boundary is resolved per reporting year, and
  historical years keep a since-vacated record.
- **Governed changes** (re-baseline, target restatement) require a reason and are audited;
  targets are held by default on re-baseline (NZC-068).

## 7. Formatting

- **Dates `dd/mm/yyyy`** (NZC-040), everywhere, including inside drawers and timelines.
- Numbers tabular; emissions in `tCO₂e` (or `kgCO₂e/m²` where per-area); percentages signed
  where they express change (`−7.4%`).

## 8. Charts

- All charts render through `@nzi/charts` (one SVG spec → screen, PDF, portal); derived from
  data, never captured. Follow the `dataviz` method: one axis (never dual-axis — index to a
  common base instead), categorical hues assigned in fixed order, run the palette validator
  before adding categorical colours. Scope colours use the brand-locked identity above.

## 9. Intensity metrics (locked)

- Intensity metrics are **defined on the client** and their **annual values are recorded on
  the job** (per reporting year). **Employees** and **Turnover** are standard for every
  client (fixed icons; unit/divider editable; deactivate-not-delete, never removable); any
  number of **additionals** can be added per client.
- Each metric carries: label, unit wording, a **Per-N divider** (1 / 10 / 100 / 1,000 /
  10,000 / 100,000 / 1,000,000), and a **print-safe icon** from the curated NZI icon set
  (auto-suggested from the label, overridable). The icon and divider are part of the
  versioned definition.
- One resolver computes intensity (`emissions × divider ÷ value`) for **every surface** —
  the client YoY, the intensity detail, the client portal and the report — so they cannot
  diverge. A metric with no recorded value for a year reads **"unavailable"**, never 0.
- The metric's icon renders **identically** across the client YoY, the portal and the
  report (print determinism, same rule as charts).

## 10. Icons (locked)

- Metric, action and category icons are a **curated inline-SVG line-icon set** (currentColor,
  ~2px stroke), shipped in `@nzi/ui` — **not emoji**. currentColor lets an icon tint with the
  tokens and print cleanly in mono; inline SVG is deterministic in the PDF (no font/emoji
  dependency). Source from an MIT-licensed line set (e.g. Lucide / Phosphor), shipped inline
  (no runtime fetch). The same set serves intensity metrics, action levers and the report.
- Prototypes may use emoji as placeholders, but shipped UI and the report use the SVG set.

## 11. The report (locked)

- The client report is the **composition** of assured footprint, intensity, targets/pathway,
  the decarbonisation plan and the SRS readiness statement — it recomputes nothing; each
  section reads the same resolvers/charts as the app.
- A single, deliberate **light "paper" look** (print/PDF target), not theme-toggling.
- An **issued report is version-pinned and immutable** (frozen evidence). New issues use the
  client target model (net zero carries its residual, not zero); already-issued reports are
  never rewritten.
- Every data section carries provenance; the Methodology page states the assurance basis
  honestly — "reviewed snapshot (internal review); not third-party assured." Never imply
  third-party assurance.

## 12. Hot read models: essential vs adjunct (locked)

A read model that assembles a page composes two kinds of read, and they fail differently.

- **Essential** — the record the page *is*, and what it rests on. For `getClientWorkspace`: the
  client, its reviewed snapshots, the sites that set the reporting boundary, the targets measured
  against them. These **fail loudly**. A client record that rendered without its footprint would
  look healthy while being wrong, and hiding that is worse than a 503.
- **Adjunct** — everything feeding one card beside the record: contacts, consent history, reports,
  correspondence, files, readiness, intensity, the reduction plan. These **fail soft**, to an
  honest degraded state naming what could not be read.

`Promise.all` rejects on the first rejection, so an unwrapped adjunct read takes the whole page
with it. On **15 September 2026** exactly that happened: migration `0084` was unapplied on staging,
the consent read threw, and every client workspace returned 503 over a card nobody was looking at.

**A degraded part says "unavailable"; it never renders its fallback as fact.** An empty list and
"we could not read this" look identical on a page and mean opposite things — the same rule as
never showing a failed query as zero. The read model reports `degraded: [{ part, reason }]`, and
the card consults it before drawing.

The reason is one fixed sentence per part, not the database's message: the cause may be an
unapplied migration, a dropped connection or a permissions change, and the reader's next step is
the same in all three.

**Judgement, not reflex.** Do not soft-fail everything — the distinction is exactly what stops a
broken core record from rendering as a calm, empty page.

## 13. Inside a tenant transaction, `db` is one connection (locked)

**Never `Promise.all` queries on a `Queryable` handed to you by `withTenantRead`,
`withTenantWrite` or a command handler. Await them one at a time.**

That `db` is a **single pooled client** with an open transaction, not the pool. node-postgres
allows one query in flight per client, so firing several at once raises
`Calling client.query() when the client is already executing a query`. Today the driver queues
them and warns; a future major makes it an error. Parallelism was never real here — the queries
were always going to run one after another on one connection.

**Why this is a convention and not just a fixed bug.** It reads as an obvious optimisation, the
code looks correct, the data comes back right, and nothing fails. The only symptom is a
deprecation warning in a log — which is worse than a failure, because it is noise that shows up
near whatever else is going on. When `getSrsFramework` did this, the warning appeared beside an
unrelated optimistic-concurrency conflict during the NZC-080 seed run and made a
wrong-version-passed bug look like a race, which cost a diagnosis. A warning that misattributes
other failures is a real cost, not a tidiness issue.

**Enforced, not just written down.** `packages/isolated-backend/tests/srsFrameworkRead.test.ts`
drives the read through a fake that is stricter than the driver: it refuses overlap outright
rather than queueing, so a reintroduced `Promise.all` fails a test rather than printing a warning
nobody reads. Apply the same fake to any read model that fans out.

**Where parallelism is fine:** separate `pool.query()` calls, or separate `withTenantRead` calls —
each checks out its own client. The rule is about sharing *one* client, not about concurrency in
general.

## 14. Idempotent things are tested twice, and once over a dirtied database (locked)

**A test of a seed, a replayed command, or any operation that claims to be re-runnable must run
it at least twice and assert on the state after the second run.** A single run does not test
idempotency; it tests the first run.

**Why.** Replay bugs are invisible to a single pass by construction. The first run creates, and
everything looks right; the second meets state the first left behind, and that is where the fault
lives. The NZC-080 acceptance seed proves the shape three times over — every one of its failures
appeared only on a re-run:

- an already-withdrawn strategy being updated again, which `client.strategy.update` refuses
  outright (`REMOVED`) — the skip guard exempted exactly the case that intends to end withdrawn;
- a draft assessment left by a failed run, which `srs.assessment.start` refuses to start beside;
- a version threaded from the wrong entity, which only diverges once a row has been written once.

Each was found by running against staging, at a round-trip apiece, and each left a half-applied
fixture in a real client's plan. None was reachable by a first run, and none was visible to
typecheck: the command inputs type `status` and `expectedVersion` loosely, and two of the three
rules are enforced only at runtime.

**What "twice" has to mean.** The second run must go through the same entry point with the same
arguments — not a hand-built "now simulate a replay". The assertions that matter are on the second
run's *outcome*: no duplicate rows, ids unchanged, and the states that should have been left alone
left alone. Assert the count as well as the contents; a duplicate is the most common replay bug
and the easiest to miss when you only check that a thing exists.

**And once over a dirtied database.** Running twice on a fresh database proves convergence *within
one version*, and nothing more. Both runs are the same build, so their idempotency keys — which
are payload hashes — line up, the replay succeeds, and the replay hides everything underneath it.

Real state is not like that. A client carries rows from earlier versions of the seed, whose keys
no longer match anything the current build will produce: the replay misses, the command is issued
for real, and a business guard refuses it. That is precisely how the NZC-080 seed's fourth failure
reached staging (`client.strategy.assign` → `ALREADY_ASSIGNED`) after CI had run it twice, green.

So the test must also **pre-dirty the database with foreign keys** — state written under
idempotency keys the seed cannot match — and then assert the seed converges onto it. Seeding the
same client twice does not do it, and will pass while the bug is live.

**Which is why convergence is a property of reading, not of keys.** A key replays a command *this
build* issued. Reading asks "is this already true?", which has one answer no matter which version
asked. Every create step should reconcile by reading first and fall back to creating — and match
on the thing's identity **regardless of soft-deleted state**, or an assign after a withdrawal
quietly produces a second row for one entity, which is worse than the error it avoided.

**Enforced by example:** `packages/isolated-backend/tests/portalAcceptanceSeed.test.ts` runs the
whole sequence twice against a real Postgres. With the old skip guard restored it fails on the
second run and passes on the first — which is exactly the property this convention exists to
catch, and worth verifying that way when you write one.

## 15. A merged branch is deleted, and a merge is verified on `main` (locked)

The mechanical complement to §14, and to the working rule **"once a PR is in review, the next
commit goes on a new branch"**.

**Enable *Automatically delete head branches* on the repository** — GitHub → Settings → General →
Pull Requests, or:

```
gh api -X PATCH repos/francis-nzi/nzi-console -f delete_branch_on_merge=true
```

Locally, `git fetch --prune` so a deleted branch stops appearing in your own view.

**The class this closes.** A squash-merge rewrites the branch's commits into one new commit, so
git can no longer match the branch's patches against `main`. A branch that outlives its PR
therefore invites a second commit that **silently never lands**: the PR says merged, `main` looks
healthy, and the work is simply absent.

It has bitten twice:

- **#193** — the NZC-084 "docs are a distinct corpus" rule was pushed after the PR was cut, and
  merged as part of a later PR only because it was noticed.
- **#199** — the seed fix, its error surfacing and its real-Postgres test were pushed after review
  started; the squash took the earlier commit, and `main` kept the bug that had just been
  diagnosed and endorsed.

Both times **nothing failed**. No test, no build, no check: the branch pushed cleanly, the PR
merged cleanly, and the only symptom was work that was not there. That puts it in the same family
as the committed conflict markers of NZC-086 — damage no gate can see, because every gate is
asking whether the code works, and absent code works fine.

**What deleting the branch actually buys.** Not literal impossibility: a later `git push` from a
local clone recreates the remote branch. What it removes is the *silence* — there is no open PR
for that push to update, and the recreated branch is visibly unmerged rather than looking like a
contribution to something already landed.

**So verify on `main`, by content, never by PR number.** A merged PR is a claim about a branch, not
about `main`. Check the thing itself:

```
git fetch origin && git show origin/main:path/to/file | grep <the change>
git ls-tree --name-only origin/main <dir> | grep <new file>
```

If the change is not in `main`, it did not ship — whatever the PR says.
