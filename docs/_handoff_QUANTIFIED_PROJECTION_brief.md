# Handoff brief — Quantified emissions projection from strategies (Stage 2, staff-console)

Adds the first **quantitative** layer to Reduction Strategies: a consultant's estimated reduction per
strategy, rolled up into a **bottom-up projected trajectory** shown against the existing **top-down
target pathway** and **measured actuals**. §G row 9. **Staff console only** this phase — not report,
not portal (those are later phases with their own discipline).

**The non-negotiable (holds regardless of anything below):** a projection is a forward **estimate**,
never conflated with the assured/measured footprint. Always labelled *projected*, always carrying its
assumptions and the baseline it rests on, always shown honestly against actuals. Estimate ≠ measurement.
A test must assert the projected series is never sourced from, or rendered as, the assured snapshot.

**The framing that makes this worth building — three trajectories:**
- **Target** (top-down, *needed*) — the existing pathway from `getClientTargets` / `getBenchmarkInForce`.
- **Projected** (bottom-up, *planned*) — this feature: what the client's actual strategies are expected
  to deliver.
- **Actual** (measured) — the assured snapshots.
The value is the **gaps**: plan vs target ("your plan delivers X, your target needs Y, gap Z") and plan
vs actual ("is the plan materialising"). This *reuses* the target machinery — it does not create a
parallel truth.

**Decisions (confirmed by Francis, 15 Sep 2026 — record as an NZC entry):**
1. **Basis: consultant estimate + library default.** The consultant enters the expected reduction,
   optionally seeded by a per-strategy library default; it's explicitly an estimate with assumptions.
   **Not** modelled-from-activity (that risks false precision and is a far larger build).
2. **Expression: either tCO₂e/yr or % of a baseline, both resolved to tCO₂e/yr** for the roll-up.
3. **% baseline = the benchmark in force** (`getBenchmarkInForce`) — the same denominator the target
   pathway uses, so bottom-up and top-down are directly comparable.
4. **Timing: steps in at `target_date`** — the full annual reduction applies from the target date
   onward, nothing before. An **undated** strategy contributes **nothing** to the trajectory (no
   invented date) and is flagged so the consultant knows to date it.
5. **Overlap: sum, and flag over-claim.** Sum all reductions; if a scope's projected reductions exceed
   that scope's footprint, show an **honest warning**, never a silent cap. The consultant resolves it.
6. **Surfaces: staff console only** this phase.

---

## 1. Data model (migration via the runner → stops for review)
- A reduction estimate on the client strategy (extend `client_strategies` or a child table):
  `amount`, `unit` (`tco2e_per_year` | `percent`), the **scope/category** the reduction applies to,
  the **resolved `tco2e_per_year`**, an **assumptions/method** note, optional **confidence**, and the
  **provenance** (seeded from library default vX / consultant-overridden). Versioned + audited like the
  rest of the strategy.
- Library strategies (`reduction_strategies`) carry an optional **default estimate** to seed from.
- A `percent` resolves against the **benchmark-in-force** total for its scope/category → `tco2e_per_year`.
  Staff-console + live this phase, so resolve live; when a later phase puts it in the report it freezes
  into the composition at issue like everything else.

## 2. The projected trajectory
- Bottom-up: sum of per-strategy `tco2e_per_year`, each **stepping in at its `target_date`**, applied
  to the benchmark-in-force baseline across the pathway horizon → a projected emissions line over time.
- Rendered against the existing **target pathway** and **measured actuals**: three series — needed /
  planned / measured. Chart via `@nzi/charts`; **follow the `dataviz` skill** (three-series line, fixed
  series identity, accessible, legible in the report's light paper look later — but staff theme-aware now).
- Surface the **plan-vs-target gap** explicitly (a number, not just two lines), and — where a strategy's
  `target_date` has already passed — **plan-vs-actual**: did the claimed reduction materialise in the
  measured footprint? If not, say so; don't keep asserting a projection the actuals have overtaken.
- **Baseline consistency + honesty:** use the same baseline as the target pathway; honour
  `benchmarkStale` (NZC-068) — if the benchmark is held/stale, the projection says so rather than
  implying movement against a benchmark that no longer applies.

## 3. Over-claim guard
- Per scope: sum projected reductions; if they exceed that scope's footprint (would drive it below
  zero), raise an honest warning on the scope **and** on the contributing strategies. Never cap
  silently. Same guard at the total-footprint level.
- The consultant resolves by adjusting estimates. (Consultant-marked strategy *interactions* for finer
  overlap accounting is a noted future enhancement, not this phase.)

## 4. Honesty / provenance
- Every projected figure is labelled **projected / estimate**, carries its basis (consultant estimate;
  seeded from library default vX or overridden), its assumptions, and the baseline it resolved against.
  Never rendered as measured; visually distinct from the assured footprint line.
- A strategy with **no estimate** contributes nothing and shows "no estimate" — not zero-as-fact.
- A strategy with **no `target_date`** contributes nothing to the trajectory and is flagged, not zeroed.

## 5. Permission
- Entering a reduction estimate is part of managing a client strategy → reuse **`strategy.manage`** if it
  fits (it should); add nothing new unless it genuinely changes access. Every mutation permission-checked
  + audited.

## Acceptance (real data; build + typecheck green; on a PR)
- A consultant enters a reduction estimate (tCO₂e/yr or % of the benchmark-in-force baseline), seeded
  from a library default, with assumptions; it resolves to tCO₂e/yr and is provenanced.
- The projected trajectory is the sum stepping in at each `target_date`, on the target's baseline, shown
  against target and actual with an explicit plan-vs-target gap.
- A scope over-claim raises a warning, never a silent cap; an undated or estimate-less strategy
  contributes nothing and is flagged, not zeroed.
- The projected series is never conflated with the assured footprint (asserted by test); everything
  labelled projected with provenance; `benchmarkStale` honoured.
- Staff console only; migration via the runner; permission-checked + audited.

## Sequencing / rules
- **This phase:** the estimate model (migration → stops for review), the roll-up, the three-trajectory
  view + gap, the over-claim guard — staff console only.
- **Later phases (noted, not now):** report inclusion (freeze the projection into the composition at
  issue; client-facing estimate discipline), portal inclusion, and consultant-marked strategy
  interactions for finer overlap.
- Branch + PR; typecheck AND build green; migration via the **runner + ledger**; **apply the migration
  to staging before the merge deploys** (or rely on the new pre-deploy gate once it's proven);
  theme-aware; `dataviz` for the chart; dd/mm/yyyy; honest states. Record the NZC decision. NZC-069 held.
