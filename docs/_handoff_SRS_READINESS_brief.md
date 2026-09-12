# Handoff brief — SRS Readiness (redesign)

Rebuild SRS Readiness as an intuitive, consultant-led assessment whose **output graphics are
a demo/sales asset**. Grounded in the review `docs/SRS_READINESS_REVIEW.md`. **Design
reference:** `docs/prototypes/srs_readiness_v1.html` (dashboard) — assessment register,
radar, maturity bullets, gap heatmap, roadmap, evidence & trend, benchmark slot. Branch +
PR; typecheck AND build green; gate on `srs.manage` (NZC-022); distinct empty/loading/failed
states; charts on the status/sequential palette (never the scope palette), print-safe.

## Decisions taken (Francis)
1. **Maturity = 5-step ladder:** Not started → Developing → Established → Advanced → Assured.
2. **Lead with S2 (climate); S1 (general) alongside** — both across the four ISSB/TCFD
   pillars (Governance, Strategy, Risk management, Metrics & targets).
3. **Future-proof structurally now** — build the model so benchmarking, extra standards and
   extra metrics can light up later without a reshape; ship the parts we can today.
4. **Framework is Admin-managed + versioned** (standards · pillars · requirements · weights ·
   maturity definitions), so the tool tracks UK SRS changes (e.g. the 2027 mandatory rules)
   without code.
5. **Consultant-led** assessment for now; the portal shows readiness **read-only**. Leave the
   door open to client self-assessment / configurable who-controls-what later.

## Context (why now)
UK SRS S1/S2 published 25 Feb 2026 (UK-endorsed IFRS S1/S2), voluntary now, mandatory
proposed early 2027. The commercial window is the voluntary period — the tool answers "how
ready are we, and what's the path?" for clients and prospects.

## Model (versioned; deactivate-not-delete)
🔴 1. **Framework** (Admin-managed, versioned): `standards` (S1, S2, extensible), `pillars`
   (the four), `requirements` (per standard×pillar), `weights`, `maturity_definitions` (the
   5 levels). Versioning lets the framework evolve without code; assessments record which
   framework version they used.
🔴 2. **Assessment** (per client, dated + versioned): per requirement — `maturity` (0–4),
   `evidence` (doc/data ref/note, or none), `owner`, `due`, `source` (entered | auto from NZI
   data), and an optional `gap → action` link. Rolls requirement → pillar → standard →
   overall (weighted). Reassessable over time (trend).
🟡 3. **Future-proof slots (structure now, populate later):** a `sector`/peer tag +
   `benchmark` percentile slot on the assessment (no invented peer data — renders "Future"
   until a defensible dataset exists); the standards/requirements set is data-driven so new
   standards or the 2027 mandatory requirements are added as data.

## Reuse & links
🟡 4. **Metrics & targets pillar pre-fills from NZI data** — the assured footprint (S1/2/3),
   targets and intensity already in the client; provenance carries through. Don't re-ask.
🟢 5. **Gaps → actions:** a requirement below target creates/links an action in the
   **action-lever library** (owner, date, sphere) — the roadmap and the decarbonisation plan
   share one spine.

## UI (match the prototype)
🟢 6. **Dashboard:** overall header (level + % + evidence coverage + target), **pillar radar
   (S1 vs S2)**, **maturity bullet bars** per pillar (fill + S1 marker + target), **gap
   heatmap** (requirements × 5-step ladder), **evidence coverage**, **trend**, **roadmap**
   (gaps→actions), and the **benchmark "Future"** card.
🟢 7. **Assessment register** — requirement · std · pillar · maturity · evidence · gap→action;
   the guided, save-as-you-go, sectioned assessment (S2 first) with InfoTip help per
   requirement. Consultant-led; `srs.manage`.
🟡 8. **Report + Portal:** a **Readiness statement** section for the report (R-track) and a
   **read-only** portal readiness view — both from the same resolver/graphics, print-safe.
   (Portal is view-only for now per decision 5.)

## Acceptance (real data; build+typecheck green; on a PR)
- Framework is Admin-managed + versioned; an assessment records its framework version.
- Requirement-level maturity (5-step) + evidence + owner/due; rolls up to pillar/standard/
  overall weighted; reassessment produces a trend.
- Metrics & targets pillar pre-fills from the assured NZI data (not re-keyed).
- Gaps below target become linked actions; the roadmap reflects them.
- Dashboard graphics render per the prototype on the status/sequential palette, print-safe,
  and identically in the report; portal shows readiness read-only.
- Benchmark renders a truthful "Future" state — no invented peer numbers.
- Two clients show different readiness; nothing fabricated; `srs.manage` gates assessing.
