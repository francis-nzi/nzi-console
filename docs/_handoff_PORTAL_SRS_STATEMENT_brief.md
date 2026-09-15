# Handoff brief — Portal SRS readiness statement (client-facing, live)

Completes the client's portal picture. We've given them a live **plan** (#173 — what they're doing);
this adds a live **readiness statement** (where they stand), so the two sit together: *where I stand,
and what I'm doing about it.* It's §H row 4 ("Portal surfacing of readiness, read-only, M6.4"),
briefed and until now Stage 2.

**Context (verified against main):**
- SRS readiness is built: framework + 48 requirements / 4 pillars (0070), and a staff assessment view
  (`SrsArea.tsx`) with `SrsPillarRadar`, `SrsMaturityBullets`, `SrsGapHeatmap`, `SrsReadinessTrend` —
  all proven, print-safe.
- The **report** SRS section is frozen (maturity + radar + roadmap, from the composition).
- The reverse link (#170) maps requirement → addressing client strategies (withdrawn excluded).
- The portal already has the plan (#173) and deadline signals (#164), via `PortalReductionPlan`.

**The governing distinction — LIVE, not frozen.** The **report** readiness statement resolves from the
frozen composition (a client holds a report as-issued). The **portal** readiness statement is **live** —
it resolves from the *current* assessment, exactly as the portal plan is live. Readiness is an ongoing
assessment, not a measurement snapshot; a stale readiness on the portal would be worse than a live one.
Do **not** read `report_compositions` here. The portal readiness is the live twin of the report's frozen
roadmap, the same way the portal plan is the live twin of the report's frozen plan.

**Design call I've made (the one open question): show the reverse link client-side — yes.** Per gap,
the portal shows which of the client's own strategies address it. Reasons: it's the transparent-plan
philosophy applied to readiness; it's the payoff of mandatory alignment made visible to the client;
and it exposes nothing new — the client already sees their strategies and each strategy's SRS
alignment in the plan view, so this is just the other axis of data they already hold. It ties the
portal plan and the portal readiness into one coherent "gap → what we're doing" story.

---

## 1. Surface
- A **read-only** SRS readiness section in the client portal, sitting with the plan (`apps/console/app/portal/`).
  Together they read as one page: readiness (where I stand) + plan (what I'm doing).
- No editing, no assessment input from the portal — the client views; the consultant assesses in the
  staff console.

## 2. What it shows (live)
- **Overall readiness** (overall %, overall label) and **per-pillar maturity** (the 4 pillars, each
  with its maturity level/label) — from the *current* assessment.
- **Gaps**, shortfall-ordered (reuse the existing `gaps()` builder — no second ordering), grouped by
  pillar.
- **Per gap: the client's strategies that address it** — live reverse inversion (#170), withdrawn
  excluded. A gap with no aligned strategy shows an honest "no strategy aligned yet" — that's useful
  signal to the client, not something to hide.
- Reuse the proven components where they fit: `SrsPillarRadar` and `SrsMaturityBullets` (theme-aware,
  print-safe already). Screen surface, so it needn't be print-constrained, but the existing components
  are fine.

## 3. Honest states
- **No assessment yet** → an honest empty state ("Your readiness assessment is in progress"), never a
  0% presented as a real score.
- Never render a maturity or % that isn't actually assessed; never invent a gap's addressing strategy.
- **Do not leak internal assessment working notes / scoring rationale** — same discipline as `owner`
  and `notes` on the portal plan: show the client-appropriate readiness (levels, gaps, addressing
  strategies), not the consultant's internal assessment commentary.

## 4. Permission / tenancy
- Portal auth; strictly the client's own organisation; read-only. No new capability. No mutation path
  reachable from the portal.

## 5. Consistency
- Same section model and wording as the report's readiness statement where it makes sense, so portal
  and report tell one story — but the portal is **live and interactive-read**, the report **frozen and
  paged**. Theme-aware; `NziIcon`; dd/mm/yyyy.

## Acceptance (real data; build + typecheck green; on a PR)
- The portal shows the client's **current** readiness: overall + per-pillar maturity + shortfall-ordered
  gaps — **live** (reflects a staff re-assessment on next portal load; not a composition).
- Each gap shows the client's addressing strategies (live, withdrawn excluded); an unaddressed gap
  shows the honest marker.
- No assessment → honest empty state; read-only; tenant-scoped; no internal assessment notes exposed.
- Reuses `gaps()` and the existing readiness components; theme-aware.

## Sequencing / rules
- Read-side + portal view; **no migration expected** (assessment, strategies and the reverse inversion
  all exist). If you find you need one, stop for review. Branch + PR; typecheck AND build green;
  theme-aware; print-safe `NziIcon`. Test: the portal readiness reflects a live re-assessment and maps
  each gap to its addressing strategies (withdrawn excluded, honest marker when none). Update §H row 4
  to Built with the PR. NZC-069 held.
