# Handoff brief — Reduction Strategies (supersedes the Action-lever library)

Renames and restructures the Actions area into **Reduction Strategies** (ISO 14060 alignment),
turns the flat catalogue into a **shared library of strategies allocated to levers**, aligns every
client strategy to an **SRS Readiness requirement**, adds an **include-in-report** flag, and adds
**deadline notifications**. This supersedes `docs/_handoff_ACTION_LEVER_LIBRARY_brief.md` and the
model shipped in migration `0075` — it restructures that, it doesn't sit beside it.

**Design reference:** `docs/prototypes/reduction_strategies_v1.html` — the plan grouped by lever,
each strategy with its control-level + scope + lever chips, SRS-alignment chip, owner, due-date
flag (due-soon / overdue) and include-in-report toggle; the shared-library drawer with lever +
control-level filters and the mandatory SRS-alignment picker grouped by pillar; and the
deadline-notifications banner (in-app · portal · email). **Lever sections are collapsible**
(per-group toggle + Open all / Collapse all), following the collapsible-cards convention in
DESIGN_CONVENTIONS §3.2 — keeps the workspace tidy when a client has many strategies.

**Decisions (confirmed by Francis 14 Sep 2026):**
1. Name is **"Reduction Strategies"** — NOT plain "Strategies", because "Strategy" is already an
   SRS pillar and one-term-one-meaning is locked. The SRS "Strategy" pillar is untouched.
2. **Levers are a categorization (M:N)** — a defined set of levers (themes); each strategy maps to
   one or more. Control level stays a **separate** single-value axis (direct control / supply
   chain / influence).
