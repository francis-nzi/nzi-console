# NZI Console — rendered acceptance pass

Closes the "rendered observation awaits a connected browser" gates left open in
`DEVELOPMENT_PLAN.md` (M1 P5, M2, M3 S4) and `STAGING_ACCEPTANCE_M1/M2/M3.md`.

Two parts:

1. **Automated** — a Playwright suite (`apps/console/tests/e2e`) that renders every
   screen against **deployed isolated staging**, asserts the five explicit states
   (never a failed query as zero), runs an axe-core WCAG 2.1 A/AA scan on each, and
   captures phone/tablet/laptop/wide screenshots with a no-horizontal-overflow
   assertion.
2. **Manual** — the assistive-technology narration pass below, which a screen-reader
   review requires and automation cannot substitute for (WCAG "AT review", not just
   rule checks).

---

## 1. Automated suite

### One-time: provision the acceptance accounts

The suite logs in as a real staff principal and a real portal principal. Provision
them once against **isolated non-production only**:

```bash
NZI_ISOLATED_DATABASE_URL=…                       \
NZI_DATABASE_BOUNDARY=isolated-non-production      \
NZI_CONSOLE_MFA_ENCRYPTION_KEY=…                   \
npm run acceptance:provision
```

It refuses to run against anything not flagged `isolated-non-production`, creates
`acceptance-admin` (staff / administrator) and `acceptance-portal` (portal user,
granted to a job that has a published report), and prints six values.

### Run

```bash
export STAGING_BASE_URL=https://nzi-pro-api-prod.onrender.com   # default
export ACCEPTANCE_STAFF_EMAIL=…  ACCEPTANCE_STAFF_PASSWORD=…  ACCEPTANCE_STAFF_TOTP=…
export ACCEPTANCE_PORTAL_EMAIL=… ACCEPTANCE_PORTAL_PASSWORD=… ACCEPTANCE_PORTAL_TOTP=…
npx playwright install chromium        # first run only
npm run test:e2e
npm run test:e2e:report                # opens the HTML report
```

Without the `ACCEPTANCE_*` variables the auth-gated specs **skip** and only the
public-page coverage (the staff and portal sign-in screens) runs — useful as a smoke check.

### What it covers

