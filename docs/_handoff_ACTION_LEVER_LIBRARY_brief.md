# Handoff brief — Action-lever library (the Actions area)

Turn the qualitative A2-lite Actions tracker into the client's **decarbonisation plan**
built from an Admin-managed **lever catalogue**. Go-live item. **Design reference:**
`docs/prototypes/client_workspace_v12.html` (Actions area + the "Add from library" drawer).
Branch + PR; typecheck AND build green; permission-gate per `docs/PERMISSION_MATRIX.md`
(`actions.manage`); distinct empty/loading/failed states.

Grounding: live `report_actions_routes`, `action_lever_framework` (migration 0064),
`/clients/{id}/report-actions`, `action-lever-summary`. This is the "Plan" half of a CRP —
keep it distinct from the measurement (scope rows).

## Model
🔴 1. `action_levers` (catalogue, Admin-managed, versioned, deactivate-not-delete): `key`,
   `title`, `scope` (1/2/3/governance), `category`, `sphere_of_influence` (direct control /
   supply chain / influence), `icon`, `active`. Seeded from the live catalogue.
🔴 2. `client_actions` (assigned per client): reference to a catalogue lever (or a bespoke
   client action), `status` (planned / in-progress / complete), `owner`, `target_date`,
   `progress_pct`, `notes`, versioned + audited; deactivate-not-delete. **Qualitative only
   (A2-lite)** — no modelled tCO₂e yet (Stage 2, see below).

## UI (match v12)
🟢 3. Actions area = the client's plan, grouped by **sphere of influence**, with a **lever
   summary** (counts: total / in-progress / complete / planned) and per-action status pill +
   progress bar + scope tag + owner + target date. Editing via a drawer; gated on
   `actions.manage`.
🟢 4. "**Add from library**" drawer: the catalogue, filterable by scope / sphere, each item
   Add / Added; assigning creates a `client_actions` row. Removing deactivates (kept in
   history). Bespoke (non-catalogue) actions can also be added.
🟡 5. `action-lever-summary` read model feeding the summary strip and (later) the report's
   Plan section.

## Stage 2 (design for it, don't build)
- **Quantified lever impact**: each lever's modelled tCO₂e reduction and a projected
   pathway contribution. Leave room in `action_levers` / `client_actions` for a modelled
   impact without reshaping. The prototype and UI say "qualitative today" honestly.

## Acceptance (real data; build+typecheck green; on a PR)
- Admin catalogue of levers exists; a client's plan is assembled by assigning from it (+
   bespoke actions), grouped by sphere, with status/owner/target/progress.
- The lever summary counts are correct; two clients show different plans.
- Assigning/removing is permission-gated and audited; removal deactivates, never deletes.
- No fabricated impact numbers — quantified projection is clearly Stage 2.
