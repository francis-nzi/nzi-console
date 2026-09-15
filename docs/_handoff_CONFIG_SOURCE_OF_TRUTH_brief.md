# Handoff brief — Config source-of-truth reconciliation (render.yaml vs dashboard)

The staging service (`nzi-console`) and the `nzi-console-reminders` worker were created **manually, not
from a Blueprint** ("no Blueprint instances"). So Render does **not** read `render.yaml` for them — the
effective config is whatever's in the **Render dashboard**. Yet `render.yaml` (and REDESIGN_ROLLOUT.md)
claim to be "the single source of truth," including for the **redesign feature flags**. That claim is
false for a non-Blueprint service, and the risk is **silent drift**: a flag or env var believed set from
`render.yaml` can differ from the dashboard, so staging can behave differently from what the "source of
truth" says — a redesign feature believed live that isn't, or one believed off that's on, with nobody
the wiser. Surfaced by the gate work (the `preDeployCommand` had to be set in the dashboard, not
`render.yaml`).

**Goal:** make the documentation tell the truth, and find any *actual* drift between declared and live
config — the **feature flags** above all.

**Scope:** the services `render.yaml` describes — `nzi-console` (staging web) + `nzi-console-reminders`
(worker). **Production (`nzi-insights-pro-api-live`) is out of scope** — separate service, its own
config, and the live-site-untouched principle holds.

**Non-goal this pass — adopting the Blueprint.** Making `render.yaml` authoritative via a Blueprint is
the eventual right end-state (source-controlled, reviewed IaC — what the comment *wanted* to be true),
but it risks duplicating the manually-created services and is a deliberate separate migration. This pass
documents reality and removes the false claims; it *recommends* Blueprint adoption as a future decision,
it does not do it.

---

## Phase 1 — repo-only (Claude Code, now — no dashboard needed)
1. **Declared inventory.** From `render.yaml`, list every declared item for both services: all env vars
   (name + declared value, or `sync:false`), `buildCommand`, `startCommand`, `preDeployCommand`,
   `healthCheckPath`, `autoDeploy`, `plan`, `region`, `branch`. Flag the **`NEXT_PUBLIC_FEATURE_*`**
   flags specifically — they gate the redesign rollout and are the highest-risk drift.
2. **False-claim inventory.** Grep the repo for every place asserting `render.yaml` (or any file) is the
   "single source of truth" / authoritative for config or flags — `render.yaml`'s own comments,
   REDESIGN_ROLLOUT.md §"Feature-flag strategy", DEPLOYMENT.md, anywhere else. List them verbatim with
   file+line.
3. **Comparison checklist.** Produce a per-service table Francis can fill from the dashboard — each
   declared value beside an empty "dashboard actual / matches?" column — covering the Environment tab
   values and Settings → Deploy (Build / Start / Pre-Deploy commands, Auto-Deploy). Commit it to `docs/`
   as the working drift report.

## Phase 2 — reconcile (after Francis supplies the dashboard readout)
4. **Compare declared vs actual; flag every drift.** For each drift, the decision is Francis's, per item:
   the dashboard is what's *live*, so either update `render.yaml` to match reality (if the live value is
   correct) **or** change the dashboard to match intent (if `render.yaml` held the intended value and the
   dashboard is wrong). **Feature-flag drift is the priority** — a flag live-on-but-declared-off (or the
   reverse) means staging ≠ the believed state, which is a silent bug, not a doc nit.
5. **Fix the false claims.** Rewrite the "single source of truth" comments/text to the truth: for these
   non-Blueprint services the **Render dashboard is the effective source of truth**; `render.yaml` is
   documentation and the carrier for a future Blueprint rebuild, not the active mechanism — mirroring
   what DEPLOYMENT.md now says about the gate. Re-grep afterwards to confirm no false claim remains.
6. **Record an NZC decision.** Config source-of-truth for the manually-created services is the dashboard;
   `render.yaml` is documentation; full Blueprint adoption (to make `render.yaml` authoritative again) is
   a recommended future migration, explicitly not done here.

## Deliverables
- The **drift report** (declared vs actual, every drift flagged) committed to `docs/`.
- **Corrected docs** — no false "source of truth" claim remains anywhere (proven by re-grep).
- The **NZC decision**.
- Any drift that changes staging behaviour — especially a flag — called out explicitly for Francis to
  action in the dashboard, separate from the doc fixes.

## Rules
- Investigation + docs; no code/schema change expected. A drift *fix* that needs a dashboard change is
  Francis's to apply (deployment surface). Branch + PR; the doc/decision changes stop for review
  (DECISIONS.md is a standing merge exception — Francis merges). Production out of scope. NZC-069 held.