3. **Align against the built 48 SRS requirements** (not 24). Present them grouped by the 4 pillars
   so the picker still reads as "the four sections". (Users described 24 = 6×4 — that's the old
   live system; the redesign's 48 stands. Worth reconciling with users, but 48 is authoritative.)
4. **Notifications: in-app + portal highlights AND email reminders** to clients — reuse the
   training `*_automation_log` pattern.

Standard rules throughout: branch + PR; typecheck AND build green; **migrations via the new
runner + ledger** (no hand-applies); matrix changes are a **new matrix version**, never an edit;
theme-aware; print-safe `NziIcon`; dd/mm/yyyy; honest empty/degraded states; deactivate-not-delete;
every mutation permission-checked + audited.

---

## 1. Rename: Actions → Reduction Strategies  🔴
System-wide terminology + identifier rename (like `sphere_of_influence` → `control_level`, but
wider). Touches:
- **Capability** `actions.manage` → `strategy.manage`, as a **new permission-matrix version**
  (bump `PERMISSION_MATRIX_VERSION`, regenerate the matrix migration via the existing generator,
  update `PERMISSION_MATRIX.md`). Held by Admin + Consultant, same as `actions.manage` was.
- **Tables/enums/contracts/read models/commands/routes/UI/nav** — "Actions" → "Reduction
  Strategies" (nav label can be "Reduction Strategies"; entity is a *reduction strategy*).
- **Report** plan section (see §5) and **DESIGN_CONVENTIONS** (add the term; record that the
  `strategy` **domain** is distinct from the SRS `strategy` **pillar**).
- **Prototypes**: the Actions area in `client_workspace_v12.html` and the plan section in
  `report_v1.html`.
- Register an NZC decision recording the rename + the model change.

## 2. The library: levers (M:N) + strategies  🔴
Restructures `0075`'s flat `action_levers` catalogue into two concepts plus a join:
- **`levers`** — Admin-managed shared set of reduction levers (themes), e.g. energy, buildings,
  transport, procurement, process, waste. Fields: `key`, `title`, `icon`, `ordering`, `active`.
- **`reduction_strategies`** — the shared library (the renamed catalogue): `key`, `title`,
  `description`, **`control_level`** (kept, separate axis), `scope` (1/2/3/governance), `icon`,
  `active`. Admin-managed, versioned, deactivate-not-delete.
- **`strategy_levers`** — M:N join: each library strategy allocated to one or more levers.
- **`client_strategies`** (renamed `client_actions`): the per-client plan — references a library
  strategy **or** a bespoke client strategy; `status` (planned/in-progress/complete), `owner`,
  `target_date`, `progress_pct`, `notes`, **`include_in_report`** (§4), versioned + audited.
  Keeps the biconditional `((status='complete') = (progress_pct=100))` and reopen→in_progress.
- Clients **choose one or many** library strategies and **customise** their copy; the library
  wording is referenced (Admin correction propagates) unless the client has customised a field.
- **This library is shared reference data** → it MUST be provisioned per tenant the same way SRS
  is (see the seed-provisioning fix): levers + the strategy library are seeded on organisation
  creation and backfilled for existing orgs. **Coordinate with that PR** so the two don't collide
  — provision the *new* structure, not the old `action_levers`.

## 3. SRS alignment  🔴
- **`strategy_srs_requirements`** — links a strategy to SRS requirement(s), against the built 48.
  Library strategies carry a **default** alignment (the "pinnable against an SRS question" idea);
  a **`client_strategies`** row inherits it and **must carry ≥1 alignment** — mandatory: a client
  strategy cannot be committed without an SRS requirement aligned. (Users: "every action needs to
  be aligned.")
- The alignment picker presents the 48 **grouped by the 4 pillars** (governance / strategy / risk
  / metrics) so it reads as the four sections; S2 Climate leads.
- Purpose: the SRS Readiness view can surface, per gap, **which strategies address it** — so the
  readiness tool drives where the client focuses. Show the reverse too on the strategy: which SRS
  requirement(s) it advances.

## 4. Include in report  🟠
- Per `client_strategies` boolean **`include_in_report`** (default true; consultant can exclude).
- The report's plan section renders **only** included strategies.
- It must **freeze into the report composition at issue** (per the composition rule) — an issued
  report keeps the strategies-and-flags it was built with; later toggles don't rewrite it.

## 5. Report plan section  🟠
- The "Decarbonisation plan" section is driven by **Reduction Strategies**, grouped by **lever**
  (and/or control level), showing only `include_in_report` strategies, each with its SRS
  alignment. Resolves from the frozen composition, never live (measurement-vs-issue rule).
- Update `_handoff_REPORT_brief.md` §2 accordingly (it currently says "action-lever plan").

## 6. Notifications  🟡
- **Deadline/date notifications** for client strategies (approaching `target_date`, overdue).
  Three channels: **in-app** flags in the staff console, **portal** highlights for the client, and
  **email** reminders to the client. Reuse the training `*_automation_log` pattern (a
  `strategy_automation_log`, idempotent, records what was sent so nothing double-fires).
- A reminder window (e.g. N days before) + an overdue state; keep the cadence config simple and
  documented in DEPLOYMENT.md. Email respects the client's contact + consent (reuse existing
  portal/contact plumbing); honest states — never invent a date that isn't set.

## Sequencing (each carries migrations → stops for review; goes through the new runner)
1. **Rename + levers restructure** (§1–§2) — the load-bearing schema change; supersedes 0075.
2. **SRS alignment** (§3) + **include-in-report** (§4) + **report plan section** (§5).
3. **Notifications** (§6) — the largest new subsystem; can phase in-app/portal before email if
   needed, but email is in scope.

## Acceptance (real data; build+typecheck green; on a PR)
- Nothing in the app says "Actions"; capability is `strategy.manage` at a new matrix version.
- A library strategy maps to one or more levers; control level is its own axis; a client builds a
  plan by choosing + customising library strategies (+ bespoke), grouped by lever.
- A client strategy cannot be saved without ≥1 SRS requirement aligned; the SRS view shows which
  strategies address each gap.
- `include_in_report` controls the report plan section; an issued report is unaffected by later
  toggles (frozen in the composition).
- Upcoming/overdue strategies raise in-app + portal highlights and email reminders; nothing
  double-sends; a strategy with no date raises nothing (no invented date).
- New tenants get the levers + strategy library (and SRS framework) by provisioning, not a
  one-time seed.
