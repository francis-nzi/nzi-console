# Handoff brief — Portal plan view (the client-facing Reduction Strategies plan)

Renders the client's **decarbonisation plan on the portal** — the actual strategies, live — not just
the deadline-signal counts that ship today. This is the surface the **transparent-plan decision
(NZC, 14 Sep 2026)** assumed and that was never built or tracked: `include_in_report` is a
**client-facing** flag gating *both* the report **and** a live portal plan the client watches take
shape. Right now the portal has only the #164 signal counts, so that decision is currently
unfulfilled. This brief closes the gap.

**Context (verified against main @ 02c6d03):**
- `PortalStrategiesReadModel` returns only totals/overdue/approaching/highlights (counts + worst-first
  exceptions from #164) — no plan listing, no portal route for one.
- The workspace plan and the **report** plan are both built (#155/#162): grouped by lever,
  `include_in_report` filtered (control level is captured per strategy but is not carried into the
  report today). The portal must be consistent with them — but **live**, not frozen.
- No backlog row exists for this (it's untracked) — Track 0 adds a §M row; this brief is that work.

**Decisions already settled that constrain this (do not re-litigate):**
- **One flag, one meaning.** `include_in_report` gates portal **and** report together. Do **not**
  add a second portal-only visibility flag. Default TRUE — the client watches the plan build live;
  setting it false is the deliberate hold-back that drops a strategy from *both* surfaces.
- **The portal plan is LIVE** — exempt from the published-snapshot rule. It resolves from current
  `client_strategies`, never from a `report_composition`. A plan is not a measurement, and a stale
  deadline is worse than a live one. (The **report** plan stays frozen; these are two different reads
  of the same data.)

---

## 1. Surface
- A **read-only** "Decarbonisation plan" (or "Reduction strategies") section in the **client portal**,
  under `apps/console/app/portal/`. No add / edit / remove / toggle from the portal — the client
  views, the consultant edits in the workspace.
- Sits with the existing #164 signals: keep the overdue / approaching summary at the top (reuse it),
  then the plan listing below.

## 2. What it shows
- The client's `client_strategies` where **`include_in_report = true`** (the single client-facing
  gate), **grouped by lever** — same grouping as the report and workspace. Withdrawn-lever strategies
  fall into an **"Other"** group (consistent with the report; deactivate-not-delete, never dropped).
- Per strategy: title, description, **control level** (per-strategy chip, not a grouping),
  scope, status, progress, and **target date with its due state** (approaching / overdue / none) —
  reuse the #164 read-time derivation so the two agree exactly.
- **SRS alignment per strategy** — which requirement(s) it advances. This is the client-facing half
  of the "shared spine": the plan the client sees points at the readiness gaps it closes.
- Owner: show the responsible party only if it's client-appropriate; if `owner` is an internal
  consultant handle, omit it from the portal (confirm with the team) — the portal is the client's
  view, not the internal one.

## 3. Live-read semantics
- Resolve from current `client_strategies` at request time — extend `PortalStrategiesReadModel` to
  return the plan rows alongside the counts it already produces. **No migration** (the data exists).
- An edit in the workspace is reflected on the client's next portal load — that's the point of "live."

## 4. Honest states
- **No plan yet** → an honest empty state ("Your reduction plan is being built with your consultant"),
  never a zero or a blank.
- **No date** on a strategy → show no date, never an invented one (matches the worker's rule).
- Excluded strategies (`include_in_report = false`) simply do not appear — no "hidden" placeholder.

## 5. Permission / tenancy
- Portal auth; strictly tenant-scoped to this client; only `include_in_report = true` rows. Read-only —
  no mutation endpoints reachable from the portal.

## 6. Consistency
- Same section model and wording as the report's "Decarbonisation plan" where it makes sense, so the
  client sees one coherent story across portal and report — but the portal is live and can expand,
  the report is frozen and paged. Use the lever-grouped **collapsible** convention (DESIGN_CONVENTIONS
  §3.2 / §3.4) if the list is long; a short plan can render expanded.
- Theme-aware; print-safe `NziIcon`; dd/mm/yyyy.

## Related copy fix (small, same PR or noted)
- The workspace `include_in_report` toggle should read as **client-facing** (its label/tooltip should
  say it controls what the client sees — portal **and** report — not "include in report" alone), so
  consultants understand what the flag gates now that it drives the live portal plan too.

## Acceptance (real data; build + typecheck green; on a PR)
- The portal shows the client's `include_in_report` strategies, grouped by lever, **live** (a
  workspace edit appears on next portal load — not a snapshot).
- Excluded strategies never appear; an empty plan shows the honest empty state; no invented dates;
  withdrawn-lever strategies group under "Other".
- SRS alignment shows per strategy; due states match the #164 signals exactly.
- Read-only and tenant-scoped; no portal mutation path exists.

## Sequencing / rules
- Read-side + portal view; **no migration** expected. Branch + PR; typecheck AND build green;
  theme-aware; print-safe; a test that the portal plan reflects a live edit and hides excluded rows.
- Backlog: add the §M row (Track 0) so this is tracked. NZC-069 stays held.
