# UX1e — stage-as-section CRP workspace · acceptance

Brings the `/jobs/[jobId]` page-level IA in line with `docs/prototypes/crp_v3.html` and **NZC-038**
(stage-as-section: active stage expanded, prior stages a one-line summary, later stages a to-do card).
This is the reusable module shell the job-family modules (**NZC-024**) replicate — CRP is the reference.

**Flag:** `job-stage-sections` (a token in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`, OFF by default). When off,
the legacy command-centre scroll is unchanged.

## Increments

| # | Scope | State |
|---|---|---|
| **e1** | Stage-section **shell** + **Setup** stage (datasets, reduction pathway, intensity, sites, PG&S categories, client factors) + **Data Entry** stage (accordion only). Later stages (Factor Mapping / Review & QA / Report & Publish) host their *existing* panels inside collapsed sections — nothing is lost. Command hero + metrics + work-grid → one compact **focus strip** (readiness · next action · exception jumps). | 🟢 built (PR TBD) |
| **e2** | Dedicated **Factor Mapping** surface (unmatched-factor resolution list → drawer) and **Review & QA** surface (independent-review queue + portal review queue as first-class stage content, not the flat register). | ⏳ |
| **e3** | **Report & Publish** stage polish (snapshot → manifest → release lineage as the prototype) + retire the legacy command hero / flat-scroll path once e1–e3 are accepted. | ⏳ |

Deferred (later, on top): per-stage sub-routes (`/jobs/[id]/data` …).

## e1 — gate

Behind `job-stage-sections` ON, on isolated staging, a staff user on a CRP job:

1. **Five stage sections** render in workflow order (Setup · Data entry · Factor mapping · Review & QA · Report & publish), each with a number badge coloured by status (done ✓ / active / to do).
2. **Data Entry** lands **expanded** and contains **only** the accordion (+ its site context + lens + the inline Add-entry form). No config panels, no register, no release control leaking in.
3. **Setup** contains the six controlled-input panels; it is collapsed unless it is the active stage, and its header shows the summary line (`N datasets · −X% by YYYY · intensity vN · N sites · N PG&S`).
4. Prior stages collapse to their summary; later stages show a to-do summary; every section toggles open/closed from its header (`aria-expanded`).
5. The **focus strip** replaces the command hero — readiness %, the recommended next action, and three exception jump-buttons (`N calculations` → Data entry, `N without a factor` → Factor mapping, `N QA decisions` → Review & QA) that open **and** scroll to that stage.
6. The **workflow stage control** (advance / go back / transition note / history) still works.
7. Opening a scope row (from the accordion or the flat register inside Review & QA) still opens the evidence drawer with the full calculate → review → history → snapshot lifecycle.
8. Automated: `apps/console/tests/e2e/stage-sections.spec.ts` green; `npm run typecheck`; `@nzi/console` build; 81 console tests.
9. **Human-only** (once, like every rendered adapter pass): screen-reader narration of the stage headers + focus strip + collapse/expand; contrast eyeball on the stage badges / status pills; no horizontal overflow at 390 / 768 / 1280 / 1920; reduced-motion (the chevron rotate + scroll).

## Rollback

`job-stage-sections` is presentational and purely additive — the legacy body (`stageSectionsOn ? stageBody : <legacy>`) is untouched. Remove the token from `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` and the command-centre scroll returns. No data, route or schema change.

## Flip

`NEXT_PUBLIC_*` is inlined at `next build`, so testing e1 on deployed staging needs the token in `render.yaml` (a one-line PR that triggers a rebuild). Land e1 with the flag **off**; flip via a follow-up `render.yaml` PR for the acceptance run; roll back the one-liner if the human pass fails. Once e1–e3 are all accepted, fold `job-stage-sections` into the permanent value alongside `data-entry-accordion`.
