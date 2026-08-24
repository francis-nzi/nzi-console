# NZI Console — project brief for Claude Code

You are working on **NZI Console**, the redesigned front-end for the NZI Pro (*NZ Insights Pro*) carbon
platform. Read this first, then the `docs/` set below before making changes.

## What this is (and is not)

- A **redesign of the NZI Pro front-end**, built as a **separate, isolated, additive** environment. It does
  **not** touch the live `nzi_pro_v7-POSTGRES` platform, its production database, or the FuelCap services.
- **Design-first on mock data.** First iteration runs entirely on `@nzi/mock-data` — no backend, no
  database, no production anything. `NEXT_PUBLIC_APP_ENV=staging` is the authoritative "not production" flag.
- Deployed as an isolated Render service (`nzi-console`, `srv-d6o8snvgi27c73frfta0`), auto-deploy on push to
  `main`, live at https://nzi-pro-api-prod.onrender.com (misleadingly named — it is the staging redesign UI,
  not a production API; see `docs/DEPLOYMENT.md`).

## Required reading (in `docs/`)

1. **`WORKFLOWS.md`** — ground-truth deep-dive of the *live* NZI Pro CRM's actual workflows (identity/tenancy,
   clients, the CRP job spine, emissions engine, reporting, review/portal, commercial, CRM, BD→Sales V2, LCA,
   training). Tagged [LIVE] / [PARTIAL] / [PROPOSED]. This is what the redesign must carry forward.
2. **`ARCHITECTURE.md`** — the target architecture: principles, IA/workspaces, domain model, the evidence/
   provenance signature, **§6 job-family modularization + shared numbering**, **§7 visualization subsystem**,
   the isolated-backend plan, and delivery phases.
3. **`DECISIONS.md`** — the decision register (`NZC-###`). Confirmed decisions are load-bearing; **Open** ones
   need Francis before the relevant phase.
4. **`GRAPHICS_PIPELINE.md`** — why the live graphics pipeline breaks and the single SVG-first subsystem that
   replaces it. `@nzi/charts` is the first piece of this.

## Repo shape

```
apps/console/        Next.js (App Router, TS) — the redesigned UI
  app/               / (Control Room) · /clients · /jobs · /charts (chart library)
  app/lib/nav.ts     workspace nav
packages/ui/         design system — AppShell, WorkspaceRail, TopBar, EvidenceDrawer, tokens (styles.css)
packages/mock-data/  illustrative data only — NO PII, NO real client data
packages/charts/     @nzi/charts — SVG-first chart engine (EmissionsScopeDonut, ReductionPathway)
docs/                the four design docs above + DEPLOYMENT, FIRST_GATE
```

npm workspaces + Turborepo. Node 20.18.0.

## Conventions (locked — see DECISIONS.md)

- **Type:** Inter throughout. **Palette:** Emerald `#0BA75E`, Deep Pine `#0B7A4B`, Midnight `#0B1B2B`,
  Signal Amber `#FFC24B`, Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`. Scope identity is brand-locked:
  Scope 1 coral, Scope 2 amber, Scope 3 emerald — categorical, fixed order, never recoloured by rank.
- **Shell:** left Workspace Rail · top command/search bar · main · right Evidence Drawer (provenance +
  calculation lineage). Evidence-drawer-first: no number appears without its lineage one click away.
- **Charts:** one SVG spec renders identically to screen, PDF and portal. Charts are **derived from data,
  never captured**; brand tokens are the single styling source (explicit hex in `@nzi/charts/tokens.ts` for
  print determinism). Run the dataviz palette validator before adding categorical colours.
- **Data quality tiers** (Measured / Estimated / Spend-based / Survey) and **provenance** (factor set +
  version + data hash + as-at date) travel with every measurement and every chart.
- Workspace packages ship raw `.tsx`/`.ts` via `exports` and are listed in the console's
  `transpilePackages` (`@nzi/ui`, `@nzi/mock-data`, `@nzi/charts`).

## Principles to uphold (from the live platform's failure modes)

Truth before apparent availability (distinct empty/loading/degraded/failed/success — never a failed query as
zero) · one term one meaning · reuse canonical Client/Quote/Job/Report services (don't re-implement their
SQL) · migration-owned schema, **no request-time DDL** · atomic + idempotent commands · tenant safety by
construction · AI grounded & advisory only · isolation (never production creds/data in this repo/service).

## Dev commands

```bash
npm install                 # links workspace packages
npm run dev                 # http://localhost:3000  (@nzi/console)
npm run build -w @nzi/console
npm run typecheck           # tsc --noEmit across workspaces
```
Health check: `/api/health` → `{"status":"ok","app":"nzi-console","env":"staging"}`.

## Current state (24 Aug 2026)

Control Room, Clients, Jobs (CRP scope-row workspace with evidence drawer), and the **Emissions → /charts**
library are live on mock data. `@nzi/charts` renders the CRP scope donut + reduction pathway server-side
(proven in the Render build). Deployed and green.

## Recommended next step

**Job-family modularization + the shared numbering service (ARCHITECTURE §6; NZC-024, NZC-025).** This is the
larger of the two explicit redesign requirements and is foundational — per-family workflows, page designs and
report manifests all sit on it. Suggested first increment:

1. Shared **job header** model + `job_family` (`crp` | `consultancy` | `lca` | `pcf` | `training`) in
   `@nzi/mock-data`, plus per-family detail shapes.
2. A single **job-numbering service** — one global counter using the established official format
   (`J000612`, `J000613`…), **gapless** via assign-on-commit (decided, NZC-025). Store the bare integer and
   family code separately; render the zero-padded `J` number and show family as a badge/label. Cover with
   a concurrency test.
3. A **family-aware job-creation flow** and per-family job workspace shells over the shared spine, all in the
   same app shell, reusing `@nzi/ui` and `@nzi/charts`.

Then: content-addressed cache + manifest validation gate for `@nzi/charts` (NZC-027/028), and the LCA/PCF +
Training chart catalogues.

**Open decisions needing Francis** (see DECISIONS.md): NZC-008 canonical scope-row model · NZC-020 isolated-
backend data strategy · NZC-021 reporting reuse-vs-rebuild · NZC-022 permission matrix.
