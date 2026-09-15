# Handoff brief — SRS readiness roadmap in the report

Completes the report's SRS section. Section 06 ("UK SRS readiness statement") today renders
**maturity** (table) + **radar** (#171, from the frozen composition). The missing third piece is the
**roadmap** — the shortfall-ordered list of gaps the client should focus on next, and, now that the
reverse link exists (#170), **which of their strategies address each gap** — frozen into the report at
issue. This is where mandatory SRS alignment pays off inside the client-facing deliverable: each gap,
and what the client is doing about it, on the page.

**Context (verified against main):**
- `ReportSrsSection` carries maturity + radar; it carries **no gap data**, so the frozen composition
  cannot currently render a roadmap. This brief adds that.
- The `gaps()` builder already exists in `@nzi/contracts` — shortfall-ordered, stable. Reuse it; do
  not write a second ordering.
- The reverse inversion (#170) maps requirement → addressing client strategies, and it correctly
  **excludes withdrawn strategies** (a gap must not look addressed by work the client stopped).
- The radar (#171) established the pattern this follows exactly: an **optional** block composed at
  **issue** into the `ReportSrsSection` jsonb payload — **no migration**.

**The governing rule (unchanged, and load-bearing here):** the report is **frozen**. Everything the
roadmap shows — the gaps *and* the strategies addressing them — must resolve **at issue** from the
**frozen composition** (the frozen readiness + the frozen plan that #155/#162 already capture), never
live. A report issued last month must show the gaps and strategies as they were then, even after this
week's plan edits. This is the whole reason composition-freeze exists; do not read live records here.

---

## 1. What the roadmap is
- The shortfall-ordered list of SRS **gaps** — requirements below target on the frozen readiness —
  grouped by pillar, ordered by shortfall within (via `gaps()`).
- Per gap: pillar, requirement (code + label), the shortfall/status, and **the client strategies
  aligned to it** — resolved from the **frozen plan** in the composition (the strategies that were
  `include_in_report` at issue), each with its title and status as frozen.
- A gap with **no aligned strategy** shows that honestly ("no strategy aligned yet") — this is
  valuable signal to the client, not something to hide. Never invent one.

## 2. Composition (compose at issue, optional, no migration)
- Extend the `ReportSrsSection` payload with an **optional `roadmap`** block, assembled **at issue**
  from the frozen readiness + frozen plan — same shape/pattern the radar used (#171).
- **Optional matters:** compositions frozen before this change render maturity + radar (or maturity
  alone, for pre-radar ones) and **no roadmap** — never back-fill a roadmap into a document the client
  already holds. Old reports are immutable.
- The requirement→strategies mapping is computed from the frozen plan **inside the composition**, so
  it's the reverse link's *frozen* form — consistent with the plan section of the same report, and it
  moves with re-issue, not with live edits.

## 3. Rendering (Section 06, after maturity + radar)
- Render the roadmap after the radar: gaps in shortfall order, grouped by pillar; each gap lists its
  addressing strategies (title + frozen status) or the honest "no strategy aligned yet".
- Print-safe (inline SVG / currentColor / `NziIcon`); reads from the frozen composition only.
- Consistent with the plan section's wording so the client sees one story: the plan lists what they're
  doing by lever; the roadmap lists what each SRS gap needs and which of those strategies close it.

## 4. Testing (mirror the radar's split, given console can't render React)
- **Payload assembly in `@nzi/contracts`** (behavioural, headless, runs in CI): given a frozen
  readiness + frozen plan, `roadmap` is shortfall-ordered, groups by pillar, maps each gap to its
  frozen addressing strategies, excludes withdrawn ones, and emits the honest empty marker for an
  unaddressed gap.
- **Optionality test:** a composition without a roadmap block renders the section without one (no
  back-fill, no crash).
- A render test where feasible (`@nzi/charts`/report section) that the frozen roadmap produces
  print-safe output. Keep the `@nzi/charts` CI step that #171 added.

## Acceptance (real data; build + typecheck green; on a PR)
- Issuing a report freezes a shortfall-ordered roadmap into `ReportSrsSection`; Section 06 renders
  maturity + radar + roadmap, each from the frozen composition.
- Each gap shows the strategies addressing it **as frozen at issue** (withdrawn excluded); an
  unaddressed gap shows the honest marker.
- A report issued before this change renders without a roadmap — no back-fill.
- Later plan edits do not change an already-issued report's roadmap (re-issue supersedes).
- Ordering reuses `gaps()`; no second ordering introduced.

## Sequencing / rules
- Read/compose + render; **no migration** (jsonb payload, like the radar). If you find you need one,
  stop for review. Branch + PR; typecheck AND build green; theme-aware; print-safe `NziIcon`;
  dd/mm/yyyy. Update the backlog §H / report rows to Built with the PR when it lands. NZC-069 held.
