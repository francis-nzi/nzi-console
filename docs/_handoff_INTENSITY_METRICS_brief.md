# Handoff brief — Intensity metrics workflow + Overview collapsible defaults

Two things from the client-side review. **Design references:**
- Client side — `docs/prototypes/client_workspace_v11.html` (Carbon Analytics → "⚙ Manage
  metrics" drawer; the intensity YoY with icons; the Overview collapsible defaults).
- Job side — `docs/prototypes/job_annual_metrics_v1.html` (the per-reporting-year value
  capture: standard Employees/Turnover entered, site-derived Floor area auto-resolved with
  override, Per-N divider, computed intensity, and the future-time seam).
- Portal side — `docs/prototypes/portal_intensity_v1.html` (the client-facing view: assured
  metric tiles with sparklines + YoY deltas, a YoY chart with the same icons/divider, plain
  language — read-only, same resolver as the console; "lower is better").

Branch + PR; typecheck AND build green; permission-gate per `docs/PERMISSION_MATRIX.md`;
distinct empty/loading/failed states throughout.

---

## Part A — Overview collapsible defaults (quick)

🟢 Every card in the client Overview is collapsible, and **only "Active jobs & milestone
progress" is expanded by default** — Activity, Emissions history, Baseline & targets (and
any future Overview card) are collapsed by default. (This is now locked in
`docs/DESIGN_CONVENTIONS.md` §3.2.) Aside cards (Contacts, Sites) stay as they are unless
told otherwise.

---

## Part B — Intensity metrics: new workflow (client defines, job records)

Today intensity bases are hard-coded (revenue / FTE / m²). Replace that with a
**client-defined metric set** whose **annual values are recorded on the job**, matching the
live system's per-metric wording + **Per-N divider**, with a **per-metric icon** that
travels to the client YoY, the client portal and the report.

### Model
🔴 1. `client_intensity_metrics` (definition, versioned, deactivate-not-delete): `key`,
   `label`, `unit_wording`, `divider` (1 / 10 / 100 / 1,000 / 10,000 / 100,000 / 1,000,000),
   `icon`, `is_standard`, `active`, ordering. **Employees** and **Turnover** are seeded as
   standard for every client (fixed icons, editable unit/divider, not removable — deactivate
   only). Additionals are client-specific.
🔴 2. `job_intensity_values` (per job × reporting year): the recorded value for each active
   metric (Employees, Turnover, + additionals). Standard two are always present; additionals
   follow the client's definitions at the time of capture. **Design the job capture so a
   `time`/period dimension can be added later without reshaping the table** (Francis has
   flagged time is coming and will be recorded through the job).
🔴 3. One intensity resolver used by every surface: `intensity = emissions × divider ÷ value`
   (i.e. "tCO₂e per N units"). A metric with no recorded value for a year reads
   **"unavailable"** for that year, never 0. The YoY chart, the intensity detail, the
   portal and the report all read this one resolver — they can't diverge.

### Icons (auto-suggested + override — Francis's choice)
🟡 4. A **curated, print-safe NZI icon set** (SVG, not emoji — the prototype uses emoji only
   as placeholders). Standard metrics get fixed icons (people / currency). An additional
   metric's icon is **suggested from its label** with an **override picker** over the curated
   set. The chosen icon is stored on the definition and **rendered identically** in the
   client YoY, the client portal, and the report (print determinism — same rule as
   `@nzi/charts`).

### Surfaces
🟢 5. **Client — define** (Carbon Analytics → "⚙ Manage metrics" drawer, per v11): manage the
   set (label, unit, Per-N divider, icon), add/deactivate additionals. Gated on a config
   capability.
🟢 6. **Job — record**: an "Annual metrics" capture on the job (per reporting year) for the
   active metrics; Employees + Turnover always shown, additionals from the client set.
🟢 7. **Client — YoY**: the intensity chart is driven by the defined metrics (not hard-coded),
   each shown with its icon; the Per-N divider is reflected in the unit label
   (e.g. "tCO₂e per 1,000 employees"); keep the "All metrics (indexed)" combined view.
🟡 8. **Portal**: surface the client's intensity metrics (with icons) to portal users, read
   from the same resolver — portal realm, so respect its auth/boundary.
🟡 9. **Report**: metric icons + values render in the report; print-safe icon set; figures
   from the resolver, derived not captured (consistent with the frozen-report rules — new
   issues use this; issued reports stay as they were).

### Acceptance
- A client can define Employees + Turnover (standard) plus any number of additionals, each
  with unit wording, a Per-N divider, and an icon (suggested + overridable).
- A job records annual values per reporting year for the active metrics; the capture leaves
  room for a future time dimension.
- The client YoY, the intensity detail, the portal and the report all show the same computed
  intensities from one resolver; a metric with no value for a year shows "unavailable".
- Each metric's chosen icon renders identically across YoY, portal and report (print-safe).
- Deactivating a metric keeps it for historical reports; nothing is hard-deleted.
- typecheck + build green.
