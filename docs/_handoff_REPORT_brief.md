# Handoff brief — Report (R-track) + print-safe icon set

The client-facing deliverable: compose the assured footprint, intensity, targets/pathway,
the decarbonisation plan and the SRS readiness statement into a report for screen, portal and
PDF. **Design reference:** `docs/prototypes/report_v1.html`. This also settles the print-safe
icon-set decision (below). Branch + PR; typecheck AND build green; charts via `@nzi/charts`;
figures derived from the assured snapshot, never captured.

Relates to the existing R-track flags (`NEXT_PUBLIC_FEATURE_REPORT_STUDIO`) and the older
`report_v3.html` — this brings the report into the redesign's design language.

## Decision settled — print-safe icon set
Metric/action icons are a **curated inline-SVG line-icon set** (currentColor, ~2px stroke),
shipped in `@nzi/ui` — **not emoji**. currentColor lets them tint with tokens and print
cleanly in mono; inline SVG is deterministic in the PDF (no font/emoji dependency). Source
from an MIT-licensed line set (e.g. Lucide/Phosphor), shipped inline so there's no runtime
fetch. This is the icon set the **intensity metrics** and **action levers** also use — so
their "report icon" pieces are now unblocked. (Recorded in DESIGN_CONVENTIONS.)

## Structure (per prototype)
🟢 1. Section model: Cover · Executive summary · Emissions (scope split + YoY) · Intensity ·
   Targets & pathway · Decarbonisation plan · UK SRS readiness statement · Methodology &
   provenance. Deliberately a **single light "paper" look** (print/PDF target), not
   theme-toggling.
🟢 2. Each section composes existing resolvers/charts — do NOT recompute: footprint & scope
   split, intensity metrics (with their icons + divider), target model + pathway, the
   **Reduction Strategies plan, grouped by lever** (#155/#162 — `composeReportPlan`, filtered to
   `include_in_report` at issue, with an "Other" group for strategies whose only lever was
   withdrawn). **Control level is shown per strategy in the report plan as a chip, frozen at
   issue** — an attribute of the strategy, never a grouping; lever stays the grouping. Never
   "sphere of influence", which is reserved for the SBTi framework.
   SRS readiness (radar + maturity + roadmap). Reuse `@nzi/charts`.
🔴 3. **Issuing a report freezes a composition, not just a snapshot.** The measurement snapshot
   freezes the footprint — but a report also quotes intensity, the plan and SRS readiness, which
   are **live records that keep changing**. So issuing must freeze the whole composition — the
   snapshot it rests on *plus everything else it quotes, as at that moment* — into its own
   immutable store. Otherwise editing next week's plan silently rewrites a report the client
   already holds, the exact failure immutability exists to prevent. (This is a migration →
   stops for review.) Every figure still resolves from assured/reviewed sources, never captured
   by hand. New issues use the client target model (net zero carries its residual, not zero —
   the earlier report-pathway fix); already-issued reports are untouched.
🟡 4. **Provenance in the report:** each data section carries factor set + version + data hash
   + as-at + quality tiers; the Methodology page states the assurance basis honestly —
   **"reviewed snapshot (internal review); not third-party assured"** (the platform records
   who reviewed, not who assured — never imply third-party assurance). Model the assurance basis
   as a **closed union whose only member today is "reviewed"** — not a boolean — so a
   third-party-assured claim is *unrepresentable* until the platform actually records an assurer,
   standard and scope. A boolean is one careless `true` from a false assurance claim on a
   client-facing document.
🟡 5. Outputs: on-screen (Report Studio), the **portal** (read-only), and **PDF/DOCX** (R5
   paged track) — the same section model and print-safe assets across all three.

## Acceptance (real data; build+typecheck green; on a PR)
- Report composes the live client's assured footprint, intensity (icons + divider), targets/
  pathway, plan and SRS statement — no recomputation, no seeded figures.
- Icons are the curated inline-SVG set (currentColor), not emoji; identical on screen, portal
  and PDF; no scope colour used for non-scope marks.
- Methodology states the honest assurance basis; provenance carries on every data section.
- An issued report is version-pinned/immutable; new issues use the client target model.
- Two clients produce different reports; a client missing data shows honest gaps, not zeros.
