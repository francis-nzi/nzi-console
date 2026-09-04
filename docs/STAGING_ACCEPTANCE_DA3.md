# DA3 — Data Assurance surface (a+b+c) · staging acceptance record

Gate: `docs/ACCEPTANCE_DA3_ASSURANCE.md`. Decisions **NZC-059/NZC-060**. Flag `data-assurance` in
`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`.

## Flip

`data-assurance` appended to the Render dashboard `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value and the rebuild
deployed — **Francis, 4 Sep 2026**. Confirmed live on the seeded CRP job (`/jobs/712`, J000712).

## Automated gate — PASS (4 Sep 2026, deployed staging)

**Cowork automated pass** — deployed staging `/jobs/712`, `data-assurance` live. Surface faithful to the
prototype (`review_qa_v1.html`):

- Five-year trend (2023 BL pill / 2024 current), separate **% vs BL** column, **Integrity** column, tabs
  (5-year trend / By scope / By site / Audit / Intensity), Export trend CSV, right-hand Data assurance
  drawer + sign-off.
- **Gap engine live**: 2 gaps — the completeness flag firing on the 1,260→0 row; **% vs BL correctly
  renders "—" where the baseline is zero, no divide-by-zero.**
- **Responsive** 390 / 768 / 1280 / 1920: zero page overflow (wide tables scroll within their own panels).
- **Contrast**: min text contrast 5.02, passes WCAG AA.
- **Type**: Inter throughout (NZC-003).

`data-assurance.spec.ts` was **hardened** immediately after this pass — the conditional flag-skip removed
from `openAssurance`, so the surface's presence is now a hard precondition (fail loud, no silent skip; same
`stage-sections.spec.ts` discipline every other flipped slice this track uses). Re-running the suite against
deployed staging is the next automatable step to fold into this record (the pass above was run before the
hardening landed, against the same live surface the hardened spec now asserts unconditionally).

## Gate status

| Gate item (from `ACCEPTANCE_DA3_ASSURANCE.md`) | State |
|---|---|
| DA3a #1 · Baseline BL pill + priors + current; `% vs BL` own column | ✅ Cowork pass |
| DA3a #2 · `% vs BL` neutral-grey tone when driven by an unresolved flag | ✅ unit (`percentVsBaselineTone`) |
| DA3a #3 · `getAssuranceScreen` composes trend + 4-flag gap engine + audit rows | ✅ unit |
| DA3a #4 · Tabs switch views; By site flags Unallocated; Audit flags unmapped | ✅ Cowork pass |
| DA3a #5 · Failed `/assurance` → alert + Retry, never a zeroed table | ✅ e2e (`data-assurance.spec.ts`) |
| DA3a #6 · axe baseline clean; no horizontal overflow 390/768/1280/1920 | ✅ Cowork pass (min contrast 5.02, AA) |
| DA3a #7 · Flag hard-precondition, no silent skip | ✅ **hardened this record** — `openAssurance` skip removed |
| DA3a #8 · Drawer overlays — table width unchanged open/closed | ✅ e2e |
| DA3a #9 · Resolve-with-reason persists; stale version → conflict | ✅ e2e + unit |
| DA3a #10 · Audit row selection shows row-detail in drawer | ✅ e2e |
| DA3a #11 · typecheck / build / unit suites green; flag OFF unchanged | ✅ |
| DA3a #12 · **Human-only** — screen-reader, keyboard, reduced-motion, BL/current tint AA | ⏳ Francis |
| DA3c #1–5 · Gap gate (`GAPS_OPEN`/`QA_INCOMPLETE`), row approval reuse, sign-off panel + gate | ✅ unit + e2e |

## Rollback

Remove `data-assurance` from `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` + rebuild — Review & QA renders as it did
before DA3. `data-assurance.spec.ts` then fails loudly by design (hard precondition), so pair a rollback
with reverting/skipping the spec. No data / route / schema change — DA1's `0052`/`0054` migrations stay in
place and simply go unread without this surface.