| Spec | Milestone | Asserts |
|---|---|---|
| `staff-workspaces.spec.ts` | M3 S1–S3 | Control Room, Clients (+detail), Jobs, Datasets, Reports (+detail), Platform, Charts, LCA, Sales each render real content — no `failed`/`degraded` state, no console errors, no 5xx |
| `crp-workspace.spec.ts` | M2 C1–C3 | CRP job workspace renders end to end incl. the per-entity register and client-factor panel; `/factors` returns 200 (numeric/text UNION regression guard, PR #2) |
| `portal.spec.ts` | M1 | Portal login (real password + TOTP) → portfolio → a granted job's published-report workspace or an explicit state; account security page |
| `accessibility.spec.ts` | M1 P5 / M3 S4 | axe-core WCAG 2.1 A/AA on every route; fails on any serious/critical not in `axe-baseline.json`; every critical fails unless fixed in-branch |
| `responsive.spec.ts` | M1 P5 / M3 S4 | 390 / 768 / 1280 / 1920 px — full-page screenshot + `scrollWidth ≤ innerWidth` on each route |

Artifacts land in `apps/console/test-results/` (axe JSON per page, `screens/*.png`,
`playwright-report/`) — gitignored; attach them to the staging acceptance record.

### axe baseline

`apps/console/tests/e2e/axe-baseline.json` lists the currently-accepted violations:

- **`fixed-pending-deploy`** — corrected in the branch that introduced this suite
  (`.nz-auth-progress` `aria-label` on a bare div → `aria-hidden`; `CommandSearch`
  input missing `role="combobox"`). Remove these entries and re-run once deployed;
  the scan must then be green for them.
- **`catalogued-contrast`** — `--t3` (`#8A968F`) muted text at 3.07:1 on white, the
  rail section headings (`#5E7385` on Midnight, 3.53:1), and small bold white on
  Emerald (3.13:1). These need a deliberate design-token contrast pass — a
  **NZC-003 palette decision for Francis**, not a rushed edit. Proposed minimal
  change: darken `--t3` to ≈ `#6B7671` (4.5:1 on white) and the rail muted token
  to ≈ `#8DA2B4` (4.5:1 on Midnight); review the visual hierarchy after.

Any **new** serious/critical violation fails the scan.

---

## 2. Manual assistive-technology pass

Run against `STAGING_BASE_URL` with a real screen reader (NVDA + Firefox on
Windows, or VoiceOver + Safari on macOS). Record pass/fail and notes per row in the
relevant `STAGING_ACCEPTANCE_M*.md`.

### Keyboard & focus (all milestones)

- [ ] `Tab` from page load reaches a visible **skip link**; activating it moves focus to `<main>`.
- [ ] Every interactive control is reachable by `Tab` in a sensible order; focus ring always visible.
- [ ] Workspace rail: `Tab`/`Shift+Tab` moves between links; `Enter` navigates; current item is `aria-current`.
- [ ] Command search: `/` or click focuses it; `↑`/`↓` move the active option; `Enter` navigates; `Esc` closes; `aria-activedescendant` tracks.
- [ ] Evidence drawer opens on selection, takes focus, traps focus while open, restores focus to the trigger on close, closes on `Esc`.
- [ ] CRP register + per-entity register: rows operable by keyboard; inline editors reachable; `Save`/`Cancel` reachable.
- [ ] Modplus/confirm dialogs (`window.confirm` replacements, if any) are focus-trapped.
- [ ] No keyboard trap anywhere; `Shift+Tab` always escapes.

### Screen-reader narration

- [ ] Page `<title>` and the first heading announce the workspace and job/client context.
- [ ] Landmarks: one `banner`, one `navigation` (labelled), one `main`, the drawer as `complementary`/`dialog`.
- [ ] The five states are distinguishable by narration: **loading** ("Retrieving data"), **empty** ("Ready for first record"), **degraded** (a `status` announcing partial data + reference), **failed** (an `alert` "Workspace unavailable" + reference), **success**. A failed query is never read as "0".
- [ ] Data-quality tier and provenance for a measurement are reachable and announced from the drawer.
- [ ] Form errors: each invalid field is associated (`aria-describedby`) and the summary is an `alert`.
- [ ] Tables: column headers announced per cell; row/column counts sensible; sort state announced if sortable.
- [ ] Charts (`@nzi/charts`): each has an accessible name and a text alternative (title/desc or adjacent summary); not announced as a bare image.
- [ ] Portal: report approval is announced as version-bound ("applies only to version …"); the review thread reads in order with authorship.
- [ ] Live regions: a save/submit outcome is announced without moving focus unexpectedly.

### Visual / low-vision

- [ ] 200% browser zoom: no loss of content or function; no horizontal scroll on the main column (the automated suite checks this at fixed widths — confirm the reflow reads correctly).
- [ ] `prefers-reduced-motion`: transitions/animations suppressed (drawer, section expand/collapse).
- [ ] `prefers-contrast: more` / forced-colors: controls and focus remain visible.
- [ ] Colour is never the only signal for scope identity, state, or validity (icon/label present too).

### Milestone journeys (end-to-end, rendered)

- [ ] **M1** — invitation enrolment (password + authenticator) → sign in → portfolio → open a published report → approve a version → post a review comment → provide authorised data in each entry kind (manual / spend / commuting / vehicle) → sign out. Session expiry mid-flow recovers cleanly.
- [ ] **M2** — configure a CRP job (period, sites, categories, datasets, targets) → enter scope-row + per-entity activity (incl. monthly) → resolve factors → inspect lineage → complete QA → freeze a reviewed snapshot → validate → publish → verify the immutable portal publication and audit/outbox evidence.
- [ ] **M3** — each of Clients, Jobs, Datasets, Reports, Platform: role-appropriate controls present, permission-denied paths explained (not blank), live boundaries (no fixture fallback), failure states explicit.

---

## 3. Recording the result

For each milestone, update `docs/STAGING_ACCEPTANCE_M<n>.md`:

- the commit/revision tested and the `STAGING_BASE_URL`;
- the Playwright run summary (passed / skipped / failed) and the report artifact;
- the axe baseline state (catalogued vs. resolved);
- the manual checklist result with notes and any new findings;
- anything still open.
